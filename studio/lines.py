"""
lines.py - turning timed words into caption lines, and keeping punctuation.

The forced aligner works on bare tokens (letters, digits, apostrophes). People
read words with their punctuation and hyphens still on, so the aligner's
tokens are mapped back onto the original whitespace-separated words here.

Also: per-word loudness, the initial line breaks, and matching pasted lyrics
against what the recogniser heard.
"""

from __future__ import annotations

import difflib
import re
import unicodedata
from dataclasses import dataclass, field

import numpy as np


# ----------------------------------------------------------- tokenising ---

def _kept(ch: str) -> bool:
    if ch == "'" or ch == "’":
        return True
    cat = unicodedata.category(ch)
    return cat.startswith("L") or cat.startswith("N")


def clean_token(tok: str) -> str:
    """Exactly what Qwen3-ForcedAligner keeps of a word."""
    return "".join(ch for ch in tok.replace("’", "'") if _kept(ch))


def _is_cjk(ch: str) -> bool:
    c = ord(ch)
    return (0x4E00 <= c <= 0x9FFF or 0x3400 <= c <= 0x4DBF or 0x20000 <= c <= 0x2CEAF
            or 0xF900 <= c <= 0xFAFF)


def count_tokens(cleaned: str) -> int:
    """Mirror of the aligner's split: each CJK character alone, other runs as one."""
    n, in_run = 0, False
    for ch in cleaned:
        if _is_cjk(ch):
            n += 1
            in_run = False
        elif not in_run:
            n += 1
            in_run = True
    return max(1, n)


def norm(tok: str) -> str:
    """Comparison key: lowercase, no accents, no punctuation."""
    t = unicodedata.normalize("NFKD", clean_token(tok).lower())
    return "".join(ch for ch in t if not unicodedata.combining(ch)).replace("'", "")


@dataclass
class Word:
    t: str              # display text, punctuation included
    s: float            # start (s)
    e: float            # end (s)
    l: float = 0.5      # loudness 0..1 (relative to the whole take)
    k: bool = False     # marked as a key word by the user

    def to_json(self) -> dict:
        d = {"t": self.t, "s": round(self.s, 3), "e": round(self.e, 3), "l": round(self.l, 2)}
        if self.k:
            d["k"] = 1
        return d


def display_words(text: str) -> list[tuple[str, int]]:
    """
    Split text the way the aligner does and say how many aligner tokens each
    display word stands for. Pure punctuation ("-", "...") has no token and is
    glued onto the word before it, so it never becomes a caption word on its own.
    """
    out: list[list] = []
    for seg in text.split():
        c = clean_token(seg)
        if not c:
            if out:
                out[-1][0] += seg if seg[0] in ".,!?;:…)\"'" else " " + seg
            else:
                out.append([seg, 0])
            continue
        out.append([seg, count_tokens(c)])
    # leading punctuation-only word with no token: merge into the next one
    if out and out[0][1] == 0 and len(out) > 1:
        out[1][0] = out[0][0] + out[1][0]
        out.pop(0)
    return [(w, n) for w, n in out]


def words_from_alignment(text: str, items: list[tuple[str, float, float]]) -> list[Word]:
    """Map aligner items (token, start, end) back onto display words."""
    dws = display_words(text)
    need = sum(n for _, n in dws)
    if need != len(items) or not dws:
        # The two tokenisations disagreed - fall back to the aligner's own tokens.
        return [Word(tok, float(s), float(e)) for tok, s, e in items]
    words: list[Word] = []
    i = 0
    for w, n in dws:
        if n == 0:
            continue
        seg = items[i:i + n]
        i += n
        words.append(Word(w, float(seg[0][1]), float(seg[-1][2])))
    return fix_times(words)


def fix_times(words: list[Word], min_dur: float = 0.05) -> list[Word]:
    """Starts strictly increasing, no overlaps, never zero-length.
    (The aligner occasionally stacks several words on one instant.)"""
    for i, w in enumerate(words):
        if i and w.s < words[i - 1].s + 0.02:
            w.s = words[i - 1].s + 0.02
        if w.e < w.s + min_dur:
            w.e = w.s + min_dur
    for a, b in zip(words, words[1:]):
        if a.e > b.s:
            a.e = max(a.s + 0.02, b.s)
    return words


def spread_evenly(texts: list[str], s: float, e: float) -> list[Word]:
    """Lay words over [s, e] by character weight - used when no aligner is available."""
    if not texts:
        return []
    weights = np.array([max(1, len(clean_token(t))) + 1.5 for t in texts], dtype=float)
    span = max(0.05 * len(texts), e - s)
    edges = s + np.concatenate([[0], np.cumsum(weights)]) / weights.sum() * span
    return [Word(t, float(edges[i]), float(edges[i + 1]) - 0.02) for i, t in enumerate(texts)]


# ------------------------------------------------------------- loudness ---

def add_loudness(words: list[Word], mono16k: np.ndarray, sr: int = 16000,
                 ref: tuple[float, float] | None = None) -> tuple[float, float]:
    """
    Per-word RMS (dBFS) mapped to 0..1 against the 10th-95th percentile of the
    take, so the scale follows the performance rather than the gain staging.
    Returns the reference so later re-syncs land on the same scale.
    """
    if mono16k is None or mono16k.size == 0 or not words:
        return ref or (-40.0, -10.0)
    dbs = []
    for w in words:
        a = max(0, int(w.s * sr))
        b = min(mono16k.size, max(a + 1, int(w.e * sr)))
        seg = mono16k[a:b]
        rms = float(np.sqrt(np.mean(seg.astype(np.float64) ** 2))) if seg.size else 0.0
        dbs.append(20 * np.log10(max(rms, 1e-6)))
    dbs = np.array(dbs)
    if ref is None:
        lo, hi = float(np.percentile(dbs, 10)), float(np.percentile(dbs, 95))
        if hi - lo < 3:
            lo, hi = hi - 12, hi
        ref = (lo, hi)
    lo, hi = ref
    for w, d in zip(words, dbs):
        w.l = float(np.clip((d - lo) / (hi - lo), 0, 1))
    return ref


# -------------------------------------------------------- line breaking ---

STRONG_END = re.compile(r"[.!?…。！？]+[\"'”’)]*$")
SOFT_END = re.compile(r"[,;:—–，]+[\"'”’)]*$")


def build_lines(words: list[Word], max_chars: int = 42, max_words: int = 12,
                pause: float = 0.6) -> list[list[Word]]:
    """
    Initial caption lines: break on breaths and sentence ends, then split
    anything longer than a subtitle line (42 characters, the Netflix limit) at
    the best point near the middle - the biggest pause, ideally after a comma.
    """
    if not words:
        return []
    runs: list[list[Word]] = [[words[0]]]
    for prev, w in zip(words, words[1:]):
        gap = w.s - prev.e
        if gap >= pause or STRONG_END.search(prev.t):
            runs.append([w])
        else:
            runs[-1].append(w)

    def chars(ws):
        return sum(len(w.t) for w in ws) + max(0, len(ws) - 1)

    def split(ws):
        if len(ws) <= 1 or (chars(ws) <= max_chars and len(ws) <= max_words):
            return [ws]
        best, best_score = 1, -1e9
        total = chars(ws)
        left = 0
        for i in range(1, len(ws)):
            left += len(ws[i - 1].t) + 1
            gap = ws[i].s - ws[i - 1].e
            balance = 1 - abs(left / total - 0.5) * 2          # 1 at the middle
            score = balance * 2.0 + min(gap, 0.5) * 6
            if SOFT_END.search(ws[i - 1].t):
                score += 1.5
            if len(ws[i - 1].t) <= 3 and ws[i - 1].t.lower() in SHORT_FUNCTION:
                score -= 1.2                                     # don't strand "the", "a", "de"
            # never leave a one- or two-word scrap on a line of its own
            short = min(i, len(ws) - i)
            if short == 1:
                score -= 6
            elif short == 2:
                score -= 2
            if score > best_score:
                best, best_score = i, score
        return split(ws[:best]) + split(ws[best:])

    out: list[list[Word]] = []
    for r in runs:
        out.extend(split(r))
    return merge_scraps(out, max_chars)


def merge_scraps(lines: list[list[Word]], max_chars: int = 42, max_gap: float = 2.2) -> list[list[Word]]:
    """
    Fold one-word lines ("bird?" after "Is that a") and lines that end on a
    dangling function word back into the phrase they belong to, as long as the
    result still fits on a subtitle line.
    """
    def chars(ws):
        return sum(len(w.t) for w in ws) + max(0, len(ws) - 1)

    changed = True
    while changed:
        changed = False
        for i, ln in enumerate(lines):
            dangling = ln[-1].t.lower().strip(".,!?") in SHORT_FUNCTION and not STRONG_END.search(ln[-1].t)
            scrap = len(ln) == 1 or (len(ln) == 2 and chars(ln) <= 9)
            if not (scrap or dangling):
                continue
            prev = lines[i - 1] if i > 0 else None
            nxt = lines[i + 1] if i + 1 < len(lines) else None
            gp = ln[0].s - prev[-1].e if prev else 1e9
            gn = nxt[0].s - ln[-1].e if nxt else 1e9
            # a sentence end on the previous line means this scrap starts something new
            if prev and STRONG_END.search(prev[-1].t):
                gp += 1.0
            if dangling and not scrap:
                gp = 1e9          # "Is that a" wants the words after it
            if STRONG_END.search(ln[-1].t) and not dangling:
                gn += 1.0
            for side, gap, other in (("n", gn, nxt), ("p", gp, prev)) if gn <= gp else (("p", gp, prev), ("n", gn, nxt)):
                if other is None or gap > max_gap or chars(ln) + chars(other) + 1 > max_chars + 6:
                    continue
                if side == "n":
                    lines[i] = ln + other
                    del lines[i + 1]
                else:
                    lines[i - 1] = other + ln
                    del lines[i]
                changed = True
                break
            if changed:
                break
    return lines


SHORT_FUNCTION = {
    "a", "an", "the", "to", "of", "in", "on", "and", "or", "my", "your", "i", "for", "at",
    "el", "la", "los", "las", "un", "una", "de", "del", "y", "o", "mi", "tu", "en", "con", "que", "por",
}


def lines_to_json(lines: list[list[Word]]) -> list[dict]:
    return [{"words": [w.to_json() for w in ln]} for ln in lines if ln]


def lines_from_json(lines: list[dict]) -> list[list[Word]]:
    out = []
    for ln in lines or []:
        ws = [Word(w["t"], float(w["s"]), float(w["e"]), float(w.get("l", 0.5)), bool(w.get("k")))
              for w in ln.get("words", [])]
        if ws:
            out.append(ws)
    return out


# ------------------------------------------------------- pasted lyrics ---

def parse_lyrics(text: str) -> list[list[str]]:
    """One caption line per lyric line; section labels like [Chorus] dropped."""
    out = []
    for raw in (text or "").replace("\r", "").split("\n"):
        line = raw.strip()
        if not line:
            continue
        if re.fullmatch(r"[\[(].{0,40}[\])]", line):      # [Verse 1], (Chorus x2)
            continue
        toks = [t for t, _ in display_words(line)]
        if toks:
            out.append(toks)
    return out


def anchor_lyrics(lyric_lines: list[list[str]], heard: list[Word]) -> list[float | None]:
    """
    For every lyric token, the time of the recognised word it matches, or None.
    Exact matches first; same-length replaced runs are paired one to one, since
    those are usually mishearings of the right syllables.
    """
    flat = [t for ln in lyric_lines for t in ln]
    a = [norm(t) for t in flat]
    b = [norm(w.t) for w in heard]
    times: list[float | None] = [None] * len(flat)
    sm = difflib.SequenceMatcher(None, a, b, autojunk=False)
    for tag, i1, i2, j1, j2 in sm.get_opcodes():
        if tag == "equal" or (tag == "replace" and (i2 - i1) == (j2 - j1)):
            for k in range(i2 - i1):
                times[i1 + k] = (heard[j1 + k].s + heard[j1 + k].e) / 2
    return times


def assign_to_chunks(times: list[float | None], chunks: list[tuple[float, float]]) -> list[int]:
    """
    Which recognition chunk each lyric token belongs to. Anchored tokens go to
    the chunk containing their time; the rest follow their anchored neighbours,
    and the result never steps backwards in time.
    """
    n = len(times)
    if not chunks:
        return [0] * n

    def chunk_of(t: float) -> int:
        for i, (s, e) in enumerate(chunks):
            if t < e:
                return i
        return len(chunks) - 1

    idx: list[int | None] = [chunk_of(t) if t is not None else None for t in times]
    # enforce monotonic anchors (drop anchors that go backwards)
    last = -1
    for i, c in enumerate(idx):
        if c is None:
            continue
        if c < last:
            idx[i] = None
        else:
            last = c
    # fill gaps: split each unanchored run between its neighbours' chunks
    i = 0
    while i < n:
        if idx[i] is not None:
            i += 1
            continue
        j = i
        while j < n and idx[j] is None:
            j += 1
        left = idx[i - 1] if i > 0 else (idx[j] if j < n else 0)
        right = idx[j] if j < n else left
        run = j - i
        for k in range(run):
            idx[i + k] = left if (right == left or k < run / 2) else right
        i = j
    return [int(c) for c in idx]
