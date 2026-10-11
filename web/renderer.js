/* ==========================================================================
   renderer.js - draws the captions for any moment in time.

   One renderer for the live preview and for the export, and every frame is a
   pure function of (transcript, style, time). That is what makes the exported
   video match the preview exactly, and lets the exporter skip frames that are
   identical to the last one.
   ========================================================================== */
(function () {
  const SS = (window.SS = window.SS || {});

  const clamp = (x, a = 0, b = 1) => (x < a ? a : x > b ? b : x);
  const lerp = (a, b, k) => a + (b - a) * k;
  const ease = {
    outCubic: (t) => 1 - Math.pow(1 - t, 3),
    outQuart: (t) => 1 - Math.pow(1 - t, 4),
    outExpo: (t) => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t)),
    inOutCubic: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
    outBack: (t) => { const c1 = 1.9, c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); },
  };
  SS.ease = ease;

  // deterministic per-word randomness (tilt), so export == preview
  const rand = (i) => { const x = Math.sin(i * 12.9898 + 78.233) * 43758.5453; return x - Math.floor(x); };

  function rgba(hex, a) {
    const h = (hex || '#000').replace('#', '');
    const f = h.length === 3 ? h.split('').map((c) => c + c).join('') : h.padEnd(6, '0');
    const n = parseInt(f.slice(0, 6), 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  }

  /* ---------------------------------------------------- text clean-up -- */
  const TRAIL_SOFT = /[,.;:—–-]+(["'”’)]*)$/;
  function shapeText(t, s) {
    let x = t;
    if (s.punctuation === 'strip') {
      x = x.replace(/[^\p{L}\p{N}'’\-&$%#@+]/gu, '').replace(/^-+|-+$/g, '');
      if (!x) x = t;
    } else if (s.punctuation === 'soft') {
      x = x.replace(TRAIL_SOFT, '$1');
      if (!x) x = t;
    }
    if (s.textCase === 'upper') x = x.toLocaleUpperCase();
    else if (s.textCase === 'lower') x = x.toLocaleLowerCase();
    return x;
  }
  SS.shapeText = shapeText;

  const FUNCTION_WORDS = new Set(['a', 'an', 'the', 'to', 'of', 'in', 'on', 'and', 'or', 'my', 'your', 'i', 'for', 'at', 'is',
    'el', 'la', 'los', 'las', 'un', 'una', 'de', 'del', 'y', 'o', 'mi', 'tu', 'en', 'con', 'que', 'por', 'se', 'me', 'te', 'lo']);

  /* ------------------------------------------------- pages from lines -- */
  // Split one line into pages of <= maxWords, preferring breaks at pauses and
  // punctuation and never stranding "the" / "de" at the end of a page.
  function chunkLine(words, maxWords) {
    const n = words.length;
    if (n <= maxWords) return [[0, n]];
    const cost = new Array(n + 1).fill(Infinity), from = new Array(n + 1).fill(0);
    cost[0] = 0;
    for (let j = 1; j <= n; j++) {
      for (let i = Math.max(0, j - maxWords); i < j; i++) {
        const size = j - i;
        let c = cost[i] + Math.pow(maxWords - size, 2) * 0.35;
        if (size === 1 && maxWords >= 3) c += 2.5;
        if (j < n) {
          const w = words[j - 1], nx = words[j];
          const gap = nx.s - w.e;
          if (/[,.;:!?…]$/.test(w.t)) c -= 1.6;
          c -= Math.min(gap, 0.5) * 5;
          if (FUNCTION_WORDS.has(w.t.toLowerCase().replace(/[^\p{L}']/gu, ''))) c += 2.4;
        }
        if (c < cost[j]) { cost[j] = c; from[j] = i; }
      }
    }
    const out = [];
    for (let j = n; j > 0; j = from[j]) out.unshift([from[j], j]);
    return out;
  }

  SS.buildPages = function (lines, s) {
    const words = [];
    const pages = [];
    (lines || []).forEach((ln, li) => {
      const ws = (ln.words || []).filter((w) => w && w.t && isFinite(w.s) && isFinite(w.e));
      if (!ws.length) return;
      const base = words.length;
      ws.forEach((w, i) => words.push({ ...w, li, gi: base + i }));
      const chunks = s.display === 'pages' ? chunkLine(ws, Math.max(1, s.maxWords | 0)) : [[0, ws.length]];
      chunks.forEach(([a, b], k) => {
        const idx = [];
        for (let i = a; i < b; i++) idx.push(base + i);
        pages.push({ id: `${li}.${k}`, li, words: idx, s: words[idx[0]].s, e: words[idx[idx.length - 1]].e });
      });
    });
    pages.sort((a, b) => a.s - b.s);
    // display windows
    for (const p of pages) {
      p.start = p.s - s.leadIn;
      p.end = Math.max(p.e + s.hold, p.start + s.minDur);
    }
    for (let i = 0; i < pages.length; i++) {
      const p = pages[i], nx = pages[i + 1];
      if (i > 0 && p.start < pages[i - 1].end) p.start = Math.max(pages[i - 1].s, pages[i - 1].end);
      if (nx) {
        const nStart = nx.s - s.leadIn;
        if (nStart - p.end < s.gapFill) p.end = nStart;
        if (p.end > nStart) p.end = Math.max(p.s + 0.05, nStart);
      }
      if (p.start < 0) p.start = 0;
    }
    return { words, pages };
  };

  /* ------------------------------------------------------------ class -- */
  class Renderer {
    constructor() {
      this.lines = [];
      this.style = { ...SS.DEFAULT_STYLE };
      this.W = 1080; this.H = 1920;
      this._dirty = true;
      this.layoutCache = new Map();
    }
    setLines(lines) { this.lines = lines || []; this._dirty = true; }
    setStyle(style) { this.style = { ...SS.DEFAULT_STYLE, ...style }; this._dirty = true; }
    setSize(W, H) { if (W !== this.W || H !== this.H) { this.W = W; this.H = H; this._dirty = true; } }
    invalidate() { this._dirty = true; }

    _prepare() {
      if (!this._dirty) return;
      const b = SS.buildPages(this.lines, this.style);
      this.words = b.words; this.pages = b.pages;
      this.layoutCache.clear();
      this._dirty = false;
    }

    pageIndexAt(t) {
      this._prepare();
      const P = this.pages;
      let lo = 0, hi = P.length - 1, ans = -1;
      while (lo <= hi) {
        const m = (lo + hi) >> 1;
        if (P[m].start <= t) { ans = m; lo = m + 1; } else hi = m - 1;
      }
      if (ans >= 0 && t < P[ans].end) return ans;
      return -1;
    }

    font(px, s = this.style) {
      return `${s.italic ? 'italic ' : ''}${s.weight} ${px.toFixed(2)}px "${s.font}", "Montserrat", system-ui, sans-serif`;
    }

    /* ------------------------------------------------------ layout -- */
    layout(ctx, pi) {
      const key = pi;
      const hit = this.layoutCache.get(key);
      if (hit) return hit;
      const s = this.style, W = this.W, H = this.H;
      const page = this.pages[pi];
      let fontPx = (s.size / 100) * H;
      const items = page.words.map((gi) => {
        const w = this.words[gi];
        let sc = 1;
        if (s.loudSize > 0) sc *= clamp(1 + s.loudSize * (w.l - 0.5) * 1.3, 0.65, 1.7);
        if (w.k) sc *= s.keyScale || 1;
        return { gi, text: shapeText(w.t, s), sc };
      });
      const measure = (px) => {
        ctx.font = this.font(px);
        try { ctx.letterSpacing = (s.tracking * px).toFixed(2) + 'px'; } catch (e) { /* older browsers */ }
        for (const it of items) it.w = ctx.measureText(it.text).width * it.sc;
        // a thick outline eats into the gap between words; give that space back
        const space = ctx.measureText(' ').width * s.wordGap + s.stroke * px * 1.1
          + (s.highlight === 'box' ? s.boxPadX * px * 0.9 : 0);
        const capH = ctx.measureText('H').actualBoundingBoxAscent || px * 0.7;
        return { space, capH };
      };
      let m = measure(fontPx);
      const maxW = (s.maxWidth / 100) * W;

      const rowW = (a, b) => { let t = 0; for (let i = a; i < b; i++) t += items[i].w; return t + m.space * Math.max(0, b - a - 1); };
      const n = items.length;
      const split = () => {
        // best split into r rows: smallest widest row, slight preference for a shorter top row
        let best = null;
        const maxRows = Math.max(1, Math.min(s.maxRows | 0, n));
        for (let r = 1; r <= maxRows; r++) {
          const cand = [];
          const rec = (start, left, acc) => {
            if (left === 1) { cand.push([...acc, [start, n]]); return; }
            for (let k = start + 1; k <= n - left + 1; k++) rec(k, left - 1, [...acc, [start, k]]);
          };
          if (r === 1) cand.push([[0, n]]); else if (n <= 14) rec(0, r, []); else {
            // long lines: even split
            const per = Math.ceil(n / r); const rows = [];
            for (let i = 0; i < n; i += per) rows.push([i, Math.min(n, i + per)]);
            cand.push(rows);
          }
          for (const rows of cand) {
            const widths = rows.map(([a, b]) => rowW(a, b));
            const widest = Math.max(...widths);
            let score = widest;
            if (rows.length === 2 && widths[0] > widths[1]) score += (widths[0] - widths[1]) * 0.15;
            score += r * 0.01;
            const fits = widest <= maxW;
            if (!best || (fits && !best.fits) || (fits === best.fits && (fits ? r < best.r || (r === best.r && score < best.score) : widest < best.widest))) {
              best = { rows, widest, score, fits, r };
            }
          }
          if (best && best.fits && r >= 1 && best.r === r) break;
        }
        return best;
      };
      let best = split();
      let fit = 1;
      if (best.widest > maxW) {
        fit = maxW / best.widest;
        fontPx *= fit;
        m = measure(fontPx);
        best = { ...best, widest: Math.max(...best.rows.map(([a, b]) => rowW(a, b))) };
      }
      const rows = best.rows.map(([a, b]) => {
        const scMax = Math.max(...items.slice(a, b).map((it) => it.sc));
        return { a, b, w: rowW(a, b), h: fontPx * s.lineHeight * Math.max(1, scMax * 0.92) };
      });
      const blockW = Math.max(...rows.map((r) => r.w));
      const blockH = rows.reduce((t, r) => t + r.h, 0);
      const cx = (s.x / 100) * W, cy = (s.y / 100) * H;
      let left = s.align === 'left' ? cx : s.align === 'right' ? cx - blockW : cx - blockW / 2;
      const margin = W * 0.025;
      left = clamp(left, margin, Math.max(margin, W - margin - blockW));
      let top = clamp(cy - blockH / 2, H * 0.02, Math.max(H * 0.02, H * 0.98 - blockH));

      const words = [];
      let y = top;
      rows.forEach((r, ri) => {
        let x = s.align === 'left' ? left : s.align === 'right' ? left + blockW - r.w : left + (blockW - r.w) / 2;
        const midY = y + r.h / 2;
        for (let i = r.a; i < r.b; i++) {
          const it = items[i];
          words.push({ gi: it.gi, text: it.text, sc: it.sc, x, w: it.w, cx: x + it.w / 2, cy: midY, base: midY + m.capH / 2, row: ri, idx: i });
          x += it.w + m.space;
        }
        y += r.h;
      });
      const L = { words, fontPx, capH: m.capH, left, top, blockW, blockH, space: m.space };
      this.layoutCache.set(key, L);
      return L;
    }

    /* ------------------------------------------------------- render -- */
    // Returns a key describing what was drawn; identical keys = identical frames.
    render(ctx, t, pxScale = 1) {
      this._prepare();
      const s = this.style;
      this.animating = false;
      const pi = this.pageIndexAt(t);
      if (s.display === 'stack') return this._renderStack(ctx, t, pi, pxScale);
      if (pi < 0) return 'blank';
      const key = this._drawPage(ctx, pi, t, pxScale, {});
      return this.animating ? 'a' + t.toFixed(4) : key;
    }

    _renderStack(ctx, t, pi, px) {
      const s = this.style;
      // Between lines, keep nothing on screen (the gap bridge is in the page windows).
      if (pi < 0) return 'blank';
      const P = this.pages;
      const cur = P[pi];
      const Lc = this.layout(ctx, pi);
      const gapY = Lc.fontPx * 0.32;
      const k = s.inDur > 0 ? clamp((t - cur.start) / s.inDur) : 1;
      const kk = ease.outCubic(k);
      if (k < 1) this.animating = true;
      // previous line (only while sliding away, and only if it was just on screen).
      // The stack moves as one piece: this line rises from the preview slot it
      // sat in under the previous line, and the previous line rises off above.
      const prev = pi > 0 && P[pi - 1].end >= cur.start - 0.05 ? pi - 1 : -1;
      let shift = 0;
      if (prev >= 0) {
        const Lp = this.layout(ctx, prev);
        const shift0 = Lp.top + Lp.blockH + gapY - Lc.top;
        shift = (1 - kk) * shift0;
        const dy = Lc.top + shift - Lp.blockH - gapY - Lp.top;
        if (k < 1) this._drawPage(ctx, prev, t, px, { dy, alpha: (1 - kk) * 0.7, forcePast: true, noEntrance: true, noExit: true });
      } else {
        shift = (1 - kk) * Lc.fontPx * 0.5;
      }
      const nxt = P[pi + 1];
      const contiguous = !!nxt && nxt.start <= cur.end + 0.05;
      const key = this._drawPage(ctx, pi, t, px, { dy: shift, alpha: prev >= 0 ? 1 : kk, noEntrance: true, noExit: contiguous });
      // upcoming lines, dimmed, stacked below
      let yOff = Lc.blockH + gapY;
      for (let n = 1; n <= (s.nextLines | 0); n++) {
        const ni = pi + n;
        if (ni >= P.length) break;
        const Ln = this.layout(ctx, ni);
        const dy = Lc.top + yOff - Ln.top + shift;
        this._drawPage(ctx, ni, t, px, { dy, alpha: (prev >= 0 ? 1 : kk) * Math.pow(0.75, n - 1), forceFuture: true, noEntrance: true });
        yOff += Ln.blockH + gapY;
      }
      return this.animating ? 'a' + t.toFixed(4) : 'S' + key;
    }

    _drawPage(ctx, pi, t, px, o) {
      const s = this.style;
      const page = this.pages[pi];
      const L = this.layout(ctx, pi);
      const f = L.fontPx;
      const words = this.words;
      const alphaAll = o.alpha == null ? 1 : o.alpha;
      const dyAll = o.dy || 0;

      // active word = last word that has started
      let active = -1;
      if (!o.forceFuture && !o.forcePast) {
        for (let i = 0; i < page.words.length; i++) if (words[page.words[i]].s <= t) active = i;
      }
      // page entrance / exit
      const pageIn = s.reveal === 'page' && !o.noEntrance && s.inDur > 0 ? clamp((t - page.start) / s.inDur) : 1;
      const pageOut = s.outAnim !== 'none' && s.outDur > 0 && !o.forceFuture && !o.noExit ? clamp((t - (page.end - s.outDur)) / s.outDur) : 0;
      if ((pageIn > 0 && pageIn < 1) || (pageOut > 0 && pageOut < 1)) this.animating = true;
      const outA = s.outAnim === 'none' ? 1 : 1 - ease.outCubic(pageOut);
      let outDy = 0, outBlur = 0, outSc = 1;
      if (s.outAnim === 'rise') outDy = -ease.inOutCubic(pageOut) * f * 0.45;
      if (s.outAnim === 'blur') outBlur = pageOut * f * 0.2;
      if (s.outAnim === 'shrink') outSc = 1 - 0.25 * ease.inOutCubic(pageOut);

      // backdrop
      if (s.backdrop) {
        const a0 = s.reveal === 'page' ? ease.outCubic(pageIn) : 1;
        ctx.save();
        ctx.globalAlpha = s.backdropOpacity * alphaAll * outA * a0;
        ctx.fillStyle = s.backdropColor;
        const px0 = s.backdropPadX * f, py0 = s.backdropPadY * f;
        roundRect(ctx, L.left - px0, L.top - py0 + dyAll + outDy, L.blockW + px0 * 2, L.blockH + py0 * 2, s.backdropRadius * f);
        ctx.fill();
        ctx.restore();
      }

      // per-word state
      const st = L.words.map((lw) => {
        const w = words[lw.gi];
        const i = lw.idx;
        const isActive = i === active;
        const future = o.forceFuture || (!o.forcePast && w.s > t);
        // when this word stopped being the active one
        const nextW = page.words[i + 1] != null ? words[page.words[i + 1]] : null;
        const offAt = nextW ? nextW.s : Infinity;
        let enter = 1;
        if (!o.noEntrance) {
          if (s.reveal === 'word') {
            const startAt = w.s - 0.03;
            if (t < startAt && !o.forcePast) enter = -1;          // not yet on screen
            else enter = s.inDur > 0 ? clamp((t - startAt) / s.inDur) : 1;
          } else {
            enter = s.inDur > 0 ? clamp((t - page.start - i * s.inStagger) / s.inDur) : 1;
          }
        }
        if (enter > 0 && enter < 1) this.animating = true;
        return { lw, w, i, isActive, future, offAt, enter };
      });

      // box / underline behind the active word
      if ((s.highlight === 'box' || s.highlight === 'underline') && active >= 0) {
        const cur = st[active];
        const rect = (x) => this._boxRect(x, f, s);
        let R = rect(cur);
        const slide = s.boxSlide > 0 ? clamp((t - cur.w.s) / s.boxSlide) : 1;
        if (active > 0 && slide < 1) {
          const P0 = rect(st[active - 1]);
          const k = ease.outCubic(slide);
          R = { x: lerp(P0.x, R.x, k), y: lerp(P0.y, R.y, k), w: lerp(P0.w, R.w, k), h: lerp(P0.h, R.h, k) };
          this.animating = true;
        } else if (active === 0 && slide < 1) {
          const k = ease.outBack(slide);
          const sc = lerp(0.6, 1, k);
          R = { x: R.x + R.w * (1 - sc) / 2, y: R.y + R.h * (1 - sc) / 2, w: R.w * sc, h: R.h * sc };
          this.animating = true;
        }
        const aSc = this._activeScale(cur, t);
        if (aSc !== 1) {
          const cx = R.x + R.w / 2, cy = R.y + R.h / 2;
          R = { x: cx - (R.w * aSc) / 2, y: cy - (R.h * aSc) / 2, w: R.w * aSc, h: R.h * aSc };
        }
        ctx.save();
        ctx.globalAlpha = alphaAll * outA * clamp(cur.enter < 0 ? 0 : cur.enter * 2);
        ctx.fillStyle = s.boxColor;
        if (s.shadow && s.shadowOpacity > 0 && s.highlight === 'box') {
          ctx.shadowColor = rgba(s.shadowColor, s.shadowOpacity * 0.6);
          ctx.shadowBlur = s.shadowBlur * f * px;
          ctx.shadowOffsetY = s.shadowY * f * px;
        }
        roundRect(ctx, R.x, R.y + dyAll + outDy, R.w, R.h, s.highlight === 'box' ? s.boxRadius * f : R.h / 2);
        ctx.fill();
        ctx.restore();
      }

      const keyParts = [page.id, active];
      for (const x of st) {
        if (x.enter < 0) continue;
        keyParts.push(x.i);
        this._drawWord(ctx, x, t, f, px, { alphaAll, dyAll: dyAll + outDy, outA, outBlur, outSc, pageIn, L });
      }
      return keyParts.join(':');
    }

    _boxRect(x, f, s) {
      const lw = x.lw;
      const sc = lw.sc;
      if (s.highlight === 'underline') {
        const h = Math.max(2, f * 0.09);
        return { x: lw.x - f * 0.02, y: lw.base + f * 0.12, w: lw.w + f * 0.04, h };
      }
      const padX = s.boxPadX * f, padY = s.boxPadY * f;
      const capH = (f * 0.72) * sc;
      const h = capH + f * 0.36 * sc + padY * 2;
      return { x: lw.x - padX, y: lw.cy - h / 2 - f * 0.01, w: lw.w + padX * 2, h };
    }

    _activeScale(x, t) {
      const s = this.style;
      if (s.activeScale === 1 && s.activeLift === 0) return 1;
      if (x.isActive) {
        const p = s.activeDur > 0 ? clamp((t - x.w.s) / s.activeDur) : 1;
        if (p < 1) this.animating = true;
        return lerp(1, s.activeScale, ease.outBack(p));
      }
      if (!x.future && isFinite(x.offAt) && t >= x.offAt) {
        const p = s.activeDur > 0 ? clamp((t - x.offAt) / s.activeDur) : 1;
        if (p < 1) { this.animating = true; return lerp(s.activeScale, 1, ease.outCubic(p)); }
      }
      return 1;
    }

    _activeEnvelope(x, t) {
      const s = this.style;
      if (x.isActive) {
        const p = s.activeDur > 0 ? clamp((t - x.w.s) / s.activeDur) : 1;
        return ease.outCubic(p);
      }
      if (!x.future && isFinite(x.offAt) && t >= x.offAt) {
        const p = s.activeDur > 0 ? clamp((t - x.offAt) / s.activeDur) : 1;
        return 1 - ease.outCubic(p);
      }
      return 0;
    }

    _drawWord(ctx, x, t, f, px, g) {
      const s = this.style;
      const { lw, w } = x;
      let alpha = g.alphaAll * g.outA;
      let sc = lw.sc * g.outSc;
      let dy = g.dyAll, dx = 0, blur = g.outBlur, rot = 0;
      let chars = null;

      // entrance
      const p = x.enter;
      if (p < 1) {
        switch (s.inAnim) {
          case 'fade': alpha *= ease.outCubic(p); break;
          case 'pop': sc *= lerp(0.55, 1, ease.outBack(p)); alpha *= clamp(p * 3); break;
          case 'rise': dy += (1 - ease.outCubic(p)) * f * 0.5; alpha *= ease.outCubic(p); break;
          case 'drop': dy -= (1 - ease.outCubic(p)) * f * 0.6; alpha *= ease.outCubic(p); break;
          case 'slam': { const e = Math.exp(-5.5 * p) * Math.cos(8 * p); sc *= 1 + 0.8 * e * (1 - p); alpha *= clamp(p * 5); break; }
          case 'blur': blur += (1 - ease.outCubic(p)) * f * 0.22; alpha *= ease.outCubic(p); dy += (1 - ease.outCubic(p)) * f * 0.08; break;
          case 'typewriter': chars = Math.max(1, Math.ceil(lw.text.length * p)); break;
          default: break;
        }
      }
      // spoken-word growth / lift
      if (s.activeScale !== 1) sc *= this._activeScale(x, t);
      if (s.activeLift) dy -= s.activeLift * f * this._activeEnvelope(x, t);
      // emphasis
      if (s.jitter) rot = (rand(w.gi + 1) * 2 - 1) * s.jitter * Math.PI / 180;
      if (s.shake && w.l >= (s.loudThreshold || 0.75) && x.isActive) {
        const since = t - w.s;
        if (since < 0.35) {
          const decay = Math.exp(-since * 9);
          dx += Math.sin(since * 95) * s.shake * f * decay;
          dy += Math.cos(since * 77) * s.shake * f * 0.6 * decay;
          this.animating = true;
        }
      }

      // colours
      let fill = s.color;
      let dim = 1;
      if (x.future) {
        if (s.highlight !== 'wipe') fill = s.color;
        dim = s.reveal === 'page' ? s.futureOpacity : 1;
      } else if (!x.isActive && s.pastColor) fill = s.pastColor;
      if (w.k) fill = s.keyColor;
      if (s.loudColorOn && w.l >= s.loudThreshold && !x.future) fill = s.loudColor;
      if (x.isActive) {
        if (s.highlight === 'color') fill = s.activeColor;
        if (s.highlight === 'box') fill = s.boxText;
      }
      if (alpha <= 0.001) return;

      const text = chars != null ? lw.text.slice(0, chars) : lw.text;
      ctx.save();
      ctx.translate(lw.cx + dx, lw.cy + dy);
      if (rot) ctx.rotate(rot);
      if (sc !== 1) ctx.scale(sc, sc);
      ctx.translate(-lw.w / lw.sc / 2, 0);
      // baseline offset relative to centre; word scale is applied via ctx.scale
      const by = (lw.base - lw.cy) / 1;
      ctx.font = this.font(f);
      try { ctx.letterSpacing = (s.tracking * f).toFixed(2) + 'px'; } catch (e) { /* noop */ }
      ctx.textBaseline = 'alphabetic';
      ctx.textAlign = 'left';
      ctx.lineJoin = 'round';
      ctx.miterLimit = 2;
      if (blur > 0.3) ctx.filter = `blur(${(blur * px).toFixed(2)}px)`;
      const baseA = alpha;

      const onBox = s.highlight === 'box' && x.isActive;
      const strokeW = onBox ? 0 : s.stroke * f * 2;
      const scaleFx = px * Math.abs(sc);   // shadows ignore the canvas transform
      // 1. shadow
      if (s.shadow && s.shadowOpacity > 0 && !onBox) {
        ctx.globalAlpha = baseA * (x.future ? Math.max(dim, 0.25) : 1);
        ctx.shadowColor = rgba(s.shadowColor, s.shadowOpacity);
        ctx.shadowBlur = s.shadowBlur * f * scaleFx;
        ctx.shadowOffsetX = s.shadowX * f * scaleFx;
        ctx.shadowOffsetY = s.shadowY * f * scaleFx;
        if (strokeW > 0) {
          ctx.strokeStyle = s.strokeColor; ctx.lineWidth = strokeW; ctx.strokeText(text, 0, by);
        } else {
          ctx.fillStyle = rgba(fill, 1); ctx.fillText(text, 0, by);
        }
        ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; ctx.shadowOffsetX = 0; ctx.shadowOffsetY = 0;
      }
      // 2. glow
      const glowOn = s.glow && (!s.glowActiveOnly || x.isActive || (s.highlight === 'wipe' && !x.future));
      if (glowOn) {
        let gk = 1;
        if (s.glowActiveOnly && s.highlight !== 'wipe') gk = this._activeEnvelope(x, t) || (x.isActive ? 1 : 0);
        if (s.highlight === 'wipe' && !x.isActive && s.glowActiveOnly) gk = 0.35;
        if (gk > 0) {
          ctx.globalAlpha = baseA * s.glowStrength * gk;
          ctx.shadowColor = s.glowColor;
          ctx.shadowBlur = s.glowSize * f * scaleFx;
          ctx.fillStyle = s.glowColor;
          ctx.fillText(text, 0, by);
          ctx.fillText(text, 0, by);
          ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0;
        }
      }
      // 3. outline
      if (strokeW > 0) {
        ctx.globalAlpha = baseA * (x.future ? Math.max(dim, 0) : 1);
        ctx.strokeStyle = s.strokeColor; ctx.lineWidth = strokeW;
        ctx.strokeText(text, 0, by);
      }
      // 4. fill
      if (s.highlight === 'wipe') {
        const sung = x.future ? 0 : x.isActive ? clamp((t - w.s) / Math.max(0.05, w.e - w.s)) : 1;
        if (x.isActive && sung < 1) this.animating = true;
        const wTxt = lw.w / lw.sc;
        if (sung < 1) {
          ctx.globalAlpha = baseA * s.futureOpacity;
          ctx.fillStyle = s.color; ctx.fillText(text, 0, by);
        }
        if (sung > 0) {
          const c = w.k ? s.keyColor : (s.loudColorOn && w.l >= s.loudThreshold ? s.loudColor : s.activeColor);
          ctx.globalAlpha = baseA;
          if (sung >= 1) {
            ctx.fillStyle = c;
          } else {
            // soft leading edge, so the fill reads as sung rather than stamped
            const edge = wTxt * sung, soft = Math.max(f * 0.09, 1);
            const gr = ctx.createLinearGradient(edge - soft, 0, edge + soft, 0);
            gr.addColorStop(0, rgba(c, 1));
            gr.addColorStop(1, rgba(c, 0));
            ctx.fillStyle = gr;
          }
          ctx.fillText(text, 0, by);
        }
      } else {
        ctx.globalAlpha = baseA * dim;
        ctx.fillStyle = fill;
        ctx.fillText(text, 0, by);
      }
      ctx.restore();
    }
  }

  function roundRect(ctx, x, y, w, h, r) {
    r = Math.max(0, Math.min(r, h / 2, w / 2));
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  SS.Renderer = Renderer;
  SS.rgba = rgba;
  SS.roundRect = roundRect;
})();
