"""
project.py - one folder per upload under SubtitleStudio/projects.

  projects/<id>/
      project.json     name, media info, transcript, style, export settings
      media.<ext>      the original upload (export always uses this)
      preview.mp4/m4a  browser-friendly proxy, only when the original isn't
      vocals.wav       isolated vocal (when separation ran)
      audio16k.npy     mono 16 kHz analysis audio (vocal if separated)
      peaks.json       waveform for the timeline
      background.*     optional still for audio-only exports
"""

from __future__ import annotations

import json
import re
import shutil
import threading
import time
import uuid
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
PROJECTS = ROOT / "projects"
PROJECTS.mkdir(exist_ok=True)

_locks: dict[str, threading.Lock] = {}
_audio_cache: dict[str, tuple[float, np.ndarray]] = {}


def _lock(pid: str) -> threading.Lock:
    if pid not in _locks:
        _locks[pid] = threading.Lock()
    return _locks[pid]


def safe_id(pid: str) -> str:
    if not re.fullmatch(r"[a-z0-9]{6,32}", pid or ""):
        raise KeyError("bad project id")
    return pid


def pdir(pid: str) -> Path:
    return PROJECTS / safe_id(pid)


def new_project(filename: str) -> tuple[str, Path]:
    pid = time.strftime("%y%m%d") + uuid.uuid4().hex[:8]
    d = PROJECTS / pid
    d.mkdir(parents=True)
    ext = Path(filename).suffix.lower()[:8] or ".bin"
    return pid, d / ("media" + ext)


def load(pid: str) -> dict:
    p = pdir(pid) / "project.json"
    if not p.is_file():
        raise KeyError(pid)
    return json.loads(p.read_text("utf-8"))


def save(pid: str, data: dict) -> None:
    d = pdir(pid)
    with _lock(pid):
        tmp = d / "project.json.tmp"
        tmp.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), "utf-8")
        tmp.replace(d / "project.json")


def update(pid: str, **fields) -> dict:
    with _lock(pid):
        data = json.loads((pdir(pid) / "project.json").read_text("utf-8"))
        data.update(fields)
        data["updated"] = time.time()
        tmp = pdir(pid) / "project.json.tmp"
        tmp.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), "utf-8")
        tmp.replace(pdir(pid) / "project.json")
    return data


def list_projects() -> list[dict]:
    out = []
    for d in PROJECTS.iterdir():
        f = d / "project.json"
        if not f.is_file():
            continue
        try:
            j = json.loads(f.read_text("utf-8"))
        except Exception:  # noqa: BLE001
            continue
        tr = j.get("transcript") or {}
        out.append({
            "id": j["id"], "name": j.get("name"), "created": j.get("created"),
            "updated": j.get("updated", j.get("created")),
            "kind": (j.get("media") or {}).get("kind"),
            "duration": ((j.get("media") or {}).get("info") or {}).get("duration"),
            "words": sum(len(l.get("words", [])) for l in tr.get("lines", [])),
            "preset": (j.get("style") or {}).get("_preset"),
        })
    out.sort(key=lambda x: x.get("updated") or 0, reverse=True)
    return out


def delete(pid: str) -> None:
    shutil.rmtree(pdir(pid), ignore_errors=True)


def media_path(pid: str) -> Path:
    j = load(pid)
    return pdir(pid) / j["media"]["file"]


def preview_path(pid: str) -> Path:
    j = load(pid)
    m = j["media"]
    return pdir(pid) / (m.get("proxy") or m["file"])


def save_audio(pid: str, mono: np.ndarray) -> None:
    np.save(pdir(pid) / "audio16k.npy", mono.astype(np.float32))
    _audio_cache.pop(pid, None)


def load_audio(pid: str) -> np.ndarray | None:
    f = pdir(pid) / "audio16k.npy"
    if not f.is_file():
        return None
    mt = f.stat().st_mtime
    hit = _audio_cache.get(pid)
    if hit and hit[0] == mt:
        return hit[1]
    a = np.load(f)
    _audio_cache.clear()          # keep one project's audio in memory
    _audio_cache[pid] = (mt, a)
    return a
