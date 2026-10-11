/* ==========================================================================
   timeline.js - waveform, caption lines and word blocks you can drag.

   Drag a word's edge to move where it starts or ends, drag the word to slide
   it, drag the line bar to slide the whole line. Wheel scrolls; Ctrl+wheel
   zooms around the pointer. Click anywhere above the words to seek.
   ========================================================================== */
(function () {
  const SS = (window.SS = window.SS || {});
  const RULER = 20, WAVE = 46, LINE = 18, WORD = 30, PAD = 6;

  class Timeline {
    constructor(canvas, opts) {
      this.c = canvas;
      this.ctx = canvas.getContext('2d');
      this.o = opts;                // { getLines, getTime, seek, onEdit(kind), onPick(li, wi), onDblWord(li) }
      this.duration = 1;
      this.peaks = null;
      this.view = 0;                // seconds at left edge
      this.pps = 90;                // pixels per second
      this.follow = true;
      this.hover = null;
      this.drag = null;
      this.sel = null;              // {li, wi}
      this._bind();
      new ResizeObserver(() => this.resize()).observe(canvas.parentElement);
      this.resize();
    }

    setDuration(d) { this.duration = Math.max(0.5, d || 1); this.clampView(); this.draw(); }
    setPeaks(p) { this.peaks = p; this.draw(); }
    resize() {
      const r = this.c.parentElement.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      this.w = Math.max(100, r.width); this.h = Math.max(60, r.height);
      this.c.width = Math.round(this.w * dpr); this.c.height = Math.round(this.h * dpr);
      this.c.style.width = this.w + 'px'; this.c.style.height = this.h + 'px';
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.draw();
    }
    x(t) { return (t - this.view) * this.pps; }
    t(x) { return this.view + x / this.pps; }
    clampView() {
      const span = this.w / this.pps;
      this.view = Math.max(0, Math.min(this.view, Math.max(0, this.duration - span * 0.9)));
    }
    zoomTo(pps, anchorX = this.w / 2) {
      const tAnchor = this.t(anchorX);
      this.pps = Math.max(8, Math.min(900, pps));
      this.view = tAnchor - anchorX / this.pps;
      this.clampView();
      this.draw();
    }
    reveal(t) {
      const span = this.w / this.pps;
      if (t < this.view || t > this.view + span * 0.88) {
        this.view = Math.max(0, t - span * 0.12);
        this.clampView();
      }
    }

    /* ----------------------------------------------------------- hit -- */
    hit(mx, my) {
      const lines = this.o.getLines();
      const yLine = RULER + WAVE + PAD, yWord = yLine + LINE + 4;
      if (my >= yWord && my <= yWord + WORD) {
        for (let li = 0; li < lines.length; li++) {
          const ws = lines[li].words;
          if (!ws.length || this.x(ws[ws.length - 1].e) < -10 || this.x(ws[0].s) > this.w + 10) continue;
          for (let wi = 0; wi < ws.length; wi++) {
            const a = this.x(ws[wi].s), b = this.x(ws[wi].e);
            if (mx >= a - 4 && mx <= b + 4) {
              const edge = mx - a < 6 && b - a > 14 ? 's' : b - mx < 6 && b - a > 14 ? 'e' : (b - a <= 14 ? (mx < (a + b) / 2 ? 's' : 'e') : 'm');
              if (mx < a || mx > b) { if (mx < a) return { kind: 'word', li, wi, part: 's' }; return { kind: 'word', li, wi, part: 'e' }; }
              return { kind: 'word', li, wi, part: edge };
            }
          }
        }
      }
      if (my >= yLine && my < yLine + LINE) {
        for (let li = 0; li < lines.length; li++) {
          const ws = lines[li].words;
          if (!ws.length) continue;
          if (mx >= this.x(ws[0].s) && mx <= this.x(ws[ws.length - 1].e)) return { kind: 'line', li };
        }
      }
      if (my < yLine) return { kind: 'seek' };
      return null;
    }

    _bind() {
      const c = this.c;
      c.addEventListener('mousemove', (e) => {
        const r = c.getBoundingClientRect();
        const mx = e.clientX - r.left, my = e.clientY - r.top;
        if (this.drag) return this._dragMove(mx, e);
        const h = this.hit(mx, my);
        this.hover = h;
        c.style.cursor = !h ? 'default' : h.kind === 'seek' ? 'text' : h.kind === 'line' ? 'grab'
          : h.part === 'm' ? 'grab' : 'ew-resize';
        this.draw();
      });
      c.addEventListener('mouseleave', () => { if (!this.drag) { this.hover = null; this.draw(); } });
      c.addEventListener('mousedown', (e) => {
        const r = c.getBoundingClientRect();
        const mx = e.clientX - r.left, my = e.clientY - r.top;
        const h = this.hit(mx, my);
        if (!h) return;
        e.preventDefault();
        if (h.kind === 'seek') {
          this.o.seek(Math.max(0, Math.min(this.duration, this.t(mx))));
          this.drag = { kind: 'seek' };
        } else {
          const lines = this.o.getLines();
          const snapshot = JSON.parse(JSON.stringify(lines[h.li].words));
          this.drag = { ...h, x0: mx, t0: this.t(mx), orig: snapshot, moved: false };
          if (h.kind === 'word') { this.sel = { li: h.li, wi: h.wi }; this.o.onPick && this.o.onPick(h.li, h.wi); }
          else { this.sel = { li: h.li, wi: -1 }; this.o.onPick && this.o.onPick(h.li, -1); }
        }
        const up = () => {
          window.removeEventListener('mouseup', up);
          window.removeEventListener('mousemove', mm);
          const d = this.drag;
          this.drag = null;
          if (d && d.moved) this.o.onEdit && this.o.onEdit('timing', d.li, d.orig);
          this.draw();
        };
        const mm = (ev) => {
          const r2 = c.getBoundingClientRect();
          this._dragMove(ev.clientX - r2.left, ev);
        };
        window.addEventListener('mouseup', up);
        window.addEventListener('mousemove', mm);
      });
      c.addEventListener('dblclick', (e) => {
        const r = c.getBoundingClientRect();
        const h = this.hit(e.clientX - r.left, e.clientY - r.top);
        if (h && (h.kind === 'word' || h.kind === 'line')) this.o.onDblWord && this.o.onDblWord(h.li);
      });
      c.addEventListener('wheel', (e) => {
        e.preventDefault();
        const r = c.getBoundingClientRect();
        if (e.ctrlKey || e.metaKey || e.altKey) {
          this.zoomTo(this.pps * Math.exp(-e.deltaY * 0.0022), e.clientX - r.left);
        } else {
          const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
          this.view += d / this.pps;
          this.clampView();
          this.follow = false;
          clearTimeout(this._ft);
          this._ft = setTimeout(() => { this.follow = true; }, 2500);
          this.draw();
        }
      }, { passive: false });
    }

    _dragMove(mx, e) {
      const d = this.drag;
      if (!d) return;
      if (d.kind === 'seek') { this.o.seek(Math.max(0, Math.min(this.duration, this.t(mx)))); return; }
      const lines = this.o.getLines();
      const ln = lines[d.li];
      if (!ln) return;
      let dt = this.t(mx) - d.t0;
      if (!d.moved && Math.abs(mx - d.x0) < 3) return;
      d.moved = true;
      const prevEnd = d.li > 0 && lines[d.li - 1].words.length ? lines[d.li - 1].words.slice(-1)[0].e : 0;
      const nextStart = d.li + 1 < lines.length && lines[d.li + 1].words.length ? lines[d.li + 1].words[0].s : this.duration;
      const O = d.orig;
      const MIN = 0.04;
      if (d.kind === 'line') {
        dt = Math.max(prevEnd - O[0].s, Math.min(nextStart - O[O.length - 1].e, dt));
        ln.words.forEach((w, i) => { w.s = O[i].s + dt; w.e = O[i].e + dt; });
      } else {
        const i = d.wi, w = ln.words[i], o = O[i];
        const lo = i > 0 ? ln.words[i - 1].e : prevEnd;
        const hi = i + 1 < ln.words.length ? ln.words[i + 1].s : nextStart;
        if (d.part === 's') w.s = Math.max(lo, Math.min(o.e - MIN, o.s + dt));
        else if (d.part === 'e') w.e = Math.min(hi, Math.max(o.s + MIN, o.e + dt));
        else {
          const ddt = Math.max(lo - o.s, Math.min(hi - o.e, dt));
          w.s = o.s + ddt; w.e = o.e + ddt;
        }
      }
      this.o.onEdit && this.o.onEdit('live', d.li);
      this.draw();
    }

    /* ---------------------------------------------------------- draw -- */
    draw() {
      if (this._raf) return;
      this._raf = requestAnimationFrame(() => { this._raf = 0; this._draw(); });
    }

    _draw() {
      const ctx = this.ctx, W = this.w, H = this.h;
      const css = getComputedStyle(document.documentElement);
      const col = (n, f) => (css.getPropertyValue(n).trim() || f);
      const C = {
        bg: col('--tl-bg', '#141518'), grid: col('--line', '#33353b'), text: col('--dim', '#9b9a94'),
        wave: col('--tl-wave', '#4a4c53'), waveOn: col('--tl-wave-on', '#7d7f87'), hl: col('--hl', '#f2d64b'),
        word: col('--raised', '#26282d'), wordText: col('--text', '#ecebe6'), line: col('--tl-line', '#3a3d45'),
      };
      ctx.fillStyle = C.bg; ctx.fillRect(0, 0, W, H);
      const t0 = this.view, t1 = this.t(W);
      const now = this.o.getTime();

      // ruler
      const steps = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120];
      const step = steps.find((s) => s * this.pps >= 70) || 300;
      ctx.font = '11px "Instrument Sans", system-ui, sans-serif';
      ctx.textBaseline = 'middle';
      for (let s = Math.floor(t0 / step) * step; s <= t1; s += step) {
        const x = Math.round(this.x(s)) + 0.5;
        ctx.fillStyle = C.grid; ctx.fillRect(x, 0, 1, RULER - 6);
        ctx.fillStyle = C.text;
        ctx.fillText(fmt(s, step < 1), x + 4, RULER / 2 - 2);
      }

      // waveform
      const wy = RULER, wh = WAVE;
      if (this.peaks && this.peaks.length) {
        const per = 100;
        ctx.beginPath();
        for (let x = 0; x < W; x++) {
          const a = Math.floor(this.t(x) * per), b = Math.max(a + 1, Math.floor(this.t(x + 1) * per));
          let m = 0;
          for (let i = a; i < b && i < this.peaks.length; i++) if (i >= 0 && this.peaks[i] > m) m = this.peaks[i];
          const hgt = (m / 255) * (wh / 2 - 2);
          ctx.rect(x, wy + wh / 2 - hgt, 1, Math.max(1, hgt * 2));
        }
        ctx.fillStyle = C.wave; ctx.fill();
      } else {
        ctx.fillStyle = C.text; ctx.fillText('Drawing waveform...', 10, wy + wh / 2);
      }

      // lines + words
      const lines = this.o.getLines();
      const yLine = RULER + WAVE + PAD, yWord = yLine + LINE + 4;
      ctx.font = '12px "Instrument Sans", system-ui, sans-serif';
      for (let li = 0; li < lines.length; li++) {
        const ws = lines[li].words;
        if (!ws.length) continue;
        const a = this.x(ws[0].s), b = this.x(ws[ws.length - 1].e);
        if (b < 0 || a > W) continue;
        const activeLine = now >= ws[0].s && now <= ws[ws.length - 1].e;
        const hovered = this.hover && this.hover.li === li;
        ctx.fillStyle = lines[li]._dirty ? '#7a5b2a' : activeLine ? '#4b4d56' : C.line;
        rr(ctx, a, yLine, Math.max(2, b - a), LINE, 4); ctx.fill();
        if (hovered && this.hover.kind === 'line') { ctx.strokeStyle = C.hl; ctx.lineWidth = 1; ctx.stroke(); }
        ctx.save(); ctx.beginPath(); ctx.rect(a, yLine, Math.max(2, b - a), LINE); ctx.clip();
        ctx.fillStyle = C.text; ctx.fillText(String(li + 1), a + 5, yLine + LINE / 2 + 1);
        ctx.restore();
        for (let wi = 0; wi < ws.length; wi++) {
          const w = ws[wi];
          const x0 = this.x(w.s), x1 = this.x(w.e);
          if (x1 < 0 || x0 > W) continue;
          const on = now >= w.s && now < w.e;
          const sel = this.sel && this.sel.li === li && this.sel.wi === wi;
          ctx.fillStyle = on ? C.hl : C.word;
          rr(ctx, x0 + 0.5, yWord, Math.max(2, x1 - x0 - 1), WORD, 4); ctx.fill();
          if (sel || (this.hover && this.hover.kind === 'word' && this.hover.li === li && this.hover.wi === wi)) {
            ctx.strokeStyle = sel ? C.hl : C.text; ctx.lineWidth = sel ? 1.5 : 1; ctx.stroke();
            if (this.hover && this.hover.li === li && this.hover.wi === wi && this.hover.part !== 'm') {
              ctx.fillStyle = C.hl;
              const ex = this.hover.part === 's' ? x0 + 0.5 : x1 - 2.5;
              ctx.fillRect(ex, yWord + 4, 2, WORD - 8);
            }
          }
          if (x1 - x0 > 12) {
            ctx.save(); ctx.beginPath(); ctx.rect(x0 + 3, yWord, x1 - x0 - 6, WORD); ctx.clip();
            ctx.fillStyle = on ? '#1a1700' : C.wordText;
            ctx.fillText(w.t, x0 + 5, yWord + WORD / 2 + 1);
            ctx.restore();
          }
          if (w.k) { ctx.fillStyle = '#39ff14'; ctx.fillRect(x0 + 2, yWord + WORD - 3, Math.max(2, x1 - x0 - 4), 2); }
        }
      }

      // playhead
      const px = Math.round(this.x(now)) + 0.5;
      if (px >= 0 && px <= W) {
        ctx.fillStyle = C.hl; ctx.fillRect(px - 0.5, 0, 2, H);
        ctx.beginPath(); ctx.moveTo(px - 6, 0); ctx.lineTo(px + 7, 0); ctx.lineTo(px + 0.5, 8); ctx.closePath(); ctx.fill();
      }
    }
  }

  function rr(ctx, x, y, w, h, r) { SS.roundRect(ctx, x, y, w, h, r); }
  function fmt(s, fine) {
    const m = Math.floor(s / 60), sec = s - m * 60;
    return fine ? `${m}:${sec.toFixed(1).padStart(4, '0')}` : `${m}:${String(Math.floor(sec)).padStart(2, '0')}`;
  }

  SS.Timeline = Timeline;
  SS.fmtTime = fmt;
})();
