"""
separate.py - pull the lead vocal out of a full mix before transcription.

The recogniser and especially the word aligner are far more accurate on a
clean vocal than on a vocal fighting a beat. BS-RoFormer (ViperX, SDR 12.97)
is the default in python-audio-separator and one of the strongest open vocal
models; the file name is configurable in config.json.
"""

from __future__ import annotations

import gc
import logging
import shutil
from pathlib import Path

log = logging.getLogger("studio.separate")

ROOT = Path(__file__).resolve().parent.parent
MODEL_DIR = ROOT / "models" / "separator"

DEFAULT_MODEL = "model_bs_roformer_ep_317_sdr_12.9755.ckpt"


def available() -> tuple[bool, str]:
    import importlib.util
    if importlib.util.find_spec("audio_separator") is None:
        return False, "audio-separator is not installed in this environment"
    return True, ""


def model_cached(model_filename: str = DEFAULT_MODEL) -> bool:
    return (MODEL_DIR / model_filename).is_file()


def isolate_vocals(src_wav: Path, out_dir: Path, model_filename: str = DEFAULT_MODEL) -> Path:
    """Write <out_dir>/vocals.wav and return its path."""
    from audio_separator.separator import Separator

    MODEL_DIR.mkdir(parents=True, exist_ok=True)
    out_dir.mkdir(parents=True, exist_ok=True)
    tmp = out_dir / "_sep"
    tmp.mkdir(exist_ok=True)

    use_autocast = False
    try:
        import torch
        use_autocast = bool(torch.cuda.is_available())
    except Exception:  # noqa: BLE001
        pass

    sep = Separator(
        log_level=logging.WARNING,
        model_file_dir=str(MODEL_DIR),
        output_dir=str(tmp),
        output_format="WAV",
        output_single_stem="Vocals",
        use_autocast=use_autocast,
    )
    try:
        sep.load_model(model_filename=model_filename)
        files = sep.separate(str(src_wav), custom_output_names={"Vocals": "vocals"})
    finally:
        del sep
        gc.collect()
        try:
            import torch
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
        except Exception:  # noqa: BLE001
            pass

    produced = [Path(f) if Path(f).is_absolute() else tmp / f for f in (files or [])]
    produced = [p for p in produced if p.is_file()]
    if not produced:
        produced = sorted(tmp.glob("*.wav"))
    vocal = next((p for p in produced if "vocal" in p.name.lower()), produced[0] if produced else None)
    if vocal is None:
        raise RuntimeError("vocal separation produced no output")
    dst = out_dir / "vocals.wav"
    if dst.exists():
        dst.unlink()
    shutil.move(str(vocal), dst)
    shutil.rmtree(tmp, ignore_errors=True)
    return dst
