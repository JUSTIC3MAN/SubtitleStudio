"""
exporter.py - the browser renders caption frames, ffmpeg lays them on the video.

The same JavaScript renderer draws the live preview and the export frames, so
what you see is exactly what you get. Frames arrive as transparent PNGs in
order; identical or empty frames are sent as a one-byte code and the server
repeats the right bytes, so long holds and gaps cost almost nothing.

  mp4      captions burned into the original video (NVENC on an RTX card)
  mov      transparent ProRes 4444 overlay for Premiere / After Effects
  audio    an audio-only upload becomes a video on a colour or still
"""

from __future__ import annotations

import logging
import os
import re
import struct
import subprocess
import sys
import threading
import time
import uuid
import zlib
from pathlib import Path

from . import media

log = logging.getLogger("studio.export")

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "output"
OUT_DIR.mkdir(exist_ok=True)


def safe_name(s: str, fallback: str = "captions") -> str:
    s = re.sub(r"[^\w\-. ]+", "_", (s or fallback).strip(), flags=re.UNICODE)
    s = re.sub(r"\s+", "_", s).strip("._")
    return (s or fallback)[:80]


def unique_path(p: Path) -> Path:
    if not p.exists():
        return p
    i = 2
    while True:
        q = p.with_name(f"{p.stem}_{i}{p.suffix}")
        if not q.exists():
            return q
        i += 1


def blank_png(w: int, h: int) -> bytes:
    """A fully transparent RGBA PNG, built by hand (no imaging library needed)."""
    def chunk(tag: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
    raw = (b"\x00" + b"\x00" * (w * 4)) * h
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw, 6)) + chunk(b"IEND", b""))


def _hex(c: str) -> str:
    c = (c or "#000000").strip()
    return "0x" + c.lstrip("#")[:6] if re.fullmatch(r"#?[0-9a-fA-F]{6}", c) else "0x000000"


class ExportSession:
    def __init__(self, opts: dict, src: Path, info: dict, background: Path | None):
        self.id = uuid.uuid4().hex[:12]
        self.fmt = opts.get("format", "mp4")
        self.w = int(opts["width"]) // 2 * 2
        self.h = int(opts["height"]) // 2 * 2
        self.fps = float(opts.get("fps") or 30)
        self.total = int(opts.get("frames") or 0)
        self.quality = opts.get("quality", "high")
        self.lock = threading.Lock()
        self.written = 0
        self.last = None
        self.blank = blank_png(self.w, self.h)
        self.err_tail: list[str] = []
        self.failed: str | None = None
        self.started = time.time()

        name = safe_name(opts.get("name") or "captions")
        ext = ".mov" if self.fmt == "mov" else ".mp4"
        self.out = unique_path(OUT_DIR / (name + ext))

        frames_in = ["-f", "image2pipe", "-framerate", f"{self.fps}", "-c:v", "png", "-i", "-"]
        if self.fmt == "mov":
            cmd = [media.FFMPEG, "-y", *frames_in,
                   "-c:v", "prores_ks", "-profile:v", "4444", "-pix_fmt", "yuva444p10le",
                   "-alpha_bits", "16", "-vendor", "apl0", "-qscale:v", "9",
                   "-r", f"{self.fps}", str(self.out)]
        elif self.fmt == "audio":
            # audio-only upload: background colour or still, captions on top, the audio track
            if background and background.is_file():
                bg_in = ["-loop", "1", "-framerate", f"{self.fps}", "-i", str(background)]
                bg_f = (f"[0:v]scale={self.w}:{self.h}:force_original_aspect_ratio=increase,"
                        f"crop={self.w}:{self.h},setsar=1,format=yuv420p[bg]")
            else:
                bg_in = ["-f", "lavfi", "-i", f"color=c={_hex(opts.get('bgColor'))}:s={self.w}x{self.h}:r={self.fps}"]
                bg_f = "[0:v]format=yuv420p[bg]"
            dur = float(info.get("duration") or self.total / self.fps)
            cmd = [media.FFMPEG, "-y", *bg_in, "-i", str(src), *frames_in,
                   "-filter_complex",
                   f"{bg_f};[2:v]format=rgba[ov];[bg][ov]overlay=0:0:eof_action=pass:format=auto,format=yuv420p[v]",
                   "-map", "[v]", "-map", "1:a:0", "-t", f"{dur:.3f}",
                   *media.h264_args(self.quality), "-r", f"{self.fps}",
                   *self._audio_args(info), "-movflags", "+faststart", str(self.out)]
        else:
            # burn into the original. The overlay is drawn at the video's display size.
            cmd = [media.FFMPEG, "-y", "-i", str(src), *frames_in,
                   "-filter_complex",
                   f"[0:v]setpts=PTS-STARTPTS,scale={self.w}:{self.h},setsar=1[base];"
                   f"[1:v]setpts=PTS-STARTPTS,format=rgba[ov];"
                   f"[base][ov]overlay=0:0:eof_action=pass:format=auto,format=yuv420p[v]",
                   "-map", "[v]", "-map", "0:a:0?",
                   *media.h264_args(self.quality), "-r", f"{self.fps}",
                   *self._audio_args(info), "-movflags", "+faststart", str(self.out)]
        self.cmd = cmd
        log.info("export: %s", " ".join(cmd))
        try:
            self.proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL,
                                         stderr=subprocess.PIPE, creationflags=media.NO_WINDOW)
        except Exception as e:  # noqa: BLE001
            self.proc = None
            self.failed = f"could not start ffmpeg: {e}"
            return
        threading.Thread(target=self._drain, daemon=True).start()

    @staticmethod
    def _audio_args(info: dict) -> list[str]:
        if not info.get("has_audio"):
            return ["-an"]
        if info.get("acodec") in ("aac", "mp3"):
            return ["-c:a", "copy"]
        return ["-c:a", "aac", "-b:a", "320k"]

    def _drain(self):
        try:
            for line in self.proc.stderr:
                self.err_tail.append(line.decode("utf-8", "replace").rstrip())
                del self.err_tail[:-60]
        except Exception:  # noqa: BLE001
            pass

    def feed(self, blob: bytes) -> int:
        """
        A batch: repeated [u32 index][u8 kind][u32 length][bytes].
        kind 0 = PNG, 1 = same as previous frame, 2 = empty frame.
        """
        mv = memoryview(blob)
        pos = 0
        with self.lock:
            if self.failed:
                raise RuntimeError(self.failed)
            while pos + 9 <= len(mv):
                idx, kind, n = struct.unpack_from("<IBI", mv, pos)
                pos += 9
                data = bytes(mv[pos:pos + n])
                pos += n
                if idx != self.written:
                    raise RuntimeError(f"frame {idx} arrived out of order (expected {self.written})")
                if kind == 0:
                    frame = data
                elif kind == 1:
                    frame = self.last or self.blank
                else:
                    frame = self.blank
                try:
                    self.proc.stdin.write(frame)
                except Exception as e:  # noqa: BLE001
                    tail = "\n".join(self.err_tail[-8:])
                    self.failed = f"ffmpeg stopped at frame {idx}: {e}\n{tail}"
                    raise RuntimeError(self.failed) from e
                self.last = frame
                self.written += 1
        return self.written

    def finish(self) -> dict:
        with self.lock:
            if self.proc is None:
                return {"ok": False, "error": self.failed or "no encoder"}
            try:
                self.proc.stdin.close()
            except Exception:  # noqa: BLE001
                pass
            code = self.proc.wait(timeout=900)
            ok = code == 0 and self.out.exists() and not self.failed
            return {
                "ok": ok, "path": str(self.out), "name": self.out.name,
                "size": self.out.stat().st_size if self.out.exists() else 0,
                "seconds": round(time.time() - self.started, 1), "frames": self.written,
                "error": None if ok else (self.failed or f"ffmpeg exited with code {code}"),
                "log": "\n".join(self.err_tail[-12:]),
            }

    def cancel(self):
        with self.lock:
            try:
                if self.proc:
                    self.proc.stdin.close()
                    self.proc.kill()
            except Exception:  # noqa: BLE001
                pass
            try:
                self.proc and self.proc.wait(timeout=10)
                if self.out.exists():
                    self.out.unlink()
            except Exception:  # noqa: BLE001
                pass


def save_text(name: str, ext: str, content: str) -> Path:
    p = unique_path(OUT_DIR / (safe_name(name) + ext))
    p.write_text(content, "utf-8")
    return p


def open_folder(path: Path | None = None) -> None:
    target = path or OUT_DIR
    if os.name == "nt":
        if path and path.is_file():
            subprocess.Popen(["explorer", "/select,", str(path)])
        else:
            os.startfile(str(target))  # noqa: S606
    elif sys.platform == "darwin":
        subprocess.Popen(["open", str(target if target.is_dir() else target.parent)])
    else:
        subprocess.Popen(["xdg-open", str(target if target.is_dir() else target.parent)])
