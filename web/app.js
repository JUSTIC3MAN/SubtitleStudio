/* ==========================================================================
   app.js - Subtitle Studio interface.

   home     drop a file, pick options, see recent projects
   editor   transcript (edit + re-sync), live preview, timeline, looks, export
   ========================================================================== */
(function () {
  const SS = window.SS;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /* ----------------------------------------------------------- server -- */
  async function api(method, url, body, raw) {
    const opt = { method, headers: {} };
    if (body !== undefined) {
      if (raw) opt.body = body;
      else { opt.body = JSON.stringify(body); opt.headers['Content-Type'] = 'application/json'; }
    }
    const r = await fetch(url, opt);
    let data = null;
    try { data = await r.json(); } catch (e) { /* empty */ }
    if (!r.ok) throw new Error((data && (data.detail || data.error)) || `${r.status} ${r.statusText}`);
    return data;
  }
  const GET = (u) => api('GET', u);
  const POST = (u, b) => api('POST', u, b === undefined ? {} : b);
  const PUT = (u, b) => api('PUT', u, b);
  const DEL = (u) => api('DELETE', u);

  function toast(msg, bad = false, ms = 3800) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.toggle('bad', bad);
    el.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { el.hidden = true; }, ms);
  }

  /* ------------------------------------------------------------ state -- */
  const S = {
    env: null, pid: null, project: null,
    lines: [], style: null, myLooks: [],
    W: 1080, H: 1920, duration: 0, kind: 'video',
    exportCfg: { aspect: '1080x1920', bgColor: '#101012' },
    undo: [], redo: [],
    editing: -1, sel: null,
    needsDraw: true, uid: 1,
    bgImage: null,
    view: 'wide', vert: { ...SS.VDEFAULT }, styles: { wide: null, vertical: null }, geo: null,
  };
  const renderer = new SS.Renderer();
  let timeline = null;
  const video = $('#video');

  /* ------------------------------------------------------------ fonts -- */
  const fontCache = new Set();
  async function ensureFont(st) {
    const k = `${st.italic ? 'italic ' : ''}${st.weight} 64px "${st.font}"`;
    if (fontCache.has(k)) return;
    try { await document.fonts.load(k, 'AaBbÁáÑñ'); } catch (e) { /* fall back silently */ }
    fontCache.add(k);
    renderer.invalidate();
    S.needsDraw = true;
  }

  /* ============================================================= HOME === */
  async function initHome() {
    try { S.env = await GET('/api/env'); } catch (e) { S.env = null; }
    fillOptionSelects();
    renderEnv();
    await loadRecent();
    playWordmark();
  }

  function fillOptionSelects() {
    const langs = (S.env && S.env.languages) || ['English', 'Spanish'];
    const langHTML = '<option value="auto">Detect automatically</option>' +
      langs.map((l) => `<option value="${l}">${l}</option>`).join('');
    $('#optLang').innerHTML = langHTML;
    $('#rtLang').innerHTML = langHTML;
    const qwenOK = !S.env || S.env.qwen.ok;
    const engines = (S.env && S.env.engines) || [{ key: 'qwen3-1.7b', label: 'Qwen3-ASR 1.7B' }];
    const engHTML = engines.map((e) => {
      const off = e.key.startsWith('qwen') && !qwenOK;
      const dl = e.cached === false ? ' (downloads on first use)' : '';
      return `<option value="${e.key}"${off ? ' disabled' : ''}>${esc(e.label)}${off ? ' - not installed' : dl}</option>`;
    }).join('');
    $('#optEngine').innerHTML = engHTML;
    $('#rtEngine').innerHTML = engHTML;
    const def = qwenOK ? 'qwen3-1.7b' : 'whisper-turbo';
    $('#optEngine').value = def; $('#rtEngine').value = def;
    if (S.env && !S.env.separation.ok) {
      $('#optSep').checked = false; $('#optSep').disabled = true;
      $('#rtSep').checked = false; $('#rtSep').disabled = true;
    }
  }

  function renderEnv() {
    const e = S.env;
    const el = $('#envStatus');
    if (!e) { el.innerHTML = '<span class="no">The local server is not answering. Is the black window still open?</span>'; return; }
    const g = e.gpu || {};
    const items = [];
    items.push(g.cuda ? `<span class="ok">${esc(g.gpu)} (${g.vram_gb} GB)</span>`
      : `<span class="no" title="${esc(g.error || '')}">${esc(g.message || 'No CUDA GPU')}</span>`);
    items.push(e.ffmpeg ? `<span class="ok">ffmpeg${e.nvenc ? ' + NVENC' : ''}</span>`
      : '<span class="no">ffmpeg missing: run  winget install Gyan.FFmpeg  then restart</span>');
    items.push(e.qwen.ok ? `<span class="ok">Qwen3-ASR ${e.engines[0].cached ? 'ready' : 'downloads on first use (~6.5 GB with the aligner)'}</span>`
      : `<span class="no" title="${esc(e.qwen.why)}">Qwen3-ASR not installed - Whisper will be used. Run setup.bat to fix.</span>`);
    items.push(e.separation.ok ? `<span class="ok">Vocal isolation ${e.separation.cached ? 'ready' : 'downloads on first use (~600 MB)'}</span>`
      : `<span class="no" title="${esc(e.separation.why)}">Vocal isolation not installed</span>`);
    el.innerHTML = items.join('');
  }

  async function loadRecent() {
    let list = [];
    try { list = await GET('/api/projects'); } catch (e) { /* none */ }
    $('#recentWrap').hidden = !list.length;
    $('#recent').innerHTML = list.slice(0, 12).map((p) => `
      <li data-id="${p.id}">
        <span class="rk">${p.kind === 'audio' ? '&#9835;' : '&#9654;'}</span>
        <span class="rn"><b>${esc(p.name || 'Untitled')}</b><small>${p.duration ? SS.fmtTime(p.duration) : ''} &nbsp; ${p.words ? p.words + ' words' : 'not transcribed'} &nbsp; ${new Date((p.updated || 0) * 1000).toLocaleDateString()}</small></span>
        <button class="btn small ghost rdel" data-del="${p.id}" title="Delete this project">Delete</button>
      </li>`).join('');
  }

  $('#recent').addEventListener('click', async (e) => {
    const del = e.target.closest('[data-del]');
    if (del) {
      e.stopPropagation();
      if (del.dataset.confirm !== '1') { del.dataset.confirm = '1'; del.textContent = 'Delete?'; setTimeout(() => { del.dataset.confirm = ''; del.textContent = 'Delete'; }, 2500); return; }
      await DEL('/api/projects/' + del.dataset.del);
      loadRecent();
      return;
    }
    const li = e.target.closest('li[data-id]');
    if (li) openEditor(li.dataset.id);
  });

  function playWordmark() {
    const c = $('#wordmark');
    const ctx = c.getContext('2d');
    const r = new SS.Renderer();
    r.setSize(c.width, c.height);
    r.setLines([{ words: [{ t: 'Subtitle', s: 0.25, e: 0.9, l: 0.5 }, { t: 'Studio', s: 0.95, e: 9.0, l: 0.5 }] }]);
    r.setStyle({
      ...SS.DEFAULT_STYLE, display: 'lines', maxRows: 1, maxWidth: 100, x: 1.2, y: 52, align: 'left',
      font: 'Poppins', weight: 800, size: 44, textCase: 'none', tracking: -0.035, wordGap: 0.9, punctuation: 'keep',
      color: '#ecebe6', highlight: 'box', boxColor: '#f2d64b', boxText: '#1c1800', boxRadius: 0.16, boxPadX: 0.12, boxPadY: 0.02, boxSlide: 0.32,
      stroke: 0, shadow: false, reveal: 'page', inAnim: 'rise', inDur: 0.5, inStagger: 0.08, activeScale: 1, outAnim: 'none',
      leadIn: 0.25, hold: 0, minDur: 1, gapFill: 0,
    });
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    document.fonts.load('800 80px "Poppins"').then(() => {
      r.invalidate();
      const t0 = performance.now();
      const step = () => {
        const t = reduce ? 3 : (performance.now() - t0) / 1000;
        ctx.clearRect(0, 0, c.width, c.height);
        r.render(ctx, Math.min(t, 3), 1);
        if (t < 3) requestAnimationFrame(step);
      };
      step();
    });
  }

  /* ------------------------------------------------------- upload -- */
  const drop = $('#drop');
  $('#btnChoose').addEventListener('click', () => $('#fileInput').click());
  drop.addEventListener('click', (e) => { if (e.target === drop) $('#fileInput').click(); });
  drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('#fileInput').click(); } });
  $('#fileInput').addEventListener('change', (e) => { const f = e.target.files[0]; if (f) startUpload(f); e.target.value = ''; });
  ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', (e) => { const f = e.dataTransfer.files[0]; if (f) startUpload(f); });
  // dropping anywhere on the home screen works too
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    if (!$('#home').hidden && e.target.closest('#drop') == null && e.dataTransfer.files[0]) startUpload(e.dataTransfer.files[0]);
  });

  function startUpload(file) {
    $('.drop-inner', drop).hidden = true;
    $('.drop-progress', drop).hidden = false;
    $('#dropFile').textContent = file.name;
    $('#uploadBar').style.width = '0%';
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/upload');
    xhr.setRequestHeader('X-Filename', encodeURIComponent(file.name));
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) $('#uploadBar').style.width = (e.loaded / e.total * 100).toFixed(1) + '%'; };
    xhr.onload = async () => {
      let data = null;
      try { data = JSON.parse(xhr.responseText); } catch (e) { /* noop */ }
      resetDrop();
      if (xhr.status !== 200) { toast((data && data.detail) || 'Upload failed', true, 7000); return; }
      const opts = {
        language: $('#optLang').value, engine: $('#optEngine').value, separate: $('#optSep').checked,
        lyrics: $('#optLyrics').value, hints: $('#optHints').value,
      };
      try {
        const job = await POST(`/api/projects/${data.id}/transcribe`, opts);
        const ok = await watchJob(job, { separate: opts.separate, lyrics: !!opts.lyrics.trim(), title: 'Working on ' + data.name });
        openEditor(data.id, ok ? null : 'failed');
      } catch (e) { toast(e.message, true, 8000); }
    };
    xhr.onerror = () => { resetDrop(); toast('Upload failed - is the server window still open?', true); };
    xhr.send(file);
  }
  function resetDrop() { $('.drop-inner', drop).hidden = false; $('.drop-progress', drop).hidden = true; }

  /* ------------------------------------------------------ job watcher -- */
  function watchJob(job, o = {}) {
    return new Promise((resolve) => {
      const ov = $('#processing');
      ov.hidden = false;
      $('#procTitle').textContent = o.title || 'Working on it';
      $('#procWarn').innerHTML = '';
      $('#procHide').hidden = true;
      $$('#procSteps li').forEach((li) => {
        li.className = '';
        const st = li.dataset.step;
        li.hidden = (st === 'vocals' && !o.separate) || (st === 'lyrics' && !o.lyrics) || (st === 'transcribe' && o.onlyLyrics);
      });
      const order = ['audio', 'vocals', 'transcribe', 'lyrics'];
      const tick = async () => {
        let j;
        try { j = await GET('/api/jobs/' + job.id); } catch (e) { setTimeout(tick, 1500); return; }
        $('#procBar').style.width = (j.progress * 100).toFixed(1) + '%';
        $('#procMsg').textContent = j.message || '';
        const cur = order.indexOf(j.step);
        $$('#procSteps li').forEach((li) => {
          const k = order.indexOf(li.dataset.step);
          li.className = j.state === 'done' || k < cur ? 'done' : k === cur ? 'on' : '';
        });
        $('#procWarn').innerHTML = (j.warnings || []).map((w) => `<li>${esc(w)}</li>`).join('');
        if (j.state === 'done') {
          if ((j.warnings || []).length) {
            $('#procHide').hidden = false;
            $('#procHide').textContent = 'Continue';
            $('#procHide').onclick = () => { ov.hidden = true; resolve(j); };
          } else { ov.hidden = true; resolve(j); }
          return;
        }
        if (j.state === 'error') {
          $('#procMsg').textContent = j.error;
          $('#procHide').hidden = false;
          $('#procHide').textContent = 'Close';
          $('#procHide').onclick = () => { ov.hidden = true; resolve(null); };
          return;
        }
        setTimeout(tick, 600);
      };
      tick();
    });
  }

  /* =========================================================== EDITOR === */
  async function openEditor(pid, note) {
    let j;
    try { j = await GET('/api/projects/' + pid); } catch (e) { toast(e.message, true); return; }
    S.pid = pid; S.project = j;
    S.kind = j.media.kind;
    S.duration = (j.media.info && j.media.info.duration) || 0;
    S.exportCfg = { aspect: '1080x1920', bgColor: '#101012', ...(j.export || {}) };
    S.undo = []; S.redo = []; S.editing = -1; S.sel = null;
    S.lines = ((j.transcript && j.transcript.lines) || []).map((l) => ({ words: l.words.map((w) => ({ ...w })), _id: S.uid++, _dirty: !!l._dirty }));
    setFrameSize();
    const landscape = S.W > S.H;
    S.style = j.style ? { ...SS.DEFAULT_STYLE, ...j.style } : SS.presetStyle('viral', landscape);
    S.view = 'wide';
    const vj = j.vertical || {};
    S.vert = { ...SS.VDEFAULT, ...(vj.settings || {}) };
    S.styles = { wide: S.style, vertical: vj.style ? { ...SS.DEFAULT_STYLE, ...vj.style } : null };
    S.geo = null;
    $('#viewTabs').hidden = !(S.kind === 'video' && S.W > S.H);
    try { S.myLooks = await GET('/api/presets'); } catch (e) { S.myLooks = []; }

    $('#home').hidden = true;
    $('#editor').hidden = false;
    $('#projName').value = j.name || 'Untitled';
    $('#frameOpts').hidden = S.kind !== 'audio';
    if (S.kind === 'audio') {
      $('#aspect').value = S.exportCfg.aspect;
      $('#bgColor').value = S.exportCfg.bgColor;
      $('#btnBgClear').hidden = !j.background;
      loadBgImage(j.background);
    }

    renderer.setSize(S.W, S.H);
    renderer.setLines(S.lines);
    applyStyle();
    setViewUI();
    buildVPanel();
    await ensureFont(S.style);

    setupMedia(j);
    $('#tDur').textContent = SS.fmtTime(S.duration || 0);
    if (!timeline) {
      timeline = new SS.Timeline($('#tl'), {
        getLines: () => S.lines,
        getTime: () => video.currentTime || 0,
        seek: (t) => seek(t),
        onEdit: onTimelineEdit,
        onPick: (li, wi) => { S.sel = { li, wi }; markSelection(); },
        onDblWord: (li) => { scrollToLine(li); startEdit(li); },
      });
    }
    timeline.setDuration(S.duration);
    timeline.setPeaks(null);
    loadPeaks();
    renderLines();
    buildLooks();
    buildControls();
    layoutStage();
    S.needsDraw = true;
    if (note === 'failed') toast('Transcription did not finish. Try "Transcribe again" with Whisper, or check studio.log.', true, 9000);
    else if (!S.lines.length) toast('No words yet - use "Transcribe again" or "Use my lyrics".');
  }

  function setFrameSize() {
    const info = S.project.media.info || {};
    if (S.view === 'vertical') { S.W = 1080; S.H = 1920; }
    else if (S.kind === 'video' && info.width && info.height) { S.W = info.width; S.H = info.height; }
    else { const [w, h] = S.exportCfg.aspect.split('x').map(Number); S.W = w; S.H = h; }
  }

  function setupMedia(j) {
    const note = $('#stageNote');
    video.pause();
    video.removeAttribute('src');
    video.style.visibility = S.kind === 'video' ? 'visible' : 'hidden';
    $('#bgCanvas').style.display = S.kind === 'audio' ? 'block' : 'none';
    const go = (proj) => {
      video.src = `/api/projects/${S.pid}/media?v=${encodeURIComponent(proj.media.proxy || proj.media.file)}`;
      note.hidden = true;
    };
    if (j.media.proxy_pending) {
      note.hidden = false;
      note.textContent = 'Making a preview copy this browser can play...';
      const poll = async () => {
        if (S.pid !== j.id) return;
        const p = await GET('/api/projects/' + j.id).catch(() => null);
        if (p && !p.media.proxy_pending) {
          if (p.media.proxy_error) note.textContent = 'Preview copy failed: ' + p.media.proxy_error;
          else { S.project.media = p.media; go(p); }
        } else setTimeout(poll, 1500);
      };
      poll();
    } else go(j);
    video.onloadedmetadata = () => {
      if (!S.duration && isFinite(video.duration)) { S.duration = video.duration; timeline.setDuration(S.duration); }
      $('#tDur').textContent = SS.fmtTime(S.duration || video.duration || 0);
      S.needsDraw = true;
      setTimeout(renderThumbs, 400);
    };
    video.onerror = () => {
      note.hidden = false;
      note.textContent = "This browser can't play this file. Open Subtitle Studio in Chrome or Edge - captions and export still work.";
    };
    video.onplay = () => { $('#btnPlay').innerHTML = '&#10074;&#10074;'; };
    video.onpause = () => { $('#btnPlay').innerHTML = '&#9654;'; renderThumbs(); };
    video.onseeked = () => { S.needsDraw = true; if (video.paused) renderThumbsSoon(); };
  }

  async function loadPeaks() {
    const pid = S.pid;
    for (let i = 0; i < 60 && pid === S.pid; i++) {
      const p = await GET(`/api/projects/${pid}/peaks`).catch(() => null);
      if (Array.isArray(p)) { timeline.setPeaks(p); return; }
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  function seek(t) {
    video.currentTime = clamp(t, 0, S.duration || video.duration || 0);
    S.needsDraw = true;
  }

  /* ------------------------------------------------------- the stage -- */
  const overlay = $('#overlay'), octx = overlay.getContext('2d');
  const bgc = $('#bgCanvas'), bctx = bgc.getContext('2d');
  const safec = $('#safeCanvas'), sctx = safec.getContext('2d');
  let stageScale = 1;

  function layoutStage() {
    const wrap = $('#stageWrap').getBoundingClientRect();
    const aw = wrap.width - 32, ah = wrap.height - 32;
    if (aw <= 0 || ah <= 0) return;
    stageScale = Math.min(aw / S.W, ah / S.H);
    const cw = Math.round(S.W * stageScale), ch = Math.round(S.H * stageScale);
    const st = $('#stage');
    st.style.width = cw + 'px'; st.style.height = ch + 'px';
    const dpr = window.devicePixelRatio || 1;
    for (const c of [overlay, bgc, safec]) { c.width = Math.round(cw * dpr); c.height = Math.round(ch * dpr); }
    drawBg(); drawSafe();
    S.needsDraw = true;
  }
  new ResizeObserver(() => { if (!$('#editor').hidden) layoutStage(); }).observe($('#stageWrap'));

  function drawOverlay(t) {
    octx.setTransform(1, 0, 0, 1, 0, 0);
    octx.clearRect(0, 0, overlay.width, overlay.height);
    const k = overlay.width / S.W;
    octx.setTransform(k, 0, 0, k, 0, 0);
    renderer.render(octx, t, k);
  }

  function drawBg() {
    if (S.view === 'vertical') {
      if (S.geo && video.readyState >= 2) SS.drawVertical(bctx, video, S.geo, bgc.width / S.W);
      else if (S.geo) { bctx.fillStyle = '#000'; bctx.fillRect(0, 0, bgc.width, bgc.height); }
      return;
    }
    if (S.kind !== 'audio') return;
    bctx.setTransform(1, 0, 0, 1, 0, 0);
    bctx.fillStyle = S.exportCfg.bgColor || '#101012';
    bctx.fillRect(0, 0, bgc.width, bgc.height);
    if (S.bgImage) {
      const img = S.bgImage;
      const sc = Math.max(bgc.width / img.width, bgc.height / img.height);
      const w = img.width * sc, h = img.height * sc;
      bctx.drawImage(img, (bgc.width - w) / 2, (bgc.height - h) / 2, w, h);
    }
  }


  /* ------------------------------------------------- wide / vertical -- */
  // The vertical version keeps your look's fonts and colours but takes its size
  // and placement from the portrait version of the same look.
  function verticalStyleFrom(ws) {
    const out = { ...ws };
    if (ws._preset) {
      const p = SS.presetStyle(ws._preset, false);
      for (const k of ['size', 'x', 'y', 'maxWidth', 'maxWords', 'align']) out[k] = p[k];
    } else out.size = +(ws.size * 0.8).toFixed(2);
    return out;
  }
  function geoFor(view) {
    const i = S.project.media.info || {};
    return view === 'vertical' && i.width ? SS.verticalGeometry(S.vert, i.width, i.height) : null;
  }
  function styleFor(view) {
    let st = view === S.view ? S.style : (S.styles[view] || (view === 'vertical' ? verticalStyleFrom(S.style) : S.style));
    const g = geoFor(view);
    if (g && S.vert.capMode === 'auto' && g.capY != null) st = { ...st, y: +(g.capY / 1920 * 100).toFixed(2) };
    return st;
  }
  function applyStyle() {
    S.geo = geoFor(S.view);
    renderer.setStyle(styleFor(S.view));
    S.needsDraw = true;
  }
  function setViewUI() {
    $$('#viewTabs button').forEach((b) => b.classList.toggle('on', b.dataset.view === S.view));
    video.style.visibility = S.kind === 'video' && S.view === 'wide' ? 'visible' : 'hidden';
    $('#bgCanvas').style.display = S.kind === 'audio' || S.view === 'vertical' ? 'block' : 'none';
    $('#vpanel').hidden = S.view !== 'vertical';
  }
  function setView(view) {
    if (view === S.view) return;
    S.styles[S.view] = S.style;
    S.view = view;
    if (view === 'vertical' && !S.styles.vertical) S.styles.vertical = verticalStyleFrom(S.styles.wide);
    S.style = S.styles[view];
    setFrameSize();
    renderer.setSize(S.W, S.H);
    applyStyle();
    setViewUI();
    layoutStage(); syncControls(); markLooks(); syncVPanel(); renderThumbsSoon();
    scheduleSave();
  }
  $('#viewTabs').addEventListener('click', (e) => { const b = e.target.closest('button[data-view]'); if (b) setView(b.dataset.view); });

  function buildVPanel() {
    $('#vLayouts').innerHTML = SS.VLAYOUTS.map((l) => `<button class="vlay" data-id="${l.id}" title="${esc(l.blurb)}">${SS.verticalIcon(l.id)}<span>${esc(l.name)}</span></button>`).join('');
    syncVPanel();
  }
  const VCTL = [
    { k: 'videoY', show: ['blur', 'bars', 'zoom'] }, { k: 'pan', show: ['fill', 'zoom', 'stack'] },
    { k: 'zoom', show: ['zoom', 'stack'] }, { k: 'blur', show: ['blur', 'zoom', 'stack'] },
    { k: 'dim', show: ['blur', 'zoom', 'stack'] }, { k: 'barColor', show: ['bars'] },
  ];
  function syncVPanel() {
    const L = S.vert.layout;
    $$('#vLayouts .vlay').forEach((b) => b.classList.toggle('on', b.dataset.id === L));
    const info = SS.VLAYOUTS.find((x) => x.id === L);
    $('#vBlurb').textContent = info ? info.blurb : '';
    for (const c of VCTL) {
      const row = $(`#vpanel [data-vk="${c.k}"]`);
      if (!row) continue;
      row.hidden = !c.show.includes(L);
      const inp = row.querySelector('input');
      inp.value = S.vert[c.k];
      const val = row.querySelector('.val');
      if (val) val.textContent = c.k === 'zoom' ? (+S.vert.zoom).toFixed(2) + '×' : c.k === 'blur' ? Math.round(S.vert.blur) : Math.round(S.vert[c.k] * 100) + '%';
    }
    $('#vZoomLabel').textContent = L === 'stack' ? 'Close-up zoom' : 'Zoom';
    $$('#vCap button').forEach((b) => b.classList.toggle('on', b.dataset.v === S.vert.capMode));
  }
  $('#vLayouts').addEventListener('click', (e) => {
    const b = e.target.closest('.vlay');
    if (!b) return;
    S.vert.layout = b.dataset.id;
    if (b.dataset.id === 'stack' && S.vert.zoom < 1.3) S.vert.zoom = 1.8;
    vertChanged();
  });
  $$('#vpanel [data-vk] input').forEach((inp) => inp.addEventListener('input', () => {
    const k = inp.closest('[data-vk]').dataset.vk;
    S.vert[k] = inp.type === 'color' ? inp.value : +inp.value;
    vertChanged(false);
  }));
  $('#vCap').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-v]');
    if (!b) return;
    S.vert.capMode = b.dataset.v;
    vertChanged();
  });
  function vertChanged(full = true) {
    applyStyle(); drawBg(); syncVPanel();
    scheduleSave();
    if (full) renderThumbsSoon(); else { clearTimeout(vertChanged._t); vertChanged._t = setTimeout(renderThumbs, 400); }
  }

  const SAFE = {   // 1080x1920 reference, conservative cross-app figures
    reels: { top: 210, bottom: 310, left: 0, right: 84 },
    tiktok: { top: 108, bottom: 320, left: 60, right: 120 },
    shorts: { top: 120, bottom: 300, left: 0, right: 96 },
  };
  function drawSafe() {
    sctx.setTransform(1, 0, 0, 1, 0, 0);
    sctx.clearRect(0, 0, safec.width, safec.height);
    const z = SAFE[$('#safe').value];
    if (!z) return;
    const kx = safec.width / 1080, ky = safec.height / 1920;
    sctx.fillStyle = 'rgba(255, 90, 80, 0.16)';
    sctx.strokeStyle = 'rgba(255, 140, 120, 0.7)';
    if (S.H > S.W) {
      sctx.fillRect(0, 0, safec.width, z.top * ky);
      sctx.fillRect(0, safec.height - z.bottom * ky, safec.width, z.bottom * ky);
      sctx.fillRect(safec.width - z.right * kx, z.top * ky, z.right * kx, safec.height - (z.top + z.bottom) * ky);
      if (z.left) sctx.fillRect(0, z.top * ky, z.left * kx, safec.height - (z.top + z.bottom) * ky);
    } else {
      const m = 0.05;
      sctx.strokeRect(safec.width * m, safec.height * m, safec.width * (1 - 2 * m), safec.height * (1 - 2 * m));
    }
  }
  $('#safe').addEventListener('change', drawSafe);

  // drag the caption on the stage to move it
  let stageDrag = null;
  function frameXY(e) {
    const r = overlay.getBoundingClientRect();
    return { x: (e.clientX - r.left) / r.width * S.W, y: (e.clientY - r.top) / r.height * S.H };
  }
  function captionBox() {
    const pi = renderer.pageIndexAt(video.currentTime || 0);
    if (pi < 0) return null;
    const L = renderer.layout(octx, pi);
    const pad = L.fontPx * 0.3;
    return { x: L.left - pad, y: L.top - pad, w: L.blockW + pad * 2, h: L.blockH + pad * 2 };
  }
  overlay.addEventListener('mousemove', (e) => {
    if (stageDrag) return;
    const p = frameXY(e), b = captionBox();
    overlay.classList.toggle('can-drag', !!b && p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h);
  });
  overlay.addEventListener('mousedown', (e) => {
    const p = frameXY(e), b = captionBox();
    const inside = b && p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h;
    const eff = styleFor(S.view);
    stageDrag = { p0: p, x0: eff.x, y0: eff.y, moved: false, inside, snap: snapshot() };
    const mm = (ev) => {
      if (!stageDrag.inside) return;
      const q = frameXY(ev);
      const dx = q.x - stageDrag.p0.x, dy = q.y - stageDrag.p0.y;
      if (!stageDrag.moved && Math.hypot(dx, dy) < 4) return;
      stageDrag.moved = true;
      overlay.classList.add('dragging');
      S.style.x = Math.round(clamp(stageDrag.x0 + dx / S.W * 100, 0, 100) * 2) / 2;
      S.style.y = Math.round(clamp(stageDrag.y0 + dy / S.H * 100, 2, 98) * 2) / 2;
      if (S.view === 'vertical' && S.vert.capMode === 'auto') { S.vert.capMode = 'manual'; syncVPanel(); }
      styleChanged(false);
    };
    const up = () => {
      window.removeEventListener('mousemove', mm);
      window.removeEventListener('mouseup', up);
      overlay.classList.remove('dragging');
      if (stageDrag.moved) { pushUndo(stageDrag.snap); syncControls(); scheduleSave(); }
      else togglePlay();
      stageDrag = null;
    };
    window.addEventListener('mousemove', mm);
    window.addEventListener('mouseup', up);
  });

  /* --------------------------------------------------------- transport -- */
  function togglePlay() { if (video.paused) video.play().catch(() => {}); else video.pause(); }
  $('#btnPlay').addEventListener('click', togglePlay);
  $('#rate').addEventListener('change', (e) => { video.playbackRate = +e.target.value; });
  $('#zoom').addEventListener('input', (e) => timeline && timeline.zoomTo(+e.target.value));

  let lastT = -1, lastActive = { li: -1, wi: -1 }, userScrolledAt = 0;
  $('#lines').addEventListener('wheel', () => { userScrolledAt = performance.now(); }, { passive: true });

  function loop() {
    requestAnimationFrame(loop);
    if ($('#editor').hidden) return;
    const t = video.currentTime || 0;
    if (S.needsDraw || t !== lastT || !video.paused) {
      if (S.view === 'vertical') drawBg();
      drawOverlay(t);
      if (t !== lastT) {
        $('#tNow').textContent = SS.fmtTime(t, true);
        if (timeline) { if (!video.paused && timeline.follow) timeline.reveal(t); timeline.draw(); }
        markNow(t);
      }
      if (S.needsDraw && timeline) timeline.draw();
      S.needsDraw = false;
      lastT = t;
    }
  }
  requestAnimationFrame(loop);

  function markNow(t) {
    let li = -1, wi = -1;
    for (let i = 0; i < S.lines.length; i++) {
      const ws = S.lines[i].words;
      if (!ws.length) continue;
      if (t >= ws[0].s - 0.05 && t <= ws[ws.length - 1].e + 0.25) {
        li = i;
        for (let k = 0; k < ws.length; k++) if (ws[k].s <= t && t < ws[k].e) wi = k;
        break;
      }
      if (ws[0].s > t) break;
    }
    if (li === lastActive.li && wi === lastActive.wi) return;
    const box = $('#lines');
    const prevLn = box.querySelector('.ln.on');
    if (prevLn) prevLn.classList.remove('on');
    const prevW = box.querySelector('.w.now');
    if (prevW) prevW.classList.remove('now');
    if (li >= 0) {
      const ln = box.querySelector(`.ln[data-li="${li}"]`);
      if (ln) {
        ln.classList.add('on');
        if (wi >= 0) { const w = ln.querySelector(`.w[data-wi="${wi}"]`); if (w) w.classList.add('now'); }
        if (li !== lastActive.li && !video.paused && S.editing < 0 && performance.now() - userScrolledAt > 3000) {
          const r = ln.getBoundingClientRect(), br = box.getBoundingClientRect();
          if (r.top < br.top + 40 || r.bottom > br.bottom - 40) box.scrollTo({ top: box.scrollTop + r.top - br.top - br.height * 0.3, behavior: 'smooth' });
        }
      }
    }
    lastActive = { li, wi };
  }

  /* ------------------------------------------------------ transcript -- */
  const lineText = (ln) => ln.words.map((w) => w.t).join(' ');

  function renderLines() {
    const box = $('#lines');
    if (!S.lines.length) {
      box.innerHTML = '<div class="empty">No words yet. Use <b>Transcribe again</b> or <b>Use my lyrics</b> at the top.</div>';
      updateResyncBar();
      return;
    }
    box.innerHTML = S.lines.map((ln, li) => lineHTML(ln, li)).join('');
    lastActive = { li: -1, wi: -1 };
    markNow(video.currentTime || 0);
    markSelection();
    updateResyncBar();
  }
  function lineHTML(ln, li) {
    const t = ln.words.length ? SS.fmtTime(ln.words[0].s, true) : '';
    const words = ln.words.map((w, wi) => `<span class="w${w.k ? ' key' : ''}" data-wi="${wi}">${esc(w.t)}</span>`).join(' ');
    return `<div class="ln${ln._dirty ? ' dirty' : ''}" data-li="${li}">
      <span class="lt" title="Jump here">${t}</span>
      <div class="tx">${words}</div>
      <span class="tools">
        <button data-act="sync" title="Re-sync this line to the audio">&#8635;</button>
        <button data-act="merge" title="Join with the next line">&#8615;</button>
        <button data-act="del" title="Delete this line">&#215;</button>
      </span>
    </div>`;
  }
  function refreshLine(li) {
    const el = $(`#lines .ln[data-li="${li}"]`);
    if (!el || !S.lines[li]) return renderLines();
    el.outerHTML = lineHTML(S.lines[li], li);
    lastActive = { li: -1, wi: -1 };
    markSelection();
  }
  function markSelection() {
    $$('#lines .w.sel').forEach((x) => x.classList.remove('sel'));
    if (S.sel && S.sel.wi >= 0) {
      const w = $(`#lines .ln[data-li="${S.sel.li}"] .w[data-wi="${S.sel.wi}"]`);
      if (w) w.classList.add('sel');
    }
  }
  function scrollToLine(li) {
    const el = $(`#lines .ln[data-li="${li}"]`);
    if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  $('#lines').addEventListener('click', (e) => {
    const lnEl = e.target.closest('.ln');
    if (!lnEl || S.editing >= 0 && +lnEl.dataset.li === S.editing) return;
    const li = +lnEl.dataset.li;
    const act = e.target.closest('[data-act]');
    if (act) {
      if (act.dataset.act === 'sync') resyncLines([li]);
      if (act.dataset.act === 'merge') mergeLine(li);
      if (act.dataset.act === 'del') deleteLine(li);
      return;
    }
    const w = e.target.closest('.w');
    if (w) {
      const wi = +w.dataset.wi;
      const word = S.lines[li].words[wi];
      if (e.altKey || e.ctrlKey || e.metaKey) {
        pushUndo();
        if (word.k) delete word.k; else word.k = 1;
        changed(); refreshLine(li);
        return;
      }
      S.sel = { li, wi };
      if (timeline) timeline.sel = { li, wi };
      markSelection();
      seek(word.s + 0.001);
      return;
    }
    if (e.target.closest('.lt')) { const ws = S.lines[li].words; if (ws.length) seek(Math.max(0, ws[0].s - 0.15)); }
  });
  $('#lines').addEventListener('dblclick', (e) => {
    const lnEl = e.target.closest('.ln');
    if (lnEl && e.target.closest('.tx')) startEdit(+lnEl.dataset.li);
  });

  function startEdit(li) {
    if (S.editing >= 0) return;
    const el = $(`#lines .ln[data-li="${li}"]`);
    if (!el) return;
    S.editing = li;
    el.classList.add('editing');
    const tx = el.querySelector('.tx');
    const old = lineText(S.lines[li]);
    tx.innerHTML = '';
    const ta = document.createElement('textarea');
    ta.value = old;
    ta.rows = 1;
    tx.appendChild(ta);
    const hint = document.createElement('div');
    hint.className = 'edit-hint';
    hint.textContent = 'Enter saves  ·  Shift+Enter splits the line here  ·  Esc cancels';
    el.appendChild(hint);
    const size = () => { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px'; };
    size();
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
    let done = false;
    const finish = (mode) => {
      if (done) return;
      done = true;
      S.editing = -1;
      if (mode === 'cancel') { refreshLine(li); return; }
      if (mode === 'split') {
        const pos = ta.selectionStart;
        splitAt(li, ta.value.slice(0, pos), ta.value.slice(pos));
        return;
      }
      if (ta.value.trim() === old.trim()) { refreshLine(li); return; }
      commitLineText(li, ta.value);
    };
    ta.addEventListener('input', size);
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.shiftKey) { e.preventDefault(); finish('split'); }
      else if (e.key === 'Enter') { e.preventDefault(); finish('save'); }
      else if (e.key === 'Escape') { e.preventDefault(); finish('cancel'); }
      e.stopPropagation();
    });
    ta.addEventListener('blur', () => finish('save'));
  }

  /* --------------------------- keeping timings when the text changes -- */
  function splitWords(text) {
    // mirrors the server's display_words: punctuation-only pieces join the word before
    const out = [];
    for (const seg of text.split(/\s+/).filter(Boolean)) {
      const clean = seg.replace(/[^\p{L}\p{N}']/gu, '');
      if (!clean && out.length) { out[out.length - 1] += /^[.,!?;:…)"']/.test(seg) ? seg : ' ' + seg; continue; }
      out.push(seg);
    }
    return out;
  }
  const normW = (t) => t.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}]/gu, '');

  // Words you did not touch keep their exact timing; new or changed words share
  // the time of what they replaced, weighted by length. A re-sync then refines them.
  function retime(oldW, toks) {
    const n = oldW.length, m = toks.length;
    const a = oldW.map((w) => normW(w.t)), b = toks.map(normW);
    const L = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = a[i] === b[j] && a[i] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    const pairs = [];
    for (let i = 0, j = 0; i < n && j < m;) {
      if (a[i] === b[j] && a[i]) { pairs.push([i, j]); i++; j++; } else if (L[i + 1][j] >= L[i][j + 1]) i++; else j++;
    }
    const out = new Array(m);
    for (const [i, j] of pairs) out[j] = { ...oldW[i], t: toks[j] };
    const spanS = n ? oldW[0].s : 0, spanE = n ? oldW[n - 1].e : 0.5;
    let pi = -1;
    const anchors = [[-1, -1], ...pairs, [n, m]];
    for (let q = 0; q < anchors.length - 1; q++) {
      const [i0, j0] = anchors[q], [i1, j1] = anchors[q + 1];
      const gapToks = toks.slice(j0 + 1, j1);
      if (!gapToks.length) continue;
      const replaced = oldW.slice(i0 + 1, i1);
      let s = replaced.length ? replaced[0].s : (i0 >= 0 ? oldW[i0].e : spanS);
      let e = replaced.length ? replaced[replaced.length - 1].e : (i1 < n ? oldW[i1].s : spanE);
      if (e - s < 0.1 * gapToks.length) {
        const need = 0.1 * gapToks.length - (e - s);
        s = Math.max(i0 >= 0 ? oldW[i0].s + 0.05 : spanS - 0.3, s - need / 2);
        e = s + 0.1 * gapToks.length;
      }
      const wts = gapToks.map((t) => normW(t).length + 1.5);
      const tot = wts.reduce((x, y) => x + y, 0);
      let acc = s;
      gapToks.forEach((t, k) => {
        const d = (e - s) * wts[k] / tot;
        out[j0 + 1 + k] = { t, s: acc, e: acc + d - 0.01, l: replaced[k] ? replaced[k].l : 0.5 };
        acc += d;
      });
      pi = q;
    }
    // monotonic clean-up
    for (let k = 0; k < out.length; k++) {
      const w = out[k];
      if (k && w.s < out[k - 1].e) { if (w.e - out[k - 1].e > 0.03) w.s = out[k - 1].e; else { out[k - 1].e = Math.max(out[k - 1].s + 0.03, w.s); } }
      if (w.e < w.s + 0.03) w.e = w.s + 0.03;
    }
    return out;
  }

  function commitLineText(li, text, opts = {}) {
    const toks = splitWords(text.trim());
    if (!opts.noUndo) pushUndo();
    if (!toks.length) { S.lines.splice(li, 1); changed(); renderLines(); return; }
    const ln = S.lines[li];
    const before = ln.words.map((w) => normW(w.t)).join(' ');
    ln.words = retime(ln.words, toks);
    const after = ln.words.map((w) => normW(w.t)).join(' ');
    if (before !== after) ln._dirty = true;
    changed();
    refreshLine(li);
    updateResyncBar();
    if (ln._dirty && $('#autoSync').checked && !opts.noSync) resyncLines([li]);
  }

  function splitAt(li, left, right) {
    pushUndo();
    const ln = S.lines[li];
    const all = splitWords((left + ' ' + right).trim());
    const nLeft = splitWords(left.trim()).length;
    const words = retime(ln.words, all);
    const changedText = words.map((w) => normW(w.t)).join(' ') !== ln.words.map((w) => normW(w.t)).join(' ');
    const A = { words: words.slice(0, nLeft), _id: S.uid++, _dirty: changedText };
    const B = { words: words.slice(nLeft), _id: S.uid++, _dirty: changedText };
    const parts = [A, B].filter((x) => x.words.length);
    S.lines.splice(li, 1, ...parts);
    changed(); renderLines();
    if (changedText && $('#autoSync').checked) resyncLines(parts.map((p) => S.lines.indexOf(p)));
  }
  function mergeLine(li) {
    if (li + 1 >= S.lines.length) return;
    pushUndo();
    const A = S.lines[li], B = S.lines[li + 1];
    A.words = A.words.concat(B.words);
    A._dirty = A._dirty || B._dirty;
    S.lines.splice(li + 1, 1);
    changed(); renderLines();
  }
  function deleteLine(li) {
    pushUndo();
    S.lines.splice(li, 1);
    changed(); renderLines();
    toast('Line deleted. Ctrl+Z brings it back.');
  }

  /* ----------------------------------------------------------- re-sync -- */
  async function resyncLines(lis) {
    lis = lis.filter((li) => S.lines[li] && S.lines[li].words.length);
    if (!lis.length) return;
    const lang = (S.project.transcript && S.project.transcript.language) || 'English';
    const items = lis.map((li) => {
      const ln = S.lines[li], ws = ln.words;
      const prev = S.lines[li - 1], next = S.lines[li + 1];
      return {
        key: ln._id, text: lineText(ln), s: ws[0].s, e: ws[ws.length - 1].e,
        lo: prev && prev.words.length ? prev.words[prev.words.length - 1].e : 0,
        hi: next && next.words.length ? next.words[0].s : (S.duration || 1e9),
      };
    });
    lis.forEach((li) => { const el = $(`#lines .ln[data-li="${li}"]`); if (el) el.classList.add('syncing'); });
    try {
      const res = await POST(`/api/projects/${S.pid}/realign`, { language: lang, items });
      for (const [key, words] of Object.entries(res.lines || {})) {
        const li = S.lines.findIndex((l) => String(l._id) === key);
        if (li < 0) continue;
        const ln = S.lines[li];
        const keyFlags = ln.words.map((w) => !!w.k);
        if (words.length) {
          ln.words = words.map((w, i) => ({ ...w, ...(words.length === keyFlags.length && keyFlags[i] ? { k: 1 } : {}) }));
          if (ln.words.length === keyFlags.length) ln.words.forEach((w, i) => { if (!keyFlags[i]) delete w.k; });
        }
        ln._dirty = !res.aligned;
        refreshLine(li);
      }
      if (!res.aligned) toast((res.warnings && res.warnings[0]) || 'The aligner is not available, so the timing was spread evenly.', true, 6000);
      changed(false);
    } catch (e) {
      toast('Re-sync failed: ' + e.message, true, 7000);
      lis.forEach((li) => { const el = $(`#lines .ln[data-li="${li}"]`); if (el) el.classList.remove('syncing'); });
    }
    updateResyncBar();
  }
  function updateResyncBar() {
    const n = S.lines.filter((l) => l._dirty).length;
    $('#resyncBar').hidden = n === 0;
    $('#resyncText').textContent = n === 1 ? '1 edited line is not synced to the audio yet.' : `${n} edited lines are not synced to the audio yet.`;
  }
  $('#btnResync').addEventListener('click', () => resyncLines(S.lines.map((l, i) => (l._dirty ? i : -1)).filter((i) => i >= 0)));

  function onTimelineEdit(kind, li, orig) {
    if (kind === 'live') { renderer.invalidate(); S.needsDraw = true; return; }
    if (kind === 'timing') {
      const snap = JSON.parse(snapshot());
      if (snap.lines[li]) snap.lines[li].words = orig;
      pushUndo(JSON.stringify(snap));
      changed();
      refreshLine(li);
    }
  }

  /* --------------------------------------------------------- undo/redo -- */
  function strip(lines) { return lines.map((l) => ({ words: l.words.map((w) => { const o = { t: w.t, s: +w.s.toFixed(3), e: +w.e.toFixed(3), l: w.l == null ? 0.5 : w.l }; if (w.k) o.k = 1; return o; }), ...(l._dirty ? { _dirty: 1 } : {}) })); }
  function snapshot() { return JSON.stringify({ lines: strip(S.lines), style: S.style, view: S.view }); }
  function restore(json) {
    const s = JSON.parse(json);
    S.lines = s.lines.map((l) => ({ words: l.words, _id: S.uid++, _dirty: !!l._dirty }));
    if (!s.view || s.view === S.view) S.style = s.style; else S.styles[s.view] = s.style;
    renderer.setLines(S.lines);
    applyStyle();
    ensureFont(S.style);
    renderLines(); syncControls(); markLooks();
    S.needsDraw = true;
    scheduleSave();
  }
  function pushUndo(snap) {
    S.undo.push(snap || snapshot());
    if (S.undo.length > 200) S.undo.shift();
    S.redo = [];
  }
  function undo() { if (!S.undo.length) return; S.redo.push(snapshot()); restore(S.undo.pop()); }
  function redo() { if (!S.redo.length) return; S.undo.push(snapshot()); restore(S.redo.pop()); }
  $('#btnUndo').addEventListener('click', undo);
  $('#btnRedo').addEventListener('click', redo);

  function changed(save = true) {
    renderer.setLines(S.lines);
    S.needsDraw = true;
    if (timeline) timeline.draw();
    if (save) scheduleSave();
    else scheduleSave();
    renderThumbsSoon();
  }

  /* -------------------------------------------------------------- save -- */
  let saveT = 0;
  function scheduleSave() {
    clearTimeout(saveT);
    $('#saveState').textContent = 'Saving...';
    saveT = setTimeout(async () => {
      try {
        await PUT('/api/projects/' + S.pid, {
          name: $('#projName').value.trim() || 'Untitled',
          transcript: { lines: strip(S.lines) },
          style: S.view === 'wide' ? S.style : S.styles.wide,
          vertical: { settings: S.vert, style: S.view === 'vertical' ? S.style : S.styles.vertical },
          export: S.exportCfg,
        });
        $('#saveState').textContent = 'Saved';
      } catch (e) { $('#saveState').textContent = 'Not saved: ' + e.message; }
    }, 700);
  }
  $('#projName').addEventListener('input', scheduleSave);

  /* ============================================================ LOOKS === */
  function buildLooks() {
    $('#looks').innerHTML = SS.PRESETS.map((p) => `
      <button class="look" data-id="${p.id}">
        <canvas width="224" height="140"></canvas>
        <span><b>${esc(p.name)}</b><small>${esc(p.blurb)}</small><span class="mod"></span></span>
      </button>`).join('');
    renderMyLooks();
    markLooks();
    Promise.all(SS.PRESETS.map((p) => ensureFont(SS.presetStyle(p.id)))).then(renderThumbs);
  }
  $('#looks').addEventListener('click', (e) => {
    const b = e.target.closest('.look');
    if (b) applyPreset(b.dataset.id);
  });
  function applyPreset(id) {
    pushUndo();
    S.style = SS.presetStyle(id, S.W > S.H);
    applyStyle();
    ensureFont(S.style);
    syncControls(); markLooks();
    S.needsDraw = true;
    scheduleSave();
  }
  function markLooks() {
    $$('#looks .look').forEach((b) => {
      const on = b.dataset.id === S.style._preset;
      b.classList.toggle('on', on);
      b.querySelector('.mod').textContent = on && S.style._edited ? 'Edited  ·  click to reset' : '';
    });
    const p = SS.PRESETS.find((x) => x.id === S.style._preset);
    $('#lookState').textContent = S.style._custom ? `My look: ${S.style._custom}` : p ? (S.style._edited ? `${p.name}, edited` : p.name) : '';
  }

  let thumbT = 0;
  function renderThumbsSoon() { clearTimeout(thumbT); thumbT = setTimeout(renderThumbs, 500); }
  function renderThumbs() {
    if ($('#editor').hidden) return;
    const canv = $$('#looks .look canvas');
    if (!canv.length) return;
    // sample: a line with a few words, at its second word
    const ln = S.lines.find((l) => l.words.length >= 3) || { words: [{ t: 'Your', s: 0, e: .3, l: .5 }, { t: 'words', s: .3, e: .6, l: .8 }, { t: 'here', s: .6, e: 1, l: .5 }] };
    const sample = [{ words: ln.words.slice(0, 6) }];
    const t = (sample[0].words[1].s + sample[0].words[1].e) / 2;
    const F = 0.3;
    const fw = Math.round(S.W * F), fh = Math.round(S.H * F);
    const frame = new OffscreenCanvas(fw, fh);
    const fx = frame.getContext('2d');
    SS.PRESETS.forEach((p, i) => {
      let st = SS.presetStyle(p.id, S.W > S.H);
      if (S.view === 'vertical' && S.geo && S.vert.capMode === 'auto' && S.geo.capY != null) st = { ...st, y: S.geo.capY / 19.2 };
      fx.setTransform(1, 0, 0, 1, 0, 0);
      fx.fillStyle = S.kind === 'audio' ? S.exportCfg.bgColor : '#000';
      fx.fillRect(0, 0, fw, fh);
      try {
        if (S.view === 'vertical' && S.geo) SS.drawVertical(fx, video, S.geo, F);
        else if (S.kind === 'video' && video.readyState >= 2) fx.drawImage(video, 0, 0, fw, fh);
        else if (S.kind === 'audio' && S.bgImage) {
          const img = S.bgImage, sc = Math.max(fw / img.width, fh / img.height);
          fx.drawImage(img, (fw - img.width * sc) / 2, (fh - img.height * sc) / 2, img.width * sc, img.height * sc);
        }
      } catch (e) { /* tainted or not ready */ }
      const r = new SS.Renderer();
      r.setSize(S.W, S.H); r.setLines(sample); r.setStyle(st);
      fx.setTransform(F, 0, 0, F, 0, 0);
      r.render(fx, t, F);
      // crop a band around the caption
      const c = canv[i], cx = c.getContext('2d');
      const asp = c.height / c.width;
      let ccx = fw / 2, cy = (st.y / 100) * fh, bandW = fw;
      const pi = r.pageIndexAt(t);
      if (pi >= 0) {
        const L = r.layout(fx, pi);
        cy = (L.top + L.blockH / 2) * F;
        ccx = (L.left + L.blockW / 2) * F;
        bandW = clamp(Math.max(L.blockW * 1.3, L.blockH * 1.5 / asp) * F, fw * 0.4, fw);
      }
      let bandH = bandW * asp;
      if (bandH > fh) { bandH = fh; bandW = bandH / asp; }
      const sx = clamp(ccx - bandW / 2, 0, Math.max(0, fw - bandW));
      const sy = clamp(cy - bandH / 2, 0, Math.max(0, fh - bandH));
      cx.clearRect(0, 0, c.width, c.height);
      cx.drawImage(frame, sx, sy, bandW, bandH, 0, 0, c.width, c.height);
    });
  }

  /* ---------------------------------------------------------- my looks -- */
  function renderMyLooks() {
    const ul = $('#myLooks');
    if (!S.myLooks.length) { ul.innerHTML = '<li class="none" style="background:none;padding:0">Tweak a look, then save it here to reuse on other songs.</li>'; return; }
    ul.innerHTML = S.myLooks.map((m, i) => `<li><button class="apply" data-i="${i}" title="Use this look">${esc(m.name)}</button><button data-rm="${i}" title="Remove">&#215;</button></li>`).join('');
  }
  $('#myLooks').addEventListener('click', async (e) => {
    const a = e.target.closest('[data-i]'), rm = e.target.closest('[data-rm]');
    if (a) {
      const m = S.myLooks[+a.dataset.i];
      pushUndo();
      S.style = { ...SS.DEFAULT_STYLE, ...m.style, _custom: m.name };
      applyStyle(); ensureFont(S.style);
      syncControls(); markLooks(); S.needsDraw = true; scheduleSave();
    }
    if (rm) {
      S.myLooks.splice(+rm.dataset.rm, 1);
      renderMyLooks();
      await PUT('/api/presets', S.myLooks).catch((err) => toast(err.message, true));
    }
  });
  $('#btnSaveLook').addEventListener('click', () => {
    const head = $('.mylooks-head');
    if (head.querySelector('input')) return;
    const p = SS.PRESETS.find((x) => x.id === S.style._preset);
    const inp = document.createElement('input');
    inp.type = 'text'; inp.placeholder = 'Name this look'; inp.value = p ? p.name + ' (mine)' : 'My look';
    inp.style.margin = '6px 0 0';
    head.after(inp);
    inp.focus(); inp.select();
    let finished = false;
    const done = async (save) => {
      if (finished) return;
      finished = true;
      inp.remove();
      if (!save || !inp.value.trim()) return;
      const style = { ...S.style };
      delete style._custom;
      S.myLooks.push({ name: inp.value.trim(), style });
      S.style._custom = inp.value.trim();
      renderMyLooks(); markLooks();
      await PUT('/api/presets', S.myLooks).then(() => toast('Saved to My looks')).catch((err) => toast(err.message, true));
    };
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') done(true); if (e.key === 'Escape') done(false); e.stopPropagation(); });
    inp.addEventListener('blur', () => done(true));
  });

  /* --------------------------------------------------------- controls -- */
  let styleBefore = null;
  function styleChanged(markEdited = true) {
    if (markEdited) { S.style._edited = true; delete S.style._custom; }
    applyStyle();
    S.needsDraw = true;
    markLooks();
    updateVisibility();
  }

  function buildControls() {
    const box = $('#controls');
    box.innerHTML = '';
    for (const g of SS.CONTROLS) {
      const d = document.createElement('details');
      d.className = 'grp';
      if (g.open) d.open = true;
      d.innerHTML = `<summary>${esc(g.group)}</summary><div class="gbody"></div>`;
      const body = d.querySelector('.gbody');
      for (const c of g.items) body.appendChild(controlRow(c));
      box.appendChild(d);
    }
    syncControls();
  }

  function fmtVal(c, v) {
    if (c.type !== 'range') return '';
    const dec = c.step >= 1 ? 0 : c.step >= 0.1 ? 1 : c.step >= 0.01 ? 2 : 3;
    return (+v).toFixed(dec) + (c.unit ? (c.unit === '%' || c.unit === '°' ? '' : ' ') + c.unit : '');
  }

  function controlRow(c) {
    const row = document.createElement('div');
    row.className = 'ctl';
    row.dataset.k = c.k;
    const id = 'c_' + c.k;
    const label = `<label for="${id}">${esc(c.label)}</label>`;
    const help = c.help ? `<span class="help">${esc(c.help)}</span>` : '';
    if (c.type === 'range') {
      row.innerHTML = `${label}<span class="val"></span><input type="range" id="${id}" min="${c.min}" max="${c.max}" step="${c.step}">${help}`;
      const inp = row.querySelector('input');
      inp.addEventListener('input', () => {
        if (!styleBefore) styleBefore = snapshot();
        S.style[c.k] = +inp.value;
        row.querySelector('.val').textContent = fmtVal(c, inp.value);
        styleChanged();
      });
      inp.addEventListener('change', () => { if (styleBefore) pushUndo(styleBefore); styleBefore = null; scheduleSave(); renderThumbsSoon(); });
    } else if (c.type === 'select' || c.type === 'font' || c.type === 'weight') {
      row.innerHTML = `${label}<select id="${id}"></select>${help}`;
      const sel = row.querySelector('select');
      if (c.type === 'select') sel.innerHTML = c.options.map((o) => `<option value="${o.v}">${esc(o.l)}</option>`).join('');
      if (c.type === 'font') {
        const cats = [...new Set(SS.FONTS.map((f) => f.cat))];
        sel.innerHTML = cats.map((cat) => `<optgroup label="${cat}">${SS.FONTS.filter((f) => f.cat === cat).map((f) => `<option value="${esc(f.family)}" style="font-family:'${esc(f.family)}'">${esc(f.family)}</option>`).join('')}</optgroup>`).join('');
      }
      sel.addEventListener('change', async () => {
        pushUndo();
        let v = sel.value;
        if (c.type === 'weight') v = +v;
        S.style[c.k] = v;
        if (c.type === 'font') {
          const fi = SS.fontInfo(v);
          if (!fi.weights.includes(S.style.weight)) S.style.weight = fi.weights.reduce((a, b) => (Math.abs(b - S.style.weight) < Math.abs(a - S.style.weight) ? b : a));
          if (!fi.italic) S.style.italic = false;
          syncControls();
        }
        styleChanged();
        await ensureFont(S.style);
        scheduleSave(); renderThumbsSoon();
      });
    } else if (c.type === 'seg') {
      row.innerHTML = `${label}<span></span><div class="seg">${c.options.map((o) => `<button type="button" data-v="${o.v}">${esc(o.l)}</button>`).join('')}</div>${help}`;
      row.querySelector('.seg').addEventListener('click', (e) => {
        const b = e.target.closest('button');
        if (!b) return;
        pushUndo();
        S.style[c.k] = b.dataset.v;
        syncControls(); styleChanged(); scheduleSave(); renderThumbsSoon();
      });
    } else if (c.type === 'color') {
      row.innerHTML = `${label}<span class="colorpair">${c.optional ? '<button type="button" class="clr">same as text</button>' : ''}<input type="color" id="${id}"></span>${help}`;
      const inp = row.querySelector('input');
      inp.addEventListener('input', () => {
        if (!styleBefore) styleBefore = snapshot();
        S.style[c.k] = inp.value;
        styleChanged();
      });
      inp.addEventListener('change', () => { if (styleBefore) pushUndo(styleBefore); styleBefore = null; syncControls(); scheduleSave(); renderThumbsSoon(); });
      const clr = row.querySelector('.clr');
      if (clr) clr.addEventListener('click', () => { pushUndo(); S.style[c.k] = ''; syncControls(); styleChanged(); scheduleSave(); });
    } else if (c.type === 'toggle') {
      row.classList.add('inline');
      row.innerHTML = `${label}<input type="checkbox" class="toggle" id="${id}">${help}`;
      const inp = row.querySelector('input');
      inp.addEventListener('change', () => { pushUndo(); S.style[c.k] = inp.checked; styleChanged(); ensureFont(S.style); scheduleSave(); renderThumbsSoon(); });
    }
    return row;
  }

  function syncControls() {
    for (const g of SS.CONTROLS) for (const c of g.items) {
      const row = $(`#controls .ctl[data-k="${c.k}"]`);
      if (!row) continue;
      const v = S.style[c.k];
      if (c.type === 'range') { row.querySelector('input').value = v; row.querySelector('.val').textContent = fmtVal(c, v); }
      else if (c.type === 'select' || c.type === 'font') row.querySelector('select').value = v;
      else if (c.type === 'weight') {
        const fi = SS.fontInfo(S.style.font);
        const names = { 400: 'Regular', 500: 'Medium', 600: 'Semibold', 700: 'Bold', 800: 'Extra bold', 900: 'Black' };
        row.querySelector('select').innerHTML = fi.weights.map((w) => `<option value="${w}">${names[w] || w}</option>`).join('');
        row.querySelector('select').value = v;
      } else if (c.type === 'seg') $$('.seg button', row).forEach((b) => b.classList.toggle('on', b.dataset.v === String(v)));
      else if (c.type === 'color') {
        row.querySelector('input').value = v || S.style.color;
        const clr = row.querySelector('.clr');
        if (clr) clr.style.visibility = v ? 'visible' : 'hidden';
      } else if (c.type === 'toggle') {
        row.querySelector('input').checked = !!v;
        if (c.k === 'italic') row.querySelector('input').disabled = !SS.fontInfo(S.style.font).italic;
      }
    }
    updateVisibility();
  }
  function updateVisibility() {
    for (const g of SS.CONTROLS) for (const c of g.items) {
      if (!c.show) continue;
      const row = $(`#controls .ctl[data-k="${c.k}"]`);
      if (row) row.hidden = !c.show(S.style);
    }
  }

  /* --------------------------------------------------- audio framing -- */
  $('#aspect').addEventListener('change', (e) => {
    S.exportCfg.aspect = e.target.value;
    setFrameSize();
    renderer.setSize(S.W, S.H);
    layoutStage(); renderThumbsSoon(); scheduleSave();
  });
  $('#bgColor').addEventListener('input', (e) => { S.exportCfg.bgColor = e.target.value; drawBg(); scheduleSave(); });
  $('#btnBgImg').addEventListener('click', () => $('#bgFile').click());
  $('#bgFile').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    try {
      const r = await fetch(`/api/projects/${S.pid}/background`, { method: 'POST', headers: { 'X-Filename': encodeURIComponent(f.name) }, body: f });
      if (!r.ok) throw new Error((await r.json()).detail);
      loadBgImage(true);
      $('#btnBgClear').hidden = false;
    } catch (err) { toast(err.message, true); }
  });
  $('#btnBgClear').addEventListener('click', async () => {
    await DEL(`/api/projects/${S.pid}/background`).catch(() => {});
    S.bgImage = null; drawBg(); $('#btnBgClear').hidden = true; renderThumbsSoon();
  });
  function loadBgImage(has) {
    S.bgImage = null;
    if (!has) { drawBg(); return; }
    const img = new Image();
    img.onload = () => { S.bgImage = img; drawBg(); renderThumbsSoon(); };
    img.src = `/api/projects/${S.pid}/background?v=${Date.now()}`;
  }

  /* =================================================== DIALOG: LYRICS === */
  $('#btnLyrics').addEventListener('click', () => { $('#dlgLyrics').showModal(); $('#lyricsText').focus(); });
  $('#lyCancel').addEventListener('click', () => $('#dlgLyrics').close());
  $('#lyGo').addEventListener('click', async () => {
    const text = $('#lyricsText').value;
    if (!text.trim()) { toast('Paste your lyrics first.', true); return; }
    $('#dlgLyrics').close();
    try {
      const job = await POST(`/api/projects/${S.pid}/lyrics`, { lyrics: text });
      const res = await watchJob(job, { lyrics: true, onlyLyrics: true, title: 'Placing your lyrics' });
      if (res && res.result) loadTranscript(res.result.transcript);
    } catch (e) { toast(e.message, true, 7000); }
  });

  /* ============================================ DIALOG: RE-TRANSCRIBE === */
  $('#btnRetranscribe').addEventListener('click', () => {
    const o = S.project.transcript_opts || {};
    if (o.language) $('#rtLang').value = o.language;
    if (o.engine && !$(`#rtEngine option[value="${o.engine}"]`).disabled) $('#rtEngine').value = o.engine;
    if (o.separate != null && !$('#rtSep').disabled) $('#rtSep').checked = o.separate;
    $('#rtHints').value = o.hints || '';
    $('#dlgRetrans').showModal();
  });
  $('#rtCancel').addEventListener('click', () => $('#dlgRetrans').close());
  $('#rtGo').addEventListener('click', async () => {
    $('#dlgRetrans').close();
    const opts = { language: $('#rtLang').value, engine: $('#rtEngine').value, separate: $('#rtSep').checked, hints: $('#rtHints').value };
    try {
      const job = await POST(`/api/projects/${S.pid}/transcribe`, opts);
      const res = await watchJob(job, { separate: opts.separate, title: 'Transcribing again' });
      if (res && res.result) { S.project.transcript_opts = opts; loadTranscript(res.result.transcript); }
    } catch (e) { toast(e.message, true, 7000); }
  });

  function loadTranscript(tr) {
    pushUndo();
    S.project.transcript = tr;
    S.lines = (tr.lines || []).map((l) => ({ words: l.words.map((w) => ({ ...w })), _id: S.uid++ }));
    changed(); renderLines(); renderThumbsSoon();
    toast(`${S.lines.reduce((a, l) => a + l.words.length, 0)} words in ${S.lines.length} lines. Ctrl+Z goes back.`);
  }

  /* ================================================ DIALOG: FIND/REPLACE === */
  function findRegex() {
    const f = $('#fdFind').value;
    if (!f) return null;
    const escd = f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp($('#fdWhole').checked ? `(?<![\\p{L}\\p{N}'])${escd}(?![\\p{L}\\p{N}'])` : escd, 'giu');
  }
  function countMatches() {
    const re = findRegex();
    if (!re) { $('#fdCount').textContent = ''; return; }
    let n = 0;
    for (const ln of S.lines) n += (lineText(ln).match(re) || []).length;
    $('#fdCount').textContent = n === 1 ? '1 match' : `${n} matches`;
  }
  $('#btnFind').addEventListener('click', () => { $('#dlgFind').showModal(); $('#fdFind').focus(); countMatches(); });
  $('#fdFind').addEventListener('input', countMatches);
  $('#fdWhole').addEventListener('change', countMatches);
  $('#fdCancel').addEventListener('click', () => $('#dlgFind').close());
  $('#fdGo').addEventListener('click', () => {
    const re = findRegex();
    if (!re) return;
    const rep = $('#fdRep').value;
    pushUndo();
    const touched = [];
    S.lines.forEach((ln, li) => {
      const t = lineText(ln);
      const nt = t.replace(re, rep);
      if (nt !== t) { touched.push(li); commitLineText(li, nt, { noUndo: true, noSync: true }); }
    });
    // commitLineText removes lines that became empty; re-sync whatever is left
    const live = touched.filter((li) => S.lines[li] && S.lines[li]._dirty);
    renderLines();
    $('#dlgFind').close();
    toast(touched.length ? `Replaced in ${touched.length} line${touched.length > 1 ? 's' : ''}.` : 'Nothing matched.');
    if (live.length && $('#autoSync').checked) resyncLines(live);
  });

  /* ======================================================= DIALOG: EXPORT === */
  let exporting = null;
  $('#btnExport').addEventListener('click', openExport);
  function openExport() {
    const dlg = $('#dlgExport');
    const name = ($('#projName').value.trim() || 'captions') + (S.style._preset ? '_' + S.style._preset : '');
    const canBoth = !$('#viewTabs').hidden;
    $('#exVersionsRow').hidden = !canBoth;
    if (!canBoth) $('#exVersions').value = 'this';
    $('#exName').value = name;
    const sizes = [];
    if (S.kind === 'video') {
      sizes.push([`${S.W}x${S.H}`, `${S.W}×${S.H} (${S.view === 'vertical' ? 'vertical' : 'original'})`]);
      const short = Math.min(S.W, S.H);
      for (const target of [1080, 720]) {
        if (short > target) {
          const k = target / short;
          const w = Math.round(S.W * k / 2) * 2, h = Math.round(S.H * k / 2) * 2;
          sizes.push([`${w}x${h}`, `${w}×${h} (${target}p)`]);
        }
      }
    } else sizes.push([`${S.W}x${S.H}`, `${S.W}×${S.H}`]);
    $('#exSize').innerHTML = sizes.map(([v, l]) => `<option value="${v}">${l}</option>`).join('');
    const srcFps = (S.project.media.info && S.project.media.info.fps) || 30;
    const fpsOpts = S.kind === 'video'
      ? [[srcFps, `${+srcFps.toFixed(2)} (as filmed)`], [30, '30'], [60, '60']].filter((x, i, a) => i === 0 || Math.abs(x[0] - srcFps) > 0.05)
      : [[30, '30'], [60, '60'], [24, '24']];
    $('#exFps').innerHTML = fpsOpts.map(([v, l]) => `<option value="${v}">${l}</option>`).join('');
    $('#exProgress').hidden = true;
    $('#exOpen').hidden = true;
    $('#exGo').hidden = false; $('#exGo').disabled = false;
    $('#exClose').textContent = 'Close';
    updateFmt();
    dlg.showModal();
  }
  function updateFmt() {
    const f = $('input[name=fmt]:checked').value;
    $('#exportVideoOpts').hidden = f === 'srt';
    $('#exQuality').parentElement.hidden = f === 'mov';
  }
  $$('input[name=fmt]').forEach((r) => r.addEventListener('change', updateFmt));
  $('#exClose').addEventListener('click', async () => {
    if (exporting) { exporting.cancel = true; return; }
    $('#dlgExport').close();
  });
  $('#dlgExport').addEventListener('cancel', (e) => { if (exporting) e.preventDefault(); });
  $('#exOpen').addEventListener('click', () => POST('/api/open-folder', { path: $('#exOpen').dataset.path || '' }).catch((e) => toast(e.message, true)));
  $('#exGo').addEventListener('click', async () => {
    const fmt = $('input[name=fmt]:checked').value;
    if (fmt === 'srt') return exportSRT();
    const [w, h] = $('#exSize').value.split('x').map(Number);
    const base = { fmt, fps: +$('#exFps').value, quality: $('#exQuality').value };
    const name = $('#exName').value;
    const info = S.project.media.info || {};
    const job = (view, suffix) => {
      const vert = view === 'vertical';
      const vw = vert ? 1080 : (S.view === 'wide' ? w : info.width), vh = vert ? 1920 : (S.view === 'wide' ? h : info.height);
      const k = vert && S.view === 'vertical' ? w / 1080 : 1;           // 720p vertical scales the layout
      const g = vert ? geoFor('vertical') : null;
      return { ...base, view, w: Math.round(vw * k / 2) * 2, h: Math.round(vh * k / 2) * 2, name: name + suffix,
        style: styleFor(view), vertical: g && fmt === 'mp4' ? { ...SS.verticalForExport(g), scale: k } : null };
    };
    const jobs = $('#exVersions').value === 'both' ? [job('wide', '_wide'), job('vertical', '_vertical')] : [job(S.view, '')];
    const saved = [];
    for (const jb of jobs) {
      const res = await runExport(jb, jobs.length > 1 ? `${jobs.indexOf(jb) + 1}/${jobs.length} ${jb.view}` : '');
      if (!res) return;
      saved.push(res);
    }
    $('#exMsg').textContent = saved.map((r) => `Saved ${r.name} (${(r.size / 1048576).toFixed(1)} MB)`).join('  ·  ');
  });

  function srtTime(t) {
    const ms = Math.max(0, Math.round(t * 1000));
    const h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, s = Math.floor(ms / 1000) % 60, x = ms % 1000;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(x).padStart(3, '0')}`;
  }
  function wrap42(text) {
    if (text.length <= 42) return text;
    const words = text.split(' ');
    let best = text, bestScore = 1e9;
    for (let i = 1; i < words.length; i++) {
      const a = words.slice(0, i).join(' '), b = words.slice(i).join(' ');
      const score = Math.max(a.length, b.length) + (a.length > b.length ? 2 : 0);
      if (score < bestScore) { best = a + '\n' + b; bestScore = score; }
    }
    return best;
  }
  async function exportSRT() {
    const cues = [];
    const L = S.lines.filter((l) => l.words.length);
    L.forEach((ln, i) => {
      const s = ln.words[0].s, e0 = ln.words[ln.words.length - 1].e + 0.3;
      const next = L[i + 1];
      const e = next ? Math.min(e0, next.words[0].s - 0.04) : e0;
      cues.push(`${i + 1}\n${srtTime(s)} --> ${srtTime(Math.max(e, s + 0.3))}\n${wrap42(lineText(ln))}\n`);
    });
    try {
      const r = await POST('/api/save-text', { name: $('#exName').value, ext: '.srt', content: cues.join('\n') });
      $('#exProgress').hidden = false;
      $('#exBar').style.width = '100%';
      $('#exMsg').textContent = `Saved ${r.name}`;
      $('#exOpen').hidden = false; $('#exOpen').dataset.path = r.path;
    } catch (e) { toast(e.message, true); }
  }

  async function runExport(o, label = '') {
    const dur = S.duration || video.duration;
    if (!dur) { toast('The video length is unknown - wait for it to load.', true); return; }
    video.pause();
    const N = Math.ceil(dur * o.fps);
    const st = { ...(o.style || S.style) };
    await ensureFont(st);
    const prog = $('#exProgress'), bar = $('#exBar'), msg = $('#exMsg');
    prog.hidden = false; bar.style.width = '0%'; msg.textContent = 'Starting the encoder...';
    $('#exGo').disabled = true; $('#exOpen').hidden = true;
    $('#exClose').textContent = 'Cancel';
    exporting = { cancel: false };
    let sid = null;
    try {
      const start = await POST('/api/export/start', {
        pid: S.pid, format: o.fmt, width: o.w, height: o.h, fps: o.fps, frames: N,
        quality: o.quality, name: o.name, bgColor: S.exportCfg.bgColor, vertical: o.vertical || null,
      });
      sid = start.id;
      const r = new SS.Renderer();
      r.setSize(o.w, o.h); r.setLines(strip(S.lines)); r.setStyle(st);
      const POOL = 6;
      const pool = Array.from({ length: POOL }, () => new OffscreenCanvas(o.w, o.h));
      const pending = [];
      let batch = [], batchBytes = 0, prevKey = null, sent = 0;
      const t0 = performance.now();
      const send = async () => {
        if (!batch.length) return;
        const total = batch.reduce((a, b) => a + 9 + b.data.length, 0);
        const buf = new Uint8Array(total);
        const dv = new DataView(buf.buffer);
        let p = 0;
        for (const b of batch) { dv.setUint32(p, b.i, true); dv.setUint8(p + 4, b.kind); dv.setUint32(p + 5, b.data.length, true); buf.set(b.data, p + 9); p += 9 + b.data.length; }
        batch = []; batchBytes = 0;
        await api('POST', `/api/export/${sid}/frames`, buf, true);
      };
      const flushOne = async () => {
        const it = pending.shift();
        let data = new Uint8Array(0);
        if (it.kind === 0) data = new Uint8Array(await (await it.blob).arrayBuffer());
        batch.push({ i: it.i, kind: it.kind, data });
        batchBytes += data.length;
        sent = it.i + 1;
        if (batch.length >= 30 || batchBytes > 8e6) await send();
        if (sent % 15 === 0 || sent === N) {
          const el = (performance.now() - t0) / 1000;
          const rate = sent / el;
          bar.style.width = (sent / N * 100).toFixed(1) + '%';
          msg.textContent = `${label ? label + '  ·  ' : ''}Frame ${sent} of ${N}  ·  ${rate.toFixed(0)} fps  ·  about ${Math.max(0, Math.round((N - sent) / rate))} s left`;
        }
      };
      for (let i = 0; i < N; i++) {
        if (exporting.cancel) throw new Error('cancelled');
        const cv = pool[i % POOL];
        const ctx = cv.getContext('2d');
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, o.w, o.h);
        const key = r.render(ctx, i / o.fps, 1);
        let it;
        if (key === 'blank') it = { i, kind: 2 };
        else if (key === prevKey && key[0] !== 'a') it = { i, kind: 1 };
        else it = { i, kind: 0, blob: cv.convertToBlob({ type: 'image/png' }) };
        prevKey = key;
        pending.push(it);
        while (pending.length >= POOL) await flushOne();
      }
      while (pending.length) await flushOne();
      await send();
      msg.textContent = 'Finishing the file...';
      const res = await POST(`/api/export/${sid}/finish`);
      if (!res.ok) throw new Error(res.error + (res.log ? '\n' + res.log : ''));
      bar.style.width = '100%';
      msg.textContent = `Saved ${res.name}  ·  ${(res.size / 1048576).toFixed(1)} MB  ·  ${res.seconds}s`;
      $('#exOpen').hidden = false; $('#exOpen').dataset.path = res.path;
      return res;
    } catch (e) {
      if (sid) POST(`/api/export/${sid}/cancel`).catch(() => {});
      msg.textContent = e.message === 'cancelled' ? 'Cancelled.' : 'Export failed: ' + e.message;
      return null;
    } finally {
      exporting = null;
      $('#exGo').disabled = false;
      $('#exClose').textContent = 'Close';
    }
  }

  /* ========================================================== KEYS === */
  document.addEventListener('keydown', (e) => {
    if ($('#editor').hidden) return;
    const tag = (e.target.tagName || '').toLowerCase();
    const typing = (tag === 'input' && e.target.type !== 'range' && e.target.type !== 'checkbox') || tag === 'textarea' || tag === 'select';
    if (document.querySelector('dialog[open]')) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !typing) { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y' && !typing) { e.preventDefault(); redo(); return; }
    if (typing) return;
    if (e.key === ' ') { e.preventDefault(); togglePlay(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); seek(video.currentTime - (e.shiftKey ? 5 : 1)); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); seek(video.currentTime + (e.shiftKey ? 5 : 1)); }
    else if (e.key === 'Enter' && S.sel) { e.preventDefault(); startEdit(S.sel.li); }
    else if (e.key === 'Home') { e.preventDefault(); seek(0); }
  });

  $('#btnHome').addEventListener('click', () => {
    video.pause();
    $('#editor').hidden = true;
    $('#home').hidden = false;
    S.pid = null;
    loadRecent();
  });

  window.addEventListener('resize', () => { if (timeline) timeline.resize(); });

  // test hooks
  window.__studio = { S, renderer, openEditor, runExport, applyPreset, commitLineText, retime, splitWords };

  initHome();
})();
