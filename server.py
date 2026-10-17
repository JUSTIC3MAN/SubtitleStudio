#!/usr/bin/env python3
"""
SubtitleStudio - drop in a video or a song, get word-synced animated captions.

    venv\\Scripts\\python server.py            (Start.bat does this for you)
    python server.py --port 8790 --no-browser
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import logging
import os
import socket
import sys
import threading
import time
import webbrowser
from logging.handlers import RotatingFileHandler
from pathlib import Path
from urllib.parse import unquote

ROOT = Path(__file__).resolve().parent
os.environ.setdefault("HF_HOME", str(ROOT / "models" / "hf"))
sys.path.insert(0, str(ROOT))

from fastapi import FastAPI, HTTPException, Request  # noqa: E402
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse  # noqa: E402

from studio import exporter, media, project  # noqa: E402
from studio.asr import ENGINES, LANGUAGES, model_cached, ALIGNER_REPO  # noqa: E402
from studio import separate  # noqa: E402
from studio.pipeline import Worker  # noqa: E402

WEB = ROOT / "web"
LOG_FILE = ROOT / "studio.log"
PRESETS_FILE = ROOT / "my_presets.json"

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)-7s %(name)s: %(message)s",
                    handlers=[logging.StreamHandler(sys.stdout),
                              RotatingFileHandler(LOG_FILE, maxBytes=2_000_000, backupCount=2, encoding="utf-8")])
for noisy in ("httpx", "urllib3", "uvicorn.access", "huggingface_hub", "filelock"):
    logging.getLogger(noisy).setLevel(logging.WARNING)
log = logging.getLogger("studio")

app = FastAPI(title="SubtitleStudio", docs_url=None, redoc_url=None)
worker = Worker()
EXPORTS: dict[str, exporter.ExportSession] = {}


def err(status: int, msg: str):
    raise HTTPException(status_code=status, detail=msg)


# ------------------------------------------------------------------ pages --

@app.get("/")
def index():
    return FileResponse(WEB / "index.html", headers={"Cache-Control": "no-store"})


@app.get("/web/{path:path}")
def web_file(path: str):
    f = (WEB / path).resolve()
    if WEB.resolve() not in f.parents or not f.is_file():
        err(404, "not found")
    return FileResponse(f, headers={"Cache-Control": "no-cache"})


@app.get("/favicon.ico")
def favicon():
    return Response(status_code=204)


# -------------------------------------------------------------------- env --

@app.get("/api/env")
def env():
    sep_ok, sep_why = separate.available()
    # find_spec checks the package is installed without importing torch (slow)
    qwen_ok = importlib.util.find_spec("qwen_asr") is not None
    qwen_why = "" if qwen_ok else "qwen-asr is not installed in this environment"
    return {
        "ffmpeg": bool(media.FFMPEG), "ffprobe": bool(media.FFPROBE),
        "nvenc": media.has_nvenc() if media.FFMPEG else False,
        "gpu": worker.status,
        "engines": [{"key": k, "label": v["label"],
                     "cached": model_cached(v["repo"]) if "/" in v["repo"] else None} for k, v in ENGINES.items()],
        "aligner_cached": model_cached(ALIGNER_REPO),
        "qwen": {"ok": qwen_ok, "why": qwen_why},
        "separation": {"ok": sep_ok, "why": sep_why, "cached": separate.model_cached()},
        "languages": LANGUAGES,
        "localFonts": (WEB / "fonts" / "fonts.css").is_file(),
        "outputDir": str(exporter.OUT_DIR),
    }


# --------------------------------------------------------------- projects --

@app.get("/api/projects")
def projects():
    return project.list_projects()


@app.post("/api/upload")
async def upload(request: Request):
    if not media.FFPROBE:
        err(400, "ffmpeg/ffprobe not found. Install it with:  winget install Gyan.FFmpeg  then restart.")
    name = unquote(request.headers.get("x-filename") or "upload.mp4")
    pid, dst = project.new_project(name)
    try:
        with open(dst, "wb") as f:
            async for chunk in request.stream():
                f.write(chunk)
        info = media.probe(dst)
        if not info.get("has_audio"):
            project.delete(pid)
            err(400, "That file has no audio track - nothing to transcribe.")
    except HTTPException:
        raise
    except Exception as e:  # noqa: BLE001
        project.delete(pid)
        err(400, f"Could not read that file: {e}")

    kind = media.media_kind(info)
    data = {
        "id": pid, "name": Path(name).stem, "created": time.time(), "updated": time.time(),
        "media": {"file": dst.name, "original": name, "kind": kind, "info": info, "proxy": None},
        "transcript": None, "style": None,
    }
    if not media.browser_playable(dst, info):
        data["media"]["proxy_pending"] = True
    project.save(pid, data)

    if data["media"].get("proxy_pending"):
        def mk():
            ext = ".mp4" if kind == "video" else ".m4a"
            try:
                media.make_proxy(dst, dst.with_name("preview" + ext), info)
                project.update(pid, media={**data["media"], "proxy": "preview" + ext, "proxy_pending": False})
            except Exception as e:  # noqa: BLE001
                log.exception("proxy failed")
                project.update(pid, media={**data["media"], "proxy_pending": False, "proxy_error": str(e)})
        threading.Thread(target=mk, daemon=True).start()

    def peaks():
        try:
            mono = media.load_mono(dst, 8000)
            (project.pdir(pid) / "peaks.json").write_text(json.dumps(media.waveform_peaks(mono, 8000)))
        except Exception:  # noqa: BLE001
            log.exception("waveform failed")
    threading.Thread(target=peaks, daemon=True).start()
    return data


@app.get("/api/projects/{pid}")
def get_project(pid: str):
    try:
        return project.load(pid)
    except KeyError:
        err(404, "no such project")


@app.put("/api/projects/{pid}")
async def put_project(pid: str, request: Request):
    body = await request.json()
    allowed = {k: body[k] for k in ("name", "transcript", "style", "export", "vertical") if k in body}
    try:
        cur = project.load(pid)
    except KeyError:
        err(404, "no such project")
    if "transcript" in allowed and cur.get("transcript") and allowed["transcript"]:
        # the client edits lines; keep the analysis fields it doesn't send
        keep = {k: v for k, v in cur["transcript"].items() if k not in allowed["transcript"]}
        allowed["transcript"] = {**keep, **allowed["transcript"]}
    project.update(pid, **allowed)
    return {"ok": True}


@app.delete("/api/projects/{pid}")
def del_project(pid: str):
    project.delete(pid)
    return {"ok": True}


@app.get("/api/projects/{pid}/peaks")
def get_peaks(pid: str):
    f = project.pdir(pid) / "peaks.json"
    if not f.is_file():
        return JSONResponse({"pending": True})
    return Response(f.read_bytes(), media_type="application/json")


def _range_response(path: Path, request: Request, media_type: str | None = None):
    size = path.stat().st_size
    rng = request.headers.get("range")
    ctype = media_type or {
        ".mp4": "video/mp4", ".m4v": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm",
        ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".aac": "audio/aac", ".wav": "audio/wav",
        ".ogg": "audio/ogg", ".oga": "audio/ogg", ".opus": "audio/ogg", ".flac": "audio/flac",
        ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
    }.get(path.suffix.lower(), "application/octet-stream")
    if not rng or not rng.startswith("bytes="):
        return FileResponse(path, media_type=ctype, headers={"Accept-Ranges": "bytes"})
    a, _, b = rng[6:].split(",")[0].partition("-")
    start = int(a) if a else max(0, size - int(b or 0))
    end = int(b) if (a and b) else size - 1
    end = min(end, size - 1)
    if start > end or start >= size:
        return Response(status_code=416, headers={"Content-Range": f"bytes */{size}"})
    length = end - start + 1

    def body():
        with open(path, "rb") as f:
            f.seek(start)
            left = length
            while left > 0:
                chunk = f.read(min(1 << 20, left))
                if not chunk:
                    break
                left -= len(chunk)
                yield chunk
    return StreamingResponse(body(), status_code=206, media_type=ctype, headers={
        "Content-Range": f"bytes {start}-{end}/{size}", "Accept-Ranges": "bytes",
        "Content-Length": str(length)})


@app.get("/api/projects/{pid}/media")
def get_media(pid: str, request: Request):
    try:
        p = project.preview_path(pid)
    except KeyError:
        err(404, "no such project")
    if not p.is_file():
        err(404, "media missing")
    return _range_response(p, request)


@app.post("/api/projects/{pid}/background")
async def set_background(pid: str, request: Request):
    name = unquote(request.headers.get("x-filename") or "background.png")
    ext = Path(name).suffix.lower()
    if ext not in (".png", ".jpg", ".jpeg", ".webp"):
        err(400, "Use a PNG, JPG or WebP image.")
    d = project.pdir(pid)
    for old in d.glob("background.*"):
        old.unlink()
    dst = d / ("background" + ext)
    dst.write_bytes(await request.body())
    project.update(pid, background=dst.name)
    return {"ok": True, "file": dst.name}


@app.delete("/api/projects/{pid}/background")
def clear_background(pid: str):
    d = project.pdir(pid)
    for old in d.glob("background.*"):
        old.unlink()
    project.update(pid, background=None)
    return {"ok": True}


@app.get("/api/projects/{pid}/background")
def get_background(pid: str, request: Request):
    j = project.load(pid)
    if not j.get("background"):
        err(404, "none")
    return _range_response(project.pdir(pid) / j["background"], request)


# ------------------------------------------------------------------- jobs --

@app.post("/api/projects/{pid}/transcribe")
async def transcribe(pid: str, request: Request):
    opts = await request.json()
    project.load(pid)
    job = worker.submit("transcribe", pid, opts)
    return job.public()


@app.post("/api/projects/{pid}/lyrics")
async def lyrics(pid: str, request: Request):
    opts = await request.json()
    if not (opts.get("lyrics") or "").strip():
        err(400, "Paste some lyrics first.")
    job = worker.submit("lyrics", pid, opts)
    return job.public()


@app.post("/api/projects/{pid}/realign")
def realign(pid: str, body: dict):
    job = worker.run_sync("realign", pid, body, timeout=600)
    if job.state != "done":
        err(500, job.error or "re-sync timed out")
    return job.result


@app.get("/api/jobs/{jid}")
def job_status(jid: str):
    j = worker.jobs.get(jid)
    if not j:
        err(404, "no such job")
    return j.public()


# ---------------------------------------------------------------- presets --

@app.get("/api/presets")
def get_presets():
    if PRESETS_FILE.is_file():
        try:
            return json.loads(PRESETS_FILE.read_text("utf-8"))
        except Exception:  # noqa: BLE001
            pass
    return []


@app.put("/api/presets")
async def put_presets(request: Request):
    body = await request.json()
    if not isinstance(body, list):
        err(400, "expected a list")
    PRESETS_FILE.write_text(json.dumps(body, ensure_ascii=False, indent=1), "utf-8")
    return {"ok": True}


# ----------------------------------------------------------------- export --

@app.post("/api/export/start")
async def export_start(request: Request):
    o = await request.json()
    if not media.FFMPEG:
        err(400, "ffmpeg not found. Install it with:  winget install Gyan.FFmpeg  then restart.")
    pid = o.get("pid")
    j = project.load(pid)
    src = project.media_path(pid)
    bg = project.pdir(pid) / j["background"] if j.get("background") else None
    if o.get("format") == "mp4" and j["media"]["kind"] == "audio":
        o["format"] = "audio"
    s = exporter.ExportSession(o, src, j["media"]["info"], bg)
    if s.failed:
        err(500, s.failed)
    EXPORTS[s.id] = s
    return {"id": s.id, "path": str(s.out), "nvenc": media.has_nvenc()}


@app.post("/api/export/{sid}/frames")
async def export_frames(sid: str, request: Request):
    s = EXPORTS.get(sid)
    if not s:
        err(404, "no such export")
    blob = await request.body()
    try:
        n = await _run_blocking(s.feed, blob)
    except RuntimeError as e:
        err(500, str(e))
    return {"written": n}


@app.post("/api/export/{sid}/finish")
async def export_finish(sid: str):
    s = EXPORTS.pop(sid, None)
    if not s:
        err(404, "no such export")
    return await _run_blocking(s.finish)


@app.post("/api/export/{sid}/cancel")
def export_cancel(sid: str):
    s = EXPORTS.pop(sid, None)
    if s:
        s.cancel()
    return {"ok": True}


@app.post("/api/save-text")
async def save_text(request: Request):
    o = await request.json()
    ext = o.get("ext", ".srt")
    if ext not in (".srt", ".vtt", ".json", ".txt", ".ass"):
        err(400, "bad extension")
    p = exporter.save_text(o.get("name") or "captions", ext, o.get("content") or "")
    return {"ok": True, "path": str(p), "name": p.name}


@app.post("/api/open-folder")
async def open_folder(request: Request):
    o = {}
    try:
        o = await request.json()
    except Exception:  # noqa: BLE001
        pass
    p = Path(o["path"]) if o.get("path") else None
    if p and exporter.OUT_DIR.resolve() not in p.resolve().parents:
        p = None
    try:
        exporter.open_folder(p)
    except Exception as e:  # noqa: BLE001
        err(500, str(e))
    return {"ok": True}


async def _run_blocking(fn, *args):
    import anyio
    return await anyio.to_thread.run_sync(fn, *args)


# ------------------------------------------------------------------- main --

def free_port(preferred: int) -> int:
    for p in [preferred] + list(range(preferred + 1, preferred + 30)):
        with socket.socket() as s:
            if os.name != "nt":   # ignore TIME_WAIT leftovers, as uvicorn does
                s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                s.bind(("127.0.0.1", p))
                return p
            except OSError:
                continue
    return preferred


def main():
    ap = argparse.ArgumentParser(description="SubtitleStudio")
    ap.add_argument("--port", type=int, default=8790)
    ap.add_argument("--no-browser", action="store_true")
    a = ap.parse_args()
    port = free_port(a.port)
    url = f"http://127.0.0.1:{port}/"
    bar = "=" * 64
    print(bar)
    print("  SUBTITLE STUDIO")
    print(bar)
    print(f"  Open:     {url}")
    print(f"  Output:   {exporter.OUT_DIR}")
    print(f"  ffmpeg:   {media.FFMPEG or 'NOT FOUND - winget install Gyan.FFmpeg'}")
    print(bar)
    print("  Leave this window open while you work. Close it to quit.")
    print()
    if not a.no_browser:
        threading.Timer(1.2, lambda: webbrowser.open(url)).start()
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")


if __name__ == "__main__":
    main()
