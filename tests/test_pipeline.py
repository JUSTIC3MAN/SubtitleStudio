"""
Checks for the text/timing logic that sits between the models and the screen.
Runs without torch or any model:  python tests/test_pipeline.py
"""
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from studio.lines import (Word, add_loudness, anchor_lyrics, assign_to_chunks, build_lines,  # noqa: E402
                          clean_token, display_words, parse_lyrics, words_from_alignment, spread_evenly)
from studio.asr import split_chunks, is_active, voice_floor, SR  # noqa: E402
from studio.exporter import blank_png  # noqa: E402

fails = 0


def check(name, cond, detail=""):
    global fails
    print(("  ok   " if cond else "  FAIL ") + name + ("" if cond else f"   -> {detail}"))
    if not cond:
        fails += 1


print("tokens")
check("aligner keeps apostrophes", clean_token("I'm,") == "I'm")
check("curly apostrophe normalised", clean_token("don’t") == "don't")
dw = display_words("Yeah - I'm on my way... ¿Qué pasa, mae?")
check("dash glued to previous word", dw[0] == ("Yeah -", 1), dw)
check("ellipsis stays on its word", ("way...", 1) in dw, dw)
check("spanish marks kept", ("¿Qué", 1) in dw and ("mae?", 1) in dw, dw)

print("alignment -> words")
items = [("Yeah", 0.1, 0.4), ("I'm", 0.5, 0.7), ("on", 0.7, 0.8), ("my", 0.8, 0.9), ("way", 0.9, 1.3),
         ("Qué", 1.5, 1.8), ("pasa", 1.8, 2.1), ("mae", 2.1, 2.5)]
ws = words_from_alignment("Yeah - I'm on my way... ¿Qué pasa, mae?", items)
check("punctuation restored", [w.t for w in ws] == ["Yeah -", "I'm", "on", "my", "way...", "¿Qué", "pasa,", "mae?"], [w.t for w in ws])
check("times carried", ws[4].s == 0.9 and ws[4].e == 1.3)
bad = words_from_alignment("one two three", [("one", 0, .2), ("two", .2, .4)])
check("count mismatch falls back to aligner tokens", [w.t for w in bad] == ["one", "two"])
z = words_from_alignment("a b", [("a", 1.0, 1.0), ("b", 1.0, 1.0)])
check("zero-length words get a duration", all(w.e > w.s for w in z) and z[1].s >= z[0].s, [(w.s, w.e) for w in z])

print("line building")
words = []
t = 0.0
for i, tok in enumerate("I've been running through the city, chasing every single dream I had. Nobody told me".split()):
    words.append(Word(tok, t, t + 0.3))
    t += 0.35 + (0.8 if tok.endswith(".") else 0)
lines = build_lines(words)
texts = [" ".join(w.t for w in ln) for ln in lines]
check("breaks after a sentence", any(x.endswith("had.") for x in texts), texts)
check("no line over 42 chars", all(len(x) <= 42 for x in texts), texts)
check("every word kept once", sum(len(ln) for ln in lines) == len(words))
long = [Word(f"w{i}", i * 0.2, i * 0.2 + 0.15) for i in range(30)]
check("long breathless run is split", len(build_lines(long)) >= 3)

print("loudness")
wav = np.zeros(SR * 3, dtype=np.float32)
wav[int(0.1 * SR):int(0.5 * SR)] = 0.05 * np.sin(np.arange(int(0.4 * SR)) / 5)
wav[int(1.0 * SR):int(1.4 * SR)] = 0.6 * np.sin(np.arange(int(0.4 * SR)) / 5)
lw = [Word("soft", 0.1, 0.5), Word("LOUD", 1.0, 1.4), Word("mid", 2.0, 2.3)]
add_loudness(lw, wav)
check("loud word scores higher", lw[1].l > lw[0].l, [w.l for w in lw])

print("chunking")
wav = np.random.RandomState(0).randn(SR * 260).astype(np.float32) * 0.2
wav[int(104 * SR):int(104.6 * SR)] = 0.0      # a breath near the first cut
ch = split_chunks(wav)
check("chunks tile the audio", abs(ch[0][0]) < 1e-6 and abs(ch[-1][1] - 260) < 1e-3
      and all(abs(a[1] - b[0]) < 1e-6 for a, b in zip(ch, ch[1:])), ch)
check("cut lands in the breath", 104.0 <= ch[0][1] <= 104.6, ch[0])
check("chunks under the aligner limit", all(e - s < 300 for s, e in ch))
check("silence detected", not is_active(np.zeros(SR * 2, dtype=np.float32), voice_floor(wav)))
check("voice detected", is_active(wav[:SR * 2], voice_floor(wav)))

print("lyrics")
ly = parse_lyrics("[Verse 1]\nI've been running through the city\n\n(Chorus)\nChasing every single dream\n")
check("labels skipped, lines kept", [" ".join(l) for l in ly] == ["I've been running through the city", "Chasing every single dream"], ly)
heard = [Word(x, i * 0.4, i * 0.4 + 0.3) for i, x in enumerate("I been running thru the city chasing every single dream".split())]
times = anchor_lyrics(ly, heard)
check("most lyric words anchored", sum(t is not None for t in times) >= 8, times)
cid = assign_to_chunks(times, [(0, 2.0), (2.0, 5.0)])
check("chunk assignment monotonic", all(a <= b for a, b in zip(cid, cid[1:])), cid)
check("chunk assignment splits at the time", cid[0] == 0 and cid[-1] == 1, cid)
ev = spread_evenly(["one", "three", "x"], 1.0, 2.0)
check("even spread stays inside span", ev[0].s >= 1.0 and ev[-1].e <= 2.0 and ev[1].e - ev[1].s > ev[2].e - ev[2].s)

print("export")
png = blank_png(64, 32)
check("blank png header", png[:8] == b"\x89PNG\r\n\x1a\n" and len(png) < 400)

print()
print("FAILED: %d" % fails if fails else "all good")
sys.exit(1 if fails else 0)
