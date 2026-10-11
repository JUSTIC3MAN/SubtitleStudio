"""
pipeline.py - the GPU work, run one job at a time on a single worker thread.

  transcribe : media -> (vocals) -> words with timings -> caption lines
  lyrics     : your pasted lyrics -> placed on the track line by line
  realign    : re-time the lines you just edited against the audio
"""

from __future__ import annotations

import json
import logging
import queue
import threading
import time
import traceback
import uuid
from dataclasses import dataclass, field

import numpy as np

from . import media, project, separate
from .asr import ASR, SR, free_gpu, torch_info
from .lines import (Word, add_loudness, anchor_lyrics, assign_to_chunks, build_lines,
                    lines_from_json, lines_to_json, parse_lyrics, spread_evenly)

log = logging.getLogger("studio.pipeline")


@dataclass
class Job:
    id: str
    kind: str
    pid: str
    opts: dict
    state: str = "queued"          # queued | running | done | error
    step: str = ""
    progress: float = 0.0
    message: str = "Waiting..."
    warnings: list = field(default_factory=list)
    result: dict | None = None
    error: str | None = None
    created: float = field(default_factory=time.time)
    done_event: threading.Event = field(default_factory=threading.Event)

    def public(self) -> dict:
        return {k: getattr(self, k) for k in
                ("id", "kind", "pid", "state", "step", "progress", "message", "warnings", "result", "error")}


class Worker:
    def __init__(self):
        self.q: "queue.Queue[Job]" = queue.Queue()
        self.jobs: dict[str, Job] = {}
        self.asr = ASR()
        self.status = {"ready": False, "message": "Starting up..."}
        threading.Thread(target=self._warm, daemon=True).start()
        threading.Thread(target=self._loop, daemon=True).start()

    # ---------------------------------------------------------------- api --
    def submit(self, kind: str, pid: str, opts: dict) -> Job:
        job = Job(uuid.uuid4().hex[:12], kind, pid, opts)
        self.jobs[job.id] = job
        self.q.put(job)
        # forget finished jobs after a while
        cutoff = time.time() - 3600
        for k in [k for k, j in self.jobs.items() if j.created < cutoff and j.state in ("done", "error")]:
            self.jobs.pop(k, None)
        return job

    def run_sync(self, kind: str, pid: str, opts: dict, timeout: float = 600) -> Job:
        job = self.submit(kind, pid, opts)
        job.done_event.wait(timeout)
        return job

    # ------------------------------------------------------------ worker --
    def _warm(self):
        info = torch_info()
        if info.get("cuda"):
            self.status = {"ready": True, "message": f"GPU: {info['gpu']} ({info['vram_gb']} GB)", **info}
        elif info.get("torch"):
            self.status = {"ready": True, "message": "No CUDA GPU found - transcription will run on the CPU (slow).", **info}
        else:
            self.status = {"ready": True, "message": "PyTorch is not installed - run setup.bat.", **info}

    def _loop(self):
        while True:
            job = self.q.get()
            job.state = "running"
            try:
                fn = {"transcribe": self._transcribe, "lyrics": self._lyrics, "realign": self._realign}[job.kind]
                job.result = fn(job)
                job.state = "done"
                job.progress = 1.0
                if job.kind != "realign":
                    job.message = "Done"
            except Exception as e:  # noqa: BLE001
                log.error("job %s failed:\n%s", job.kind, traceback.format_exc())
                job.state = "error"
                job.error = f"{type(e).__name__}: {e}"
                job.message = job.error
            finally:
                job.done_event.set()

    # ----------------------------------------------------------- helpers --
    @staticmethod
    def _set(job: Job, step: str, lo: float, hi: float):
        def report(f: float, msg: str = ""):
            job.step = step
            job.progress = lo + (hi - lo) * max(0.0, min(1.0, f))
            if msg:
                job.message = msg
        return report

    # -------------------------------------------------------- transcribe --
    def _transcribe(self, job: Job) -> dict:
        pid, o = job.pid, job.opts
        d = project.pdir(pid)
        src = project.media_path(pid)
        language = o.get("language") or None
        if language in ("auto", "Auto", ""):
            language = None
        engine = o.get("engine") or "qwen3-1.7b"
        want_sep = bool(o.get("separate", True))
        lyrics = (o.get("lyrics") or "").strip()
        hints = (o.get("hints") or "").strip()

        rep = self._set(job, "audio", 0.0, 0.05)
        rep(0, "Reading the audio...")
        analysis_src = src
        used_sep = False
        if want_sep:
            ok, why = separate.available()
            if not ok:
                job.warnings.append(f"Vocal isolation unavailable ({why}); transcribing the full mix.")
            else:
                rep = self._set(job, "vocals", 0.05, 0.30)
                first = not separate.model_cached(o.get("sep_model") or separate.DEFAULT_MODEL)
                rep(0.05, "Isolating the vocal" + (" (downloading the vocal model first, ~600 MB)..." if first else "..."))
                mix = d / "mix.wav"
                try:
                    if (d / "vocals.wav").is_file() and (d / "vocals.wav").stat().st_size > 1000:
                        rep(1.0, "Using the vocal isolated last time...")
                        analysis_src = d / "vocals.wav"     # same file, same model: no need to redo it
                    else:
                        media.extract_wav(src, mix, 44100, 2)
                        rep(0.15, "Isolating the vocal (BS-RoFormer, about 10 s per minute of audio)...")
                        analysis_src = separate.isolate_vocals(mix, d, o.get("sep_model") or separate.DEFAULT_MODEL)
                    used_sep = True
                except Exception as e:  # noqa: BLE001
                    log.exception("separation failed")
                    job.warnings.append(f"Vocal isolation failed ({type(e).__name__}: {e}); used the full mix.")
                    analysis_src = src
                finally:
                    mix.unlink(missing_ok=True)
                free_gpu()

        rep = self._set(job, "transcribe", 0.30, 0.32)
        rep(0, "Preparing audio for recognition...")
        wav = media.load_mono(analysis_src, SR)
        if wav.size < SR // 2:
            raise RuntimeError("No audio found in this file.")
        project.save_audio(pid, wav)

        context = "\n".join(x for x in (lyrics, hints) if x)[:6000]
        rep = self._set(job, "transcribe", 0.32, 0.97)
        words, chunks, lang, used = self.asr.recognise(wav, engine, language, context, rep)
        if used != engine:
            job.warnings.append("Qwen3-ASR could not run on this machine, so Whisper was used. "
                                "See studio.log for the reason.")

        ref = add_loudness(words, wav)
        lines = build_lines(words)
        transcript = {
            "language": lang, "engine": used, "separated": used_sep,
            "chunks": [[round(s, 3), round(e, 3)] for s, e in chunks],
            "loud_ref": list(ref), "lines": lines_to_json(lines),
            "made": time.time(),
        }
        if lyrics:
            rep = self._set(job, "lyrics", 0.97, 1.0)
            rep(0, "Placing your lyrics on the track...")
            transcript["lines"] = self._place_lyrics(pid, lyrics, words, chunks, lang, ref, wav, rep)
            transcript["from_lyrics"] = True
        project.update(pid, transcript=transcript, transcript_opts={
            "language": o.get("language") or "auto", "engine": engine, "separate": want_sep, "hints": hints})
        return {"transcript": transcript, "warnings": job.warnings}

    # ------------------------------------------------------------ lyrics --
    def _place_lyrics(self, pid, lyrics, heard, chunks, lang, ref, wav, rep) -> list[dict]:
        lyric_lines = parse_lyrics(lyrics)
        if not lyric_lines:
            raise RuntimeError("No lyric lines found in what you pasted.")
        flat = [t for ln in lyric_lines for t in ln]
        times = anchor_lyrics(lyric_lines, heard)
        matched = sum(1 for t in times if t is not None)
        log.info("lyrics: %d/%d tokens anchored", matched, len(flat))
        placed: list[Word | None] = [None] * len(flat)

        if self.asr.can_align() and chunks:
            cidx = assign_to_chunks(times, chunks)
            pieces, offsets, members = [], [], []
            for c, (s, e) in enumerate(chunks):
                idx = [i for i, ci in enumerate(cidx) if ci == c]
                if not idx:
                    continue
                pieces.append((wav[int(s * SR):int(e * SR)], " ".join(flat[i] for i in idx), lang))
                offsets.append(s)
                members.append(idx)
            try:
                aligned = self.asr.align(pieces, offsets, lambda f, m: rep(f, "Placing your lyrics on the track..."))
                for idx, ws in zip(members, aligned):
                    if len(ws) == len(idx):
                        for i, w in zip(idx, ws):
                            placed[i] = Word(flat[i], w.s, w.e)
            except Exception:  # noqa: BLE001
                log.exception("lyric alignment failed; using anchors")

        # anything the aligner couldn't place: spread between the nearest anchors
        i = 0
        while i < len(flat):
            if placed[i] is not None:
                i += 1
                continue
            j = i
            while j < len(flat) and placed[j] is None:
                j += 1
            left = placed[i - 1].e if i > 0 else None
            right = placed[j].s if j < len(flat) else None
            ts = [t for t in times[i:j] if t is not None]
            s = left if left is not None else (min(ts) - 0.3 if ts else 0.0)
            e = right if right is not None else (max(ts) + 0.3 if ts else s + 0.4 * (j - i))
            if e <= s:
                e = s + 0.3 * (j - i)
            for k, w in enumerate(spread_evenly(flat[i:j], s, e)):
                placed[i + k] = w
            i = j

        out, k = [], 0
        for ln in lyric_lines:
            ws = [placed[k + n] for n in range(len(ln))]
            k += len(ln)
            out.append(ws)
        allw = [w for ln in out for w in ln]
        add_loudness(allw, wav, ref=tuple(ref) if ref else None)
        return lines_to_json(out)

    def _lyrics(self, job: Job) -> dict:
        pid, o = job.pid, job.opts
        j = project.load(pid)
        tr = j.get("transcript") or {}
        wav = project.load_audio(pid)
        if wav is None or not tr:
            raise RuntimeError("Transcribe the file first - the lyrics are matched against what was heard.")
        heard = [w for ln in lines_from_json(tr.get("lines", [])) for w in ln]
        chunks = [tuple(c) for c in tr.get("chunks", [])]
        rep = self._set(job, "lyrics", 0.0, 1.0)
        rep(0, "Placing your lyrics on the track...")
        lines = self._place_lyrics(pid, o.get("lyrics", ""), heard, chunks, tr.get("language") or "English",
                                   tr.get("loud_ref"), wav, rep)
        tr = {**tr, "lines": lines, "from_lyrics": True, "made": time.time()}
        project.update(pid, transcript=tr)
        return {"transcript": tr}

    # ----------------------------------------------------------- realign --
    def _realign(self, job: Job) -> dict:
        """opts.items: [{key, text, s, e, lo, hi}] - lo/hi are hard limits (neighbouring lines)."""
        pid = job.pid
        items = job.opts.get("items") or []
        lang = job.opts.get("language") or "English"
        wav = project.load_audio(pid)
        if wav is None:
            raise RuntimeError("No analysis audio for this project - transcribe it first.")
        tr = (project.load(pid).get("transcript") or {})
        ref = tuple(tr["loud_ref"]) if tr.get("loud_ref") else None
        dur = wav.size / SR

        pieces, offsets, keys, spans = [], [], [], []
        for it in items:
            text = " ".join((it.get("text") or "").split())
            if not text:
                continue
            s, e = float(it.get("s", 0)), float(it.get("e", 0))
            lo = float(it.get("lo", 0) or 0)
            hi = float(it.get("hi", dur) or dur)
            a = max(0.0, lo, s - 0.45)
            b = min(dur, hi, max(e, s + 0.3) + 0.45)
            if b - a < 0.3:
                b = min(dur, a + 0.3)
            pieces.append((wav[int(a * SR):int(b * SR)], text, lang))
            offsets.append(a)
            keys.append(it.get("key"))
            spans.append((s, e))

        out = {}
        aligned = None
        if self.asr.can_align():
            try:
                aligned = self.asr.align(pieces, offsets)
            except Exception as e:  # noqa: BLE001
                log.exception("realign failed")
                job.warnings.append(f"Aligner unavailable ({type(e).__name__}); timings spread evenly instead.")
        for n, (key, (w16, text, _), (s, e)) in enumerate(zip(keys, pieces, spans)):
            if aligned is not None:
                ws = aligned[n]
            else:
                from .lines import display_words
                ws = spread_evenly([t for t, _ in display_words(text)], s, e)
            add_loudness(ws, wav, ref=ref)
            out[str(key)] = [w.to_json() for w in ws]
        return {"lines": out, "aligned": aligned is not None, "warnings": job.warnings}
