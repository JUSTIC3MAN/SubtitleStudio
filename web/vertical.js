/* ==========================================================================
   vertical.js - turn a wide (16:9) video into a 9:16 vertical version.

   Five layouts, all described by one geometry function so the live preview
   and the ffmpeg export use exactly the same numbers:

     fill    crop to full height, choose what part of the width to keep
     blur    whole frame, a blurred enlarged copy fills the empty space
     bars    whole frame on a solid colour, captions in the bar below
     zoom    frame enlarged ~1.45x (sides trimmed) on a blur: bigger subject
     stack   whole frame on top, a close-up crop of it below

   All positions are in output pixels (1080x1920) and source pixels.
   ========================================================================== */
(function () {
  const SS = (window.SS = window.SS || {});
  const W = 1080, H = 1920;
  // the band every app leaves clear (Reels is the tightest: 210 top, 310 bottom)
  const SAFE_TOP = 210, SAFE_BOTTOM = H - 310;

  SS.VLAYOUTS = [
    { id: 'blur', name: 'Fit + blur', blurb: 'Nothing cut off. A soft blurred copy fills the space, captions sit underneath.' },
    { id: 'fill', name: 'Fill', blurb: 'Full-screen vertical. Keeps about a third of the width - best when you are in the middle.' },
    { id: 'zoom', name: 'Zoom fit', blurb: 'Frame enlarged with the edges trimmed: a bigger you, captions underneath.' },
    { id: 'bars', name: 'Cinema bars', blurb: 'Whole frame on a solid colour. Clean, lyric-video look with captions in the bar.' },
    { id: 'stack', name: 'Stack', blurb: 'Wide shot on top, a close-up of it underneath. Captions on the seam.' },
  ];

  SS.VDEFAULT = {
    layout: 'blur',
    videoY: 0.40,     // where the middle of the video sits (fraction of height)
    pan: 0.5,         // fill / zoom / stack: which part of the width to keep (0 left, 1 right)
    zoom: 1.45,       // zoom: enlargement over fit;  stack: how close the close-up is
    blur: 48,         // background blur, output px
    dim: 0.35,        // background darkening 0..1
    barColor: '#000000',
    capMode: 'auto',  // auto = captions go in the empty space;  manual = where you drag them
  };

  const ev = (x) => Math.max(2, Math.round(x / 2) * 2);
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

  /**
   * Geometry for one layout.
   * Returns { bg:'blur'|'color', bgColor, blur, dim, bgCrop:{sx,sy,sw,sh}, panes:[...], capY, band }
   * capY: suggested caption centre (output px) or null to keep the look's own height.
   */
  SS.verticalGeometry = function (v, sw, sh) {
    v = { ...SS.VDEFAULT, ...(v || {}) };
    const g = { srcW: sw, srcH: sh, W, H, bg: v.layout === 'bars' ? 'color' : 'blur', bgColor: v.barColor,
      blur: v.blur, dim: v.dim, panes: [], capY: null, band: null };
    // cover crop for the blurred background
    const coverW = Math.min(sw, sh * W / H), coverH = Math.min(sh, sw * H / W);
    g.bgCrop = { sx: Math.round((sw - coverW) / 2), sy: Math.round((sh - coverH) / 2), sw: ev(coverW), sh: ev(coverH) };

    const fitH = W * sh / sw;            // height of the whole frame at full width
    const placeY = (dh) => clamp(H * v.videoY - dh / 2, 0, H - dh);
    const below = (y1) => {               // caption spot under the video, else above it
      const lo = y1, hi = SAFE_BOTTOM;
      if (hi - lo >= 170) return { y: (lo + hi) / 2, band: [lo, hi] };
      return null;
    };

    if (v.layout === 'fill') {
      const vw = Math.min(sw, sh * W / H);
      const vh = vw * H / W;
      g.panes.push({ sx: Math.round((sw - vw) * v.pan), sy: Math.round((sh - vh) / 2), sw: ev(vw), sh: ev(vh), dx: 0, dy: 0, dw: W, dh: H });
      return g;
    }
    if (v.layout === 'blur' || v.layout === 'bars') {
      const dh = ev(fitH), dy = Math.round(placeY(dh));
      g.panes.push({ sx: 0, sy: 0, sw: ev(sw), sh: ev(sh), dx: 0, dy, dw: W, dh });
      const b = below(dy + dh) || { y: (SAFE_TOP + dy) / 2, band: [SAFE_TOP, dy] };
      g.capY = b.y; g.band = b.band;
      return g;
    }
    if (v.layout === 'zoom') {
      const z = clamp(v.zoom, 1, 3);
      const cw = sw / z;
      const dh = ev(fitH * z), dy = Math.round(placeY(dh));
      g.panes.push({ sx: Math.round((sw - cw) * v.pan), sy: 0, sw: ev(cw), sh: ev(sh), dx: 0, dy, dw: W, dh });
      const b = below(dy + dh) || { y: (SAFE_TOP + dy) / 2, band: [SAFE_TOP, dy] };
      g.capY = b.y; g.band = b.band;
      return g;
    }
    // stack: whole frame at the top of the safe area, close-up filling the rest
    const dh1 = ev(fitH), dy1 = Math.round(Math.min(SAFE_TOP, H * 0.11));
    const top2 = dy1 + dh1, dh2 = H - top2;
    g.panes.push({ sx: 0, sy: 0, sw: ev(sw), sh: ev(sh), dx: 0, dy: dy1, dw: W, dh: dh1 });
    let ch = sh / clamp(v.zoom, 1, 3), cw = ch * W / dh2;
    if (cw > sw) { cw = sw; ch = cw * dh2 / W; }
    g.panes.push({ sx: Math.round((sw - cw) * v.pan), sy: Math.round((sh - ch) * 0.35), sw: ev(cw), sh: ev(ch), dx: 0, dy: top2, dw: W, dh: ev(dh2) });
    g.capY = top2; g.band = [top2 - 120, top2 + 120];
    return g;
  };

  /**
   * Draw the vertical frame for the preview. ctx is in device pixels, k = device px
   * per output px. The blur is done on a 1/8-size canvas, exactly as the export does.
   */
  const small = document.createElement('canvas');
  small.width = W / 8; small.height = H / 8;
  const sctx = small.getContext('2d');

  SS.drawVertical = function (ctx, src, g, k) {
    const vw = src.videoWidth || src.naturalWidth || src.width, vh = src.videoHeight || src.naturalHeight || src.height;
    const fx = vw / g.srcW, fy = vh / g.srcH;          // preview proxy may be smaller than the original
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (g.bg === 'blur' && vw) {
      const sig = g.blur / 8, pad = sig * 2;
      sctx.filter = `blur(${sig}px)`;
      const c = g.bgCrop;
      sctx.drawImage(src, c.sx * fx, c.sy * fy, c.sw * fx, c.sh * fy, -pad, -pad, small.width + pad * 2, small.height + pad * 2);
      sctx.filter = 'none';
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(small, 0, 0, W * k, H * k);
      if (g.dim > 0) { ctx.fillStyle = `rgba(0,0,0,${g.dim})`; ctx.fillRect(0, 0, W * k, H * k); }
    } else {
      ctx.fillStyle = g.bgColor || '#000';
      ctx.fillRect(0, 0, W * k, H * k);
    }
    if (vw) for (const p of g.panes) {
      ctx.drawImage(src, p.sx * fx, p.sy * fy, p.sw * fx, p.sh * fy, p.dx * k, p.dy * k, p.dw * k, p.dh * k);
    }
    ctx.restore();
  };

  /** Tiny diagram of a layout for its button. */
  SS.verticalIcon = function (id) {
    const g = SS.verticalGeometry({ layout: id }, 1920, 1080);
    const s = 40 / W;
    const bg = g.bg === 'blur' ? '<rect width="40" height="71" rx="4" fill="#3a3d45"/>' : '<rect width="40" height="71" rx="4" fill="#0b0b0c" stroke="#3a3d45"/>';
    const panes = g.panes.map((p, i) => `<rect x="${p.dx * s}" y="${p.dy * s}" width="${p.dw * s}" height="${p.dh * s}" fill="${i ? '#8d8f97' : '#c9cad0'}"/>`).join('');
    const cap = g.capY != null ? `<rect x="8" y="${g.capY * s - 1.5}" width="24" height="3" rx="1.5" fill="#f2d64b"/>`
      : `<rect x="8" y="${0.63 * 71 - 1.5}" width="24" height="3" rx="1.5" fill="#f2d64b"/>`;
    return `<svg viewBox="0 0 40 71" width="40" height="71" aria-hidden="true">${bg}${panes}${cap}</svg>`;
  };

  /** Numbers the server needs to build the same frame with ffmpeg. */
  SS.verticalForExport = function (g) {
    return { bg: g.bg, bgColor: g.bgColor, blur: g.blur, dim: g.dim, bgCrop: g.bgCrop, panes: g.panes };
  };
})();
