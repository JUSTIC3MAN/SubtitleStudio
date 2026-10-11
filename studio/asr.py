"""
asr.py - speech recognition and word alignment.

Primary engine: Qwen3-ASR-1.7B (Alibaba Qwen, Apache-2.0, Jan 2026) for the
words, Qwen3-ForcedAligner-0.6B for where each word sits in time. On Qwen's
published singing benchmarks the 1.7B model roughly halves Whisper-large-v3's
error rate, and the aligner's average timing error is ~30-50 ms against ~130 ms
for WhisperX.

Fallback engine: faster-whisper large-v3-turbo (the one RapSubtitles uses),
in case the Qwen stack cannot load on a machine.

All model files live under SubtitleStudio/models so the whole thing is
self-contained and can be deleted in one go.
"""

from __future__ import annotations

import gc
import logging
import os
import threading
import time
from pathlib import Path
from typing import Callable

import numpy as np

from .lines import Word, words_from_alignment, fix_times

log = logging.getLogger("studio.asr")

ROOT = Path(__file__).resolve().parent.parent
MODELS = ROOT / "models"
os.environ.setdefault("HF_HOME", str(MODELS / "hf"))
os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")

SR = 16000

ENGINES = {
    "qwen3-1.7b": dict(label="Qwen3-ASR 1.7B  -  best accuracy, songs & rap", repo="Qwen/Qwen3-ASR-1.7B", gb=4.7),
    "qwen3-0.6b": dict(label="Qwen3-ASR 0.6B  -  faster, a little less accurate", repo="Qwen/Qwen3-ASR-0.6B", gb=1.9),
    "whisper-turbo": dict(label="Whisper large-v3-turbo  -  fallback", repo="large-v3-turbo", gb=1.6),
}
ALIGNER_REPO = "Qwen/Qwen3-ForcedAligner-0.6B"
ALIGNER_GB = 1.8

LANGUAGES = [
    "English", "Spanish", "Portuguese", "French", "Italian", "German", "Dutch", "Japanese",
    "Korean", "Chinese", "Cantonese", "Russian", "Arabic", "Hindi", "Turkish", "Indonesian",
    "Vietnamese", "Thai", "Malay", "Filipino", "Polish", "Czech", "Swedish", "Danish", "Finnish",
    "Greek", "Romanian", "Hungarian", "Persian", "Macedonian",
]
ALIGNER_LANGS = {"Chinese", "English", "Cantonese", "French", "German", "Italian",
                 "Japanese", "Korean", "Portuguese", "Russian", "Spanish"}
WHISPER_CODE = {
    "English": "en", "Spanish": "es", "Portuguese": "pt", "French": "fr", "Italian": "it",
    "German": "de", "Dutch": "nl", "Japanese": "ja", "Korean": "ko", "Chinese": "zh",
    "Cantonese": "yue", "Russian": "ru", "Arabic": "ar", "Hindi": "hi", "Turkish": "tr",
    "Indonesian": "id", "Vietnamese": "vi", "Thai": "th", "Malay": "ms", "Filipino": "tl",
    "Polish": "pl", "Czech": "cs", "Swedish": "sv", "Danish": "da", "Finnish": "fi",
    "Greek": "el", "Romanian": "ro", "Hungarian": "hu", "Persian": "fa", "Macedonian": "mk",
}
WHISPER_NAME = {v: k for k, v in WHISPER_CODE.items()}

Report = Callable[[float, str], None]   # (fraction 0..1, message)


def _noop(_f: float, _m: str) -> None:
    pass


# ------------------------------------------------------------- devices ---

_TORCH_INFO: dict | None = None


def torch_info() -> dict:
    """Import torch once and describe the GPU. Imports torch first so CUDA DLLs
    (cuBLAS/cuDNN) are on the process before ctranslate2 asks for them."""
    global _TORCH_INFO
    if _TORCH_INFO is not None:
        return _TORCH_INFO
    info = {"torch": None, "cuda": False, "gpu": None, "vram_gb": None, "error": None}
    try:
        import torch
        info["torch"] = torch.__version__
        if os.name == "nt":
            lib = Path(torch.__file__).parent / "lib"
            if lib.is_dir():
                try:
                    os.add_dll_directory(str(lib))
                except (OSError, AttributeError):
                    pass
        if torch.cuda.is_available():
            info["cuda"] = True
            info["gpu"] = torch.cuda.get_device_name(0)
            info["vram_gb"] = round(torch.cuda.get_device_properties(0).total_memory / 2**30, 1)
    except Exception as e:  # noqa: BLE001
        info["error"] = f"{type(e).__name__}: {e}"
    _TORCH_INFO = info
    return info


def _device_dtype():
    import torch
    if torch.cuda.is_available():
        bf16 = torch.cuda.is_bf16_supported()
        return "cuda:0", (torch.bfloat16 if bf16 else torch.float16)
    return "cpu", torch.float32


def free_gpu() -> None:
    gc.collect()
    try:
        import torch
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except Exception:  # noqa: BLE001
        pass


# ------------------------------------------------------ model downloads ---

def ensure_hf_model(repo_id: str, report: Report = _noop, label: str = "", approx_gb: float = 0) -> str:
    """
    Make sure a Hugging Face repo is fully downloaded and return its local folder.
    Shows real progress while downloading by watching the cache grow. Works
    offline once the files are there.
    """
    from huggingface_hub import snapshot_download
    try:
        from huggingface_hub import constants
        cache_root = Path(constants.HF_HUB_CACHE)
    except Exception:  # noqa: BLE001
        cache_root = Path(os.environ["HF_HOME"]) / "hub"
    repo_dir = cache_root / ("models--" + repo_id.replace("/", "--"))

    def cached_bytes() -> int:
        # real files only: with symlinks the snapshot entries point into blobs,
        # without them (Windows, no developer mode) the snapshot holds the copies
        total = 0
        if repo_dir.is_dir():
            for f in repo_dir.rglob("*"):
                try:
                    if f.is_file() and not f.is_symlink():
                        total += f.stat().st_size
                except OSError:
                    pass
        return total

    expected = 0
    try:
        from huggingface_hub import HfApi
        info = HfApi().model_info(repo_id, files_metadata=True)
        expected = sum((s.size or 0) for s in (info.siblings or []))
    except Exception:  # noqa: BLE001 - offline, or the hub is down
        expected = int(approx_gb * 2**30)

    already = cached_bytes()
    first_time = expected and already < expected * 0.98
    name = label or repo_id
    if first_time:
        report(0.0, f"Downloading {name} (first time only, ~{expected / 2**30:.1f} GB)...")

    result: dict = {}

    def work():
        try:
            result["path"] = snapshot_download(repo_id)
        except Exception as e:  # noqa: BLE001
            result["error"] = e

    th = threading.Thread(target=work, daemon=True)
    th.start()
    while th.is_alive():
        th.join(1.0)
        if first_time and expected:
            got = cached_bytes()
            report(min(0.99, got / expected),
                   f"Downloading {name}: {got / 2**30:.2f} / {expected / 2**30:.1f} GB (first time only)")
    if "error" in result:
        try:   # offline but complete in cache?
            return snapshot_download(repo_id, local_files_only=True)
        except Exception:  # noqa: BLE001
            raise RuntimeError(f"Could not download {name}: {result['error']}") from result["error"]
    return result["path"]


def model_cached(repo_id: str) -> bool:
    try:
        from huggingface_hub import constants
        repo_dir = Path(constants.HF_HUB_CACHE) / ("models--" + repo_id.replace("/", "--"))
    except Exception:  # noqa: BLE001
        repo_dir = Path(os.environ["HF_HOME"]) / "hub" / ("models--" + repo_id.replace("/", "--"))
    snaps = repo_dir / "snapshots"
    return snaps.is_dir() and any(snaps.iterdir()) and not any((repo_dir / "blobs").glob("*.incomplete"))


# ------------------------------------------------------------ chunking ---

def split_chunks(wav: np.ndarray, max_sec: float = 100.0, expand: float = 12.0) -> list[tuple[float, float]]:
    """
    Cut long audio into pieces of about `max_sec` at the quietest point near each
    cut, so a cut lands between words. Returns (start, end) in seconds; the
    pieces tile the audio exactly.
    """
    n = wav.size
    if n == 0:
        return []
    max_len, ex = int(max_sec * SR), int(expand * SR)
    win = int(0.35 * SR)          # look for a real breath, not a gap between syllables
    bounds = [0]
    start = 0
    while n - start > max_len + ex // 2:
        cut = start + max_len
        lo, hi = max(start + SR * 5, cut - ex), min(n, cut + ex)
        seg = np.abs(wav[lo:hi])
        if seg.size > win:
            sums = np.convolve(seg, np.ones(win, dtype=np.float32), mode="valid")
            b = lo + int(np.argmin(sums)) + win // 2
        else:
            b = cut
        bounds.append(b)
        start = b
    bounds.append(n)
    return [(bounds[i] / SR, bounds[i + 1] / SR) for i in range(len(bounds) - 1)]


def voice_floor(wav: np.ndarray) -> float:
    """Level below which a stretch counts as silence: 32 dB under the take's loud
    parts, so quiet recordings and hot masters are judged the same way."""
    hop = SR // 20
    k = wav.size // hop
    if k < 4:
        return -60.0
    rms = np.sqrt(np.mean(wav[:k * hop].reshape(k, hop).astype(np.float64) ** 2, axis=1))
    db = 20 * np.log10(np.maximum(rms, 1e-7))
    return float(np.clip(np.percentile(db, 95) - 32, -62, -38))


def is_active(seg: np.ndarray, floor_db: float = -45.0) -> bool:
    """Does this stretch contain any voice at all? (Skips instrumental gaps.)"""
    if seg.size < SR // 4:
        return False
    hop = SR // 20
    k = seg.size // hop
    if k == 0:
        return False
    rms = np.sqrt(np.mean(seg[:k * hop].reshape(k, hop).astype(np.float64) ** 2, axis=1))
    loud = 20 * np.log10(np.maximum(rms, 1e-7))
    return int((loud > floor_db).sum()) >= 4          # at least ~0.2 s above the floor


# --------------------------------------------------------------- aligner ---

class Aligner:
    """Qwen3-ForcedAligner: text + audio in, a start/end for every word out."""

    def __init__(self):
        self.model = None
        self.error: str | None = None
        self.lock = threading.Lock()

    def load(self, report: Report = _noop) -> None:
        if self.model is not None:
            return
        torch_info()
        from qwen_asr import Qwen3ForcedAligner
        path = ensure_hf_model(ALIGNER_REPO, report, "the word aligner", ALIGNER_GB)
        report(0.0, "Loading the word aligner...")
        dev, dtype = _device_dtype()
        self.model = Qwen3ForcedAligner.from_pretrained(path, dtype=dtype, device_map=dev)

    def align(self, pieces: list[tuple[np.ndarray, str, str]], offsets: list[float],
              report: Report = _noop, batch: int = 4) -> list[list[Word]]:
        """pieces: (mono16k, text, language). Returns words per piece, in absolute time."""
        out: list[list[Word]] = []
        with self.lock:
            for i in range(0, len(pieces), batch):
                grp = pieces[i:i + batch]
                langs = [lang if lang in ALIGNER_LANGS else "English" for _, _, lang in grp]
                res = self.model.align(audio=[(w, SR) for w, _, _ in grp],
                                       text=[t for _, t, _ in grp], language=langs)
                for (w, text, _), r, off in zip(grp, res, offsets[i:i + batch]):
                    items = [(it.text, it.start_time + off, it.end_time + off) for it in r.items]
                    out.append(words_from_alignment(text, items))
                report(min(1.0, (i + len(grp)) / max(1, len(pieces))), "")
        return out


# ---------------------------------------------------------------- engines ---

class QwenEngine:
    def __init__(self, key: str = "qwen3-1.7b"):
        self.key = key
        self.repo = ENGINES[key]["repo"]
        self.model = None

    def load(self, report: Report = _noop) -> None:
        if self.model is not None:
            return
        torch_info()
        from qwen_asr import Qwen3ASRModel
        path = ensure_hf_model(self.repo, report, self.repo.split("/")[-1], ENGINES[self.key]["gb"])
        report(0.0, f"Loading {self.repo.split('/')[-1]} onto the GPU...")
        dev, dtype = _device_dtype()
        self.model = Qwen3ASRModel.from_pretrained(
            path, dtype=dtype, device_map=dev,
            max_inference_batch_size=4, max_new_tokens=2048,
        )

    def transcribe(self, wav: np.ndarray, chunks: list[tuple[float, float]], language: str | None,
                   context: str, report: Report = _noop) -> list[dict]:
        """Returns one dict per voiced chunk: {start, end, lang, text}."""
        floor = voice_floor(wav)
        todo = []
        for s, e in chunks:
            seg = wav[int(s * SR):int(e * SR)]
            if is_active(seg, floor):
                todo.append((s, e, seg))
        out = []
        step = 4
        for i in range(0, len(todo), step):
            grp = todo[i:i + step]
            res = self.model.transcribe(audio=[(seg, SR) for _, _, seg in grp],
                                        language=language or None, context=context or "")
            for (s, e, _), r in zip(grp, res):
                text = (r.text or "").strip()
                if text:
                    out.append({"start": s, "end": e, "lang": r.language or (language or "English"), "text": text})
            report((i + len(grp)) / max(1, len(todo)), "")
        return out


class WhisperEngine:
    def __init__(self):
        self.model = None

    def load(self, report: Report = _noop) -> None:
        if self.model is not None:
            return
        ti = torch_info()
        from faster_whisper import WhisperModel
        report(0.0, "Loading Whisper large-v3-turbo (downloads ~1.6 GB the first time)...")
        if ti.get("cuda"):
            self.model = WhisperModel("large-v3-turbo", device="cuda", compute_type="float16",
                                      download_root=str(MODELS / "whisper"))
        else:
            self.model = WhisperModel("large-v3-turbo", device="cpu", compute_type="int8",
                                      download_root=str(MODELS / "whisper"))

    def transcribe_words(self, wav: np.ndarray, language: str | None, context: str,
                         report: Report = _noop) -> tuple[list[Word], str]:
        code = WHISPER_CODE.get(language or "", None)
        segments, info = self.model.transcribe(
            wav, language=code, word_timestamps=True, beam_size=5,
            condition_on_previous_text=False, vad_filter=True,
            initial_prompt=(context[:600] or None) if context else None,
        )
        total = max(1e-3, wav.size / SR)
        words: list[Word] = []
        for seg in segments:
            for w in seg.words or []:
                t = (w.word or "").strip()
                if t:
                    words.append(Word(t, float(w.start), float(w.end)))
            report(min(1.0, seg.end / total), "")
        lang = WHISPER_NAME.get(getattr(info, "language", "") or "", language or "English")
        return fix_times(words), lang


# ---------------------------------------------------------------- facade ---

class ASR:
    """Holds whichever models are loaded, so the second song starts instantly."""

    def __init__(self):
        self.engines: dict[str, object] = {}
        self.aligner = Aligner()
        self.lock = threading.RLock()

    def engine(self, key: str):
        with self.lock:
            if key not in self.engines:
                # keep at most one recogniser in VRAM
                for k in list(self.engines):
                    del self.engines[k]
                free_gpu()
                self.engines[key] = WhisperEngine() if key == "whisper-turbo" else QwenEngine(key)
            return self.engines[key]

    def recognise(self, wav: np.ndarray, key: str, language: str | None, context: str,
                  report: Report = _noop) -> tuple[list[Word], list[tuple[float, float]], str, str]:
        """
        Words with timings for a whole take.
        Returns (words, chunks, language, engine_used).
        """
        chunks = split_chunks(wav)
        t0 = time.time()
        if key.startswith("qwen3"):
            try:
                eng = self.engine(key)
                eng.load(lambda f, m: report(0.05 + 0.1 * f, m))
                report(0.15, "Transcribing...")
                parts = eng.transcribe(wav, chunks, language, context,
                                       lambda f, m: report(0.15 + 0.5 * f, m or "Transcribing..."))
                report(0.65, "Placing every word in time...")
                self.aligner.load(lambda f, m: report(0.65, m))
                pieces = [(wav[int(p["start"] * SR):int(p["end"] * SR)], p["text"], p["lang"]) for p in parts]
                aligned = self.aligner.align(pieces, [p["start"] for p in parts],
                                             lambda f, m: report(0.65 + 0.3 * f, "Placing every word in time..."))
                words = [w for ws in aligned for w in ws]
                langs = [p["lang"] for p in parts if p.get("lang")]
                lang = max(set(langs), key=langs.count) if langs else (language or "English")
                log.info("qwen: %d words in %.1fs", len(words), time.time() - t0)
                return fix_times(words), chunks, lang, key
            except Exception as e:  # noqa: BLE001
                log.exception("Qwen3 engine failed, falling back to Whisper")
                report(0.1, f"Qwen3-ASR could not run ({type(e).__name__}: {e}). Falling back to Whisper...")
                key = "whisper-turbo"
        eng = self.engine("whisper-turbo")
        eng.load(lambda f, m: report(0.1, m))
        report(0.15, "Transcribing with Whisper...")
        words, lang = eng.transcribe_words(wav, language, context,
                                           lambda f, m: report(0.15 + 0.8 * f, "Transcribing with Whisper..."))
        return words, chunks, lang, "whisper-turbo"

    def can_align(self) -> bool:
        if self.aligner.model is not None:
            return True
        try:
            import qwen_asr  # noqa: F401
            return True
        except Exception:  # noqa: BLE001
            return False

    def align(self, pieces: list[tuple[np.ndarray, str, str]], offsets: list[float],
              report: Report = _noop) -> list[list[Word]]:
        self.aligner.load(report)
        return self.aligner.align(pieces, offsets, report)
