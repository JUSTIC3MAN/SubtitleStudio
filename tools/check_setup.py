"""
check_setup.py - is everything in place? Loads each model on the GPU once.

    venv\\Scripts\\python tools\\check_setup.py
"""
import os
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
os.environ.setdefault("HF_HOME", str(ROOT / "models" / "hf"))
sys.path.insert(0, str(ROOT))

import numpy as np  # noqa: E402


def line(ok, label, detail=""):
    print(f"  [{'ok' if ok else '!!'}] {label}" + (f"  -  {detail}" if detail else ""))


def main():
    print("\nSubtitle Studio - setup check\n")
    from studio import media
    line(bool(media.FFMPEG), "ffmpeg", media.FFMPEG or "not found: winget install Gyan.FFmpeg")
    if media.FFMPEG:
        line(media.has_nvenc(), "NVENC hardware encoding", "on" if media.has_nvenc() else "off - exports use x264 on the CPU (slower)")

    from studio.asr import torch_info, ASR, SR
    ti = torch_info()
    line(bool(ti.get("torch")), "PyTorch", ti.get("torch") or ti.get("error"))
    line(bool(ti.get("cuda")), "CUDA GPU", f"{ti.get('gpu')} ({ti.get('vram_gb')} GB)" if ti.get("cuda") else "not available - recognition will be very slow")

    from studio import separate
    ok, why = separate.available()
    line(ok, "Vocal isolation package", why)

    asr = ASR()
    silence = np.zeros(SR * 3, dtype=np.float32)
    tone = (0.1 * np.sin(np.arange(SR * 3) * 2 * np.pi * 220 / SR)).astype(np.float32)
    try:
        t0 = time.time()
        eng = asr.engine("qwen3-1.7b")
        eng.load(lambda f, m: print("     " + m, end="\r") if m else None)
        out = eng.transcribe(tone, [(0.0, 3.0)], "English", "")
        line(True, "Qwen3-ASR 1.7B loads and runs", f"{time.time() - t0:.1f}s, heard: {out[0]['text'] if out else '(nothing, as expected)'}")
    except Exception as e:  # noqa: BLE001
        line(False, "Qwen3-ASR 1.7B", f"{type(e).__name__}: {e}")
    try:
        t0 = time.time()
        res = asr.align([(tone, "testing one two", "English")], [0.0])
        line(len(res[0]) == 3, "Word aligner loads and runs", f"{time.time() - t0:.1f}s, {[(w.t, round(w.s, 2)) for w in res[0]]}")
    except Exception as e:  # noqa: BLE001
        line(False, "Word aligner", f"{type(e).__name__}: {e}")
    del silence
    print("\nDone. If everything says ok, double-click Start.bat.\n")


if __name__ == "__main__":
    main()
