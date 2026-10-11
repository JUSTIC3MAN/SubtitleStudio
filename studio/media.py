"""
media.py - everything that touches ffmpeg / ffprobe.

Probing an upload, deciding whether the browser can play it as-is, making a
light preview proxy when it can't, pulling audio out, and drawing the waveform
the timeline shows.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from fractions import Fraction
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
BIN_DIR = ROOT / "bin"

NO_WINDOW = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0


def _find(name: str) -> str | None:
    exe = shutil.which(name)
    if exe:
        return exe
    names = [name + ".exe", name]
    candidates = [BIN_DIR / n for n in names]
    candidates += [
        Path(r"C:\ffmpeg\bin") / (name + ".exe"),
        Path(r"C:\Program Files\ffmpeg\bin") / (name + ".exe"),
        Path(os.path.expandvars(r"%LOCALAPPDATA%\Microsoft\WinGet\Links")) / (name + ".exe"),
        Path("/usr/bin") / name, Path("/usr/local/bin") / name, Path("/opt/homebrew/bin") / name,
    ]
    # winget installs Gyan.FFmpeg into a versioned folder; find it if Links is missing
    pkg_root = Path(os.path.expandvars(r"%LOCALAPPDATA%\Microsoft\WinGet\Packages"))
    try:
        if pkg_root.is_dir():
            for d in pkg_root.glob("Gyan.FFmpeg*"):
                candidates += list(d.glob(f"*/bin/{name}.exe"))
    except OSError:
        pass
    for c in candidates:
        try:
            if c.is_file():
                return str(c)
        except OSError:
            pass
    return None


FFMPEG = _find("ffmpeg")
FFPROBE = _find("ffprobe")


def run(cmd: list[str], timeout: float | None = None, check: bool = True) -> subprocess.CompletedProcess:
    p = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                       timeout=timeout, creationflags=NO_WINDOW)
    if check and p.returncode != 0:
        tail = p.stderr.decode("utf-8", "replace").strip().splitlines()[-12:]
        raise RuntimeError("ffmpeg failed:\n" + "\n".join(tail))
    return p


# ------------------------------------------------------------------ probe ---

def _fps(s: str | None) -> float:
    try:
        f = float(Fraction(s))
        return f if 0 < f < 1000 else 0.0
    except Exception:  # noqa: BLE001
        return 0.0


def probe(path: str | Path) -> dict:
    """Duration, streams, display size (rotation applied) and frame rate."""
    if not FFPROBE:
        raise RuntimeError("ffprobe not found - install ffmpeg (winget install Gyan.FFmpeg)")
    p = run([FFPROBE, "-v", "error", "-print_format", "json",
             "-show_format", "-show_streams", str(path)], timeout=60)
    data = json.loads(p.stdout.decode("utf-8", "replace") or "{}")
    streams = data.get("streams", [])
    fmt = data.get("format", {})

    v = next((s for s in streams if s.get("codec_type") == "video"
              and not (s.get("disposition") or {}).get("attached_pic")), None)
    a = next((s for s in streams if s.get("codec_type") == "audio"), None)

    info = {
        "duration": float(fmt.get("duration") or 0) or None,
        "format": fmt.get("format_name", ""),
        "has_video": v is not None,
        "has_audio": a is not None,
    }
    if a is not None:
        info.update(acodec=a.get("codec_name"), sample_rate=int(a.get("sample_rate") or 0),
                    channels=int(a.get("channels") or 0))
        if not info["duration"]:
            info["duration"] = float(a.get("duration") or 0) or None
    if v is not None:
        w, h = int(v.get("width") or 0), int(v.get("height") or 0)
        rot = 0
        for sd in v.get("side_data_list") or []:
            if "rotation" in sd:
                try:
                    rot = int(round(float(sd["rotation"])))
                except (TypeError, ValueError):
                    pass
        tag_rot = (v.get("tags") or {}).get("rotate")
        if tag_rot and not rot:
            try:
                rot = int(tag_rot)
            except ValueError:
                pass
        if abs(rot) % 180 == 90:
            w, h = h, w
        # non-square pixels: report the display size
        sar = v.get("sample_aspect_ratio") or "1:1"
        try:
            num, den = (int(x) for x in sar.split(":"))
            if num > 0 and den > 0 and num != den:
                w = int(round(w * num / den / 2)) * 2
        except ValueError:
            pass
        fps = _fps(v.get("avg_frame_rate")) or _fps(v.get("r_frame_rate")) or 30.0
        info.update(vcodec=v.get("codec_name"), width=w, height=h, rotation=rot,
                    fps=round(fps, 3), pix_fmt=v.get("pix_fmt"))
        if not info["duration"]:
            info["duration"] = float(v.get("duration") or 0) or None
    return info


BROWSER_VCODECS = {"h264", "vp8", "vp9", "av1"}
BROWSER_ACODECS = {"aac", "mp3", "opus", "vorbis", "flac"}
BROWSER_CONTAINERS = {".mp4", ".m4v", ".mov", ".webm"}
BROWSER_AUDIO_EXT = {".mp3", ".wav", ".m4a", ".aac", ".ogg", ".oga", ".opus", ".flac", ".webm"}


def browser_playable(path: str | Path, info: dict) -> bool:
    ext = Path(path).suffix.lower()
    if info.get("has_video"):
        if ext not in BROWSER_CONTAINERS:
            return False
        if info.get("vcodec") not in BROWSER_VCODECS:
            return False
        if (info.get("pix_fmt") or "").startswith(("yuv422", "yuv444")) or "10" in (info.get("pix_fmt") or ""):
            return False
        if info.get("has_audio") and info.get("acodec") not in BROWSER_ACODECS:
            return False
        return True
    if ext in BROWSER_AUDIO_EXT:
        return info.get("acodec") in BROWSER_ACODECS | {"pcm_s16le", "pcm_s24le", "pcm_f32le", "pcm_u8"}
    return False


# -------------------------------------------------------------- encoders ---

_NVENC: bool | None = None


def has_nvenc() -> bool:
    """True when this ffmpeg can actually open h264_nvenc on this machine."""
    global _NVENC
    if _NVENC is not None:
        return _NVENC
    if not FFMPEG:
        _NVENC = False
        return False
    try:
        p = run([FFMPEG, "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i",
                 "color=c=black:s=256x256:d=0.2", "-c:v", "h264_nvenc", "-f", "null", "-"],
                timeout=30, check=False)
        _NVENC = p.returncode == 0
    except Exception:  # noqa: BLE001
        _NVENC = False
    return _NVENC


def h264_args(quality: str = "high") -> list[str]:
    """Video encoder arguments: NVENC on an RTX card, x264 otherwise."""
    cq = {"draft": 26, "high": 18, "max": 14}.get(quality, 18)
    if has_nvenc():
        return ["-c:v", "h264_nvenc", "-preset", "p6", "-tune", "hq", "-rc", "vbr",
                "-cq", str(cq), "-b:v", "0", "-maxrate", "80M", "-bufsize", "160M",
                "-profile:v", "high", "-pix_fmt", "yuv420p"]
    crf = {"draft": 24, "high": 17, "max": 13}.get(quality, 17)
    return ["-c:v", "libx264", "-preset", "medium" if quality != "max" else "slow",
            "-crf", str(crf), "-profile:v", "high", "-pix_fmt", "yuv420p"]


# ---------------------------------------------------------------- proxy ---

def make_proxy(src: str | Path, dst: str | Path, info: dict) -> None:
    """A browser-friendly copy for the preview player. Export always uses the original."""
    if info.get("has_video"):
        h = int(info.get("height") or 720)
        vf = "scale=-2:720" if h > 720 else "scale=trunc(iw/2)*2:trunc(ih/2)*2"
        enc = (["-c:v", "h264_nvenc", "-preset", "p4", "-cq", "24", "-pix_fmt", "yuv420p"]
               if has_nvenc() else ["-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p"])
        cmd = [FFMPEG, "-y", "-i", str(src), "-map", "0:v:0", "-map", "0:a:0?", "-vf", vf, *enc,
               "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", str(dst)]
    else:
        cmd = [FFMPEG, "-y", "-i", str(src), "-vn", "-c:a", "aac", "-b:a", "256k", str(dst)]
    run(cmd)


# ---------------------------------------------------------------- audio ---

def extract_wav(src: str | Path, dst: str | Path, sr: int = 44100, channels: int = 2) -> None:
    run([FFMPEG, "-y", "-i", str(src), "-vn", "-map", "0:a:0", "-ac", str(channels), "-ar", str(sr),
         "-c:a", "pcm_s16le", str(dst)])


def load_mono(src: str | Path, sr: int = 16000) -> np.ndarray:
    """Decode any audio/video file to mono float32 at `sr` through ffmpeg."""
    p = run([FFMPEG, "-v", "error", "-i", str(src), "-vn", "-map", "0:a:0", "-ac", "1", "-ar", str(sr),
             "-f", "f32le", "-"], timeout=None)
    return np.frombuffer(p.stdout, dtype=np.float32).copy()


def waveform_peaks(mono: np.ndarray, sr: int, per_second: int = 100) -> list[int]:
    """Peak envelope 0..255, `per_second` buckets per second, for the timeline."""
    if mono.size == 0:
        return []
    hop = max(1, sr // per_second)
    n = int(np.ceil(mono.size / hop))
    pad = n * hop - mono.size
    x = np.abs(np.pad(mono, (0, pad))).reshape(n, hop)
    peaks = x.max(axis=1)
    ref = float(np.percentile(peaks, 99.5)) or 1.0
    # gentle compression so quiet passages are still visible
    v = np.clip(peaks / ref, 0, 1) ** 0.7
    return (v * 255).astype(np.uint8).tolist()


def media_kind(info: dict) -> str:
    return "video" if info.get("has_video") else "audio"


def platform() -> str:
    return sys.platform
