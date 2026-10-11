"""
Runs the real server with the speech models swapped for a stand-in, so the
whole interface and export path can be exercised on a machine with no GPU and
no model downloads. Not used by the app.

    python tests/fake_server.py --port 8790 --no-browser
"""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import studio.asr as asr  # noqa: E402
from studio.lines import Word, display_words, fix_times  # noqa: E402

TEXT = ("I've been running through the city, chasing every single dream I had. "
        "Nobody told me it would take this long, but I'm still here. "
        "Pura vida, mae, we keep it moving every night until the morning comes.")


def fake_recognise(self, wav, key, language, context, report):
    report(0.2, "Pretending to transcribe...")
    dur = wav.size / asr.SR
    toks = [t for t, _ in display_words(TEXT)]
    words, t = [], 0.6
    for tok in toks:
        if t > dur - 0.5:
            break
        d = 0.18 + 0.045 * len(tok)
        words.append(Word(tok, t, t + d))
        t += d + (0.55 if tok[-1] in ".," else 0.04)
    report(1.0, "")
    return fix_times(words), asr.split_chunks(wav), language or "English", key


def fake_align(self, pieces, offsets, report=None):
    out = []
    for (w, text, _), off in zip(pieces, offsets):
        toks = [t for t, _ in display_words(text)]
        span = w.size / asr.SR
        s0, s1 = off + 0.12, off + max(0.3, span - 0.12)
        step = (s1 - s0) / max(1, len(toks))
        out.append([Word(tok, s0 + i * step, s0 + (i + 1) * step - 0.03) for i, tok in enumerate(toks)])
    return out


asr.ASR.recognise = fake_recognise
asr.ASR.can_align = lambda self: True
asr.ASR.align = fake_align

import server  # noqa: E402

if __name__ == "__main__":
    server.main()
