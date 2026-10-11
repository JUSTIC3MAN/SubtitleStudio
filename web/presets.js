/* ==========================================================================
   presets.js - every caption setting, the controls that edit them, and the
   five built-in looks.

   Sizes are relative so a look keeps its proportions at any resolution:
     size            % of frame height
     stroke, shadow, glow, padding, lift ...   fractions of the font size (em)
     x, y, maxWidth  % of the frame
   ========================================================================== */
(function () {
  const SS = (window.SS = window.SS || {});

  /* -------------------------------------------------------------- fonts -- */
  // All SIL Open Font License / Apache 2.0 on Google Fonts: free for monetised video.
  SS.FONTS = [
    { family: 'Montserrat', cat: 'Sans', weights: [400, 600, 700, 800, 900], italic: true, css: 'Montserrat:ital,wght@0,400;0,600;0,700;0,800;0,900;1,700;1,800;1,900' },
    { family: 'Poppins', cat: 'Sans', weights: [400, 500, 600, 700, 800, 900], italic: true, css: 'Poppins:ital,wght@0,400;0,500;0,600;0,700;0,800;0,900;1,700;1,800' },
    { family: 'Inter', cat: 'Sans', weights: [400, 500, 600, 700, 800, 900], italic: true, css: 'Inter:ital,wght@0,400;0,500;0,600;0,700;0,800;0,900;1,700;1,800' },
    { family: 'TikTok Sans', cat: 'Sans', weights: [400, 700, 900], italic: false, css: 'TikTok+Sans:wght@400;700;900' },
    { family: 'Figtree', cat: 'Sans', weights: [400, 700, 900], italic: true, css: 'Figtree:ital,wght@0,400;0,700;0,900;1,700' },
    { family: 'Plus Jakarta Sans', cat: 'Sans', weights: [400, 700, 800], italic: true, css: 'Plus+Jakarta+Sans:ital,wght@0,400;0,700;0,800;1,700' },
    { family: 'Outfit', cat: 'Sans', weights: [400, 600, 800, 900], italic: false, css: 'Outfit:wght@400;600;800;900' },
    { family: 'Rubik', cat: 'Sans', weights: [400, 700, 900], italic: true, css: 'Rubik:ital,wght@0,400;0,700;0,900;1,700' },
    { family: 'Space Grotesk', cat: 'Sans', weights: [400, 500, 700], italic: false, css: 'Space+Grotesk:wght@400;500;700' },
    { family: 'Syne', cat: 'Display', weights: [400, 600, 700, 800], italic: false, css: 'Syne:wght@400;600;700;800' },
    { family: 'Unbounded', cat: 'Display', weights: [400, 700, 900], italic: false, css: 'Unbounded:wght@400;700;900' },
    { family: 'Archivo Black', cat: 'Heavy', weights: [400], italic: false, css: 'Archivo+Black' },
    { family: 'Anton', cat: 'Condensed', weights: [400], italic: false, css: 'Anton' },
    { family: 'Bebas Neue', cat: 'Condensed', weights: [400], italic: false, css: 'Bebas+Neue' },
    { family: 'Oswald', cat: 'Condensed', weights: [400, 500, 600, 700], italic: false, css: 'Oswald:wght@400;500;600;700' },
    { family: 'Barlow Condensed', cat: 'Condensed', weights: [500, 700, 800, 900], italic: true, css: 'Barlow+Condensed:ital,wght@0,500;0,700;0,800;0,900;1,700;1,800' },
    { family: 'Teko', cat: 'Condensed', weights: [400, 500, 600, 700], italic: false, css: 'Teko:wght@400;500;600;700' },
    { family: 'Instrument Serif', cat: 'Serif', weights: [400], italic: true, css: 'Instrument+Serif:ital@0;1' },
    { family: 'Playfair Display', cat: 'Serif', weights: [400, 700, 900], italic: true, css: 'Playfair+Display:ital,wght@0,400;0,700;0,900;1,400;1,700' },
    { family: 'DM Serif Display', cat: 'Serif', weights: [400], italic: true, css: 'DM+Serif+Display:ital@0;1' },
    { family: 'Cormorant Garamond', cat: 'Serif', weights: [400, 600, 700], italic: true, css: 'Cormorant+Garamond:ital,wght@0,400;0,600;0,700;1,400;1,600' },
    { family: 'Luckiest Guy', cat: 'Fun', weights: [400], italic: false, css: 'Luckiest+Guy' },
    { family: 'Bangers', cat: 'Fun', weights: [400], italic: false, css: 'Bangers' },
    { family: 'Lilita One', cat: 'Fun', weights: [400], italic: false, css: 'Lilita+One' },
    { family: 'Titan One', cat: 'Fun', weights: [400], italic: false, css: 'Titan+One' },
    { family: 'Bungee', cat: 'Fun', weights: [400], italic: false, css: 'Bungee' },
    { family: 'Righteous', cat: 'Fun', weights: [400], italic: false, css: 'Righteous' },
    { family: 'Russo One', cat: 'Fun', weights: [400], italic: false, css: 'Russo+One' },
    { family: 'Permanent Marker', cat: 'Hand', weights: [400], italic: false, css: 'Permanent+Marker' },
    { family: 'Caveat', cat: 'Hand', weights: [400, 700], italic: false, css: 'Caveat:wght@400;700' },
    { family: 'Kalam', cat: 'Hand', weights: [400, 700], italic: false, css: 'Kalam:wght@400;700' },
    { family: 'Special Elite', cat: 'Typewriter', weights: [400], italic: false, css: 'Special+Elite' },
    { family: 'Monoton', cat: 'Neon', weights: [400], italic: false, css: 'Monoton' },
  ];
  SS.fontInfo = (family) => SS.FONTS.find((f) => f.family === family) || SS.FONTS[0];

  /* ----------------------------------------------------------- defaults -- */
  SS.DEFAULT_STYLE = {
    // layout
    display: 'pages', maxWords: 3, maxRows: 2, maxWidth: 84, x: 50, y: 64, align: 'center', nextLines: 1,
    // text
    font: 'Montserrat', weight: 800, italic: false, size: 5.4, textCase: 'none',
    tracking: 0, lineHeight: 1.1, wordGap: 1, punctuation: 'soft',
    // colour
    color: '#ffffff', activeColor: '#ffe135', pastColor: '', futureOpacity: 1,
    keyColor: '#3cff6e', keyScale: 1.0,
    // highlight
    highlight: 'color', boxColor: '#b6ff3b', boxText: '#0a0a0a', boxRadius: 0.22, boxPadX: 0.16, boxPadY: 0.06, boxSlide: 0.12,
    // outline / shadow / glow
    stroke: 0.1, strokeColor: '#000000',
    shadow: true, shadowColor: '#000000', shadowOpacity: 0.5, shadowBlur: 0.12, shadowX: 0, shadowY: 0.06,
    glow: false, glowColor: '#ffffff', glowSize: 0.35, glowStrength: 0.6, glowActiveOnly: true,
    // backdrop behind the whole caption
    backdrop: false, backdropColor: '#000000', backdropOpacity: 0.55, backdropPadX: 0.4, backdropPadY: 0.22, backdropRadius: 0.25,
    // motion
    reveal: 'page', inAnim: 'pop', inDur: 0.16, inStagger: 0,
    activeScale: 1.06, activeLift: 0, activeDur: 0.1,
    outAnim: 'none', outDur: 0.2,
    // emphasis (loudness comes from the isolated vocal)
    loudSize: 0, loudColorOn: false, loudColor: '#ff3d3d', loudThreshold: 0.75, jitter: 0, shake: 0,
    // timing
    leadIn: 0.05, hold: 0.25, minDur: 0.4, gapFill: 0.6,
  };

  /* ------------------------------------------------------- the five looks -- */
  /*
    Each look is grounded in what the caption world actually uses; see
    README "Why these five" for the research and sources.
  */
  SS.PRESETS = [
    {
      id: 'viral',
      name: 'Viral Bold',
      blurb: 'The short-form standard: 2-3 heavy words at a time, the spoken word lights up.',
      sample: 'THIS IS THE ONE',
      style: {
        display: 'pages', maxWords: 3, maxRows: 2, maxWidth: 84, x: 50, y: 63, align: 'center',
        font: 'Montserrat', weight: 900, size: 5.6, textCase: 'upper', tracking: -0.01, lineHeight: 1.04, punctuation: 'strip',
        color: '#ffffff', activeColor: '#ffd93d', futureOpacity: 1, keyColor: '#39ff14', keyScale: 1.08,
        highlight: 'color', stroke: 0.11, strokeColor: '#000000',
        shadow: true, shadowColor: '#000000', shadowOpacity: 0.55, shadowBlur: 0.1, shadowX: 0, shadowY: 0.05,
        glow: false, backdrop: false,
        reveal: 'page', inAnim: 'pop', inDur: 0.14, inStagger: 0, activeScale: 1.05, activeLift: 0, activeDur: 0.08,
        outAnim: 'none', outDur: 0.15, loudSize: 0, loudColorOn: false, jitter: 0, shake: 0,
        leadIn: 0.04, hold: 0.2, minDur: 0.35, gapFill: 0.5,
      },
      landscape: { y: 78, size: 7.2, maxWidth: 70 },
    },
    {
      id: 'box',
      name: 'Highlight Box',
      blurb: 'A coloured box slides from word to word under the voice. The CapCut / Submagic look.',
      sample: 'follow the box now',
      style: {
        display: 'pages', maxWords: 4, maxRows: 2, maxWidth: 86, x: 50, y: 64, align: 'center',
        font: 'Poppins', weight: 800, size: 4.9, textCase: 'none', tracking: -0.005, lineHeight: 1.18, punctuation: 'soft', wordGap: 1.05,
        color: '#ffffff', activeColor: '#ffffff', futureOpacity: 1, keyColor: '#ffd93d', keyScale: 1,
        highlight: 'box', boxColor: '#a3ff12', boxText: '#0b0d07', boxRadius: 0.24, boxPadX: 0.17, boxPadY: 0.04, boxSlide: 0.11,
        stroke: 0.06, strokeColor: '#000000',
        shadow: true, shadowColor: '#000000', shadowOpacity: 0.45, shadowBlur: 0.18, shadowX: 0, shadowY: 0.05,
        glow: false, backdrop: false,
        reveal: 'page', inAnim: 'rise', inDur: 0.16, inStagger: 0.03, activeScale: 1.04, activeLift: 0, activeDur: 0.1,
        outAnim: 'fade', outDur: 0.1, loudSize: 0, loudColorOn: false, jitter: 0, shake: 0,
        leadIn: 0.05, hold: 0.25, minDur: 0.4, gapFill: 0.5,
      },
      landscape: { y: 80, size: 6.4, maxWidth: 72 },
    },
    {
      id: 'synced',
      name: 'Synced Lyrics',
      blurb: 'Apple Music style: the line fills in as it is sung, the next line waits underneath.',
      sample: 'singing every word in time',
      style: {
        display: 'stack', nextLines: 1, maxWords: 8, maxRows: 2, maxWidth: 84, x: 8, y: 70, align: 'left',
        font: 'Inter', weight: 800, size: 4.6, textCase: 'none', tracking: -0.025, lineHeight: 1.12, punctuation: 'soft',
        color: '#ffffff', activeColor: '#ffffff', futureOpacity: 0.34, keyColor: '#ffffff', keyScale: 1,
        highlight: 'wipe', stroke: 0, strokeColor: '#000000',
        shadow: true, shadowColor: '#000000', shadowOpacity: 0.38, shadowBlur: 0.3, shadowX: 0, shadowY: 0.03,
        glow: true, glowColor: '#ffffff', glowSize: 0.32, glowStrength: 0.55, glowActiveOnly: true,
        backdrop: false,
        reveal: 'page', inAnim: 'rise', inDur: 0.36, inStagger: 0, activeScale: 1.0, activeLift: 0.04, activeDur: 0.18,
        outAnim: 'fade', outDur: 0.3, loudSize: 0, loudColorOn: false, jitter: 0, shake: 0,
        leadIn: 0.25, hold: 0.5, minDur: 0.9, gapFill: 1.6,
      },
      landscape: { x: 7, y: 74, size: 6.2, maxWidth: 70 },
    },
    {
      id: 'cinematic',
      name: 'Cinematic',
      blurb: 'Film-subtitle restraint: italic serif, words breathe in out of a soft blur.',
      sample: 'and the night went quiet',
      style: {
        display: 'lines', maxWords: 10, maxRows: 2, maxWidth: 80, x: 50, y: 76, align: 'center',
        font: 'Instrument Serif', weight: 400, italic: true, size: 4.5, textCase: 'none', tracking: 0.005, lineHeight: 1.16, punctuation: 'soft', wordGap: 1,
        color: '#f4efe6', activeColor: '#f4efe6', futureOpacity: 0, keyColor: '#f2c879', keyScale: 1,
        highlight: 'none', stroke: 0, strokeColor: '#000000',
        shadow: true, shadowColor: '#000000', shadowOpacity: 0.65, shadowBlur: 0.28, shadowX: 0, shadowY: 0.04,
        glow: false, backdrop: false,
        reveal: 'word', inAnim: 'blur', inDur: 0.38, inStagger: 0, activeScale: 1.0, activeLift: 0, activeDur: 0.1,
        outAnim: 'fade', outDur: 0.35, loudSize: 0, loudColorOn: false, jitter: 0, shake: 0,
        leadIn: 0.06, hold: 0.7, minDur: 1.0, gapFill: 1.0,
      },
      landscape: { y: 86, size: 5.6, maxWidth: 76 },
    },
    {
      id: 'kinetic',
      name: 'Rap Kinetic',
      blurb: 'One or two words slam in on the beat, sized by how hard you hit them.',
      sample: 'RUN IT BACK',
      style: {
        display: 'pages', maxWords: 2, maxRows: 2, maxWidth: 90, x: 50, y: 50, align: 'center',
        font: 'Anton', weight: 400, size: 9.2, textCase: 'upper', tracking: 0.012, lineHeight: 0.98, punctuation: 'strip',
        color: '#ffffff', activeColor: '#ffffff', futureOpacity: 0, keyColor: '#ffd400', keyScale: 1.15,
        highlight: 'none', stroke: 0.07, strokeColor: '#000000',
        shadow: true, shadowColor: '#000000', shadowOpacity: 1, shadowBlur: 0, shadowX: 0.055, shadowY: 0.055,
        glow: false, backdrop: false,
        reveal: 'word', inAnim: 'slam', inDur: 0.13, inStagger: 0, activeScale: 1.0, activeLift: 0, activeDur: 0.1,
        outAnim: 'none', outDur: 0.1, loudSize: 0.5, loudColorOn: true, loudColor: '#ff3b30', loudThreshold: 0.8,
        jitter: 3, shake: 0.035,
        leadIn: 0.02, hold: 0.18, minDur: 0.3, gapFill: 0.35,
      },
      landscape: { y: 52, size: 13 },
    },
  ];

  SS.presetStyle = function (id, landscape) {
    const p = SS.PRESETS.find((x) => x.id === id);
    if (!p) return { ...SS.DEFAULT_STYLE };
    return { ...SS.DEFAULT_STYLE, ...p.style, ...(landscape ? p.landscape || {} : {}), _preset: id };
  };

  /* ----------------------------------------------------------- controls -- */
  const o = (pairs) => pairs.map(([v, l]) => ({ v, l: l ?? v }));
  const isBox = (s) => s.highlight === 'box' || s.highlight === 'underline';

  SS.CONTROLS = [
    {
      group: 'Layout', open: true, items: [
        { k: 'display', label: 'Show', type: 'select', options: o([['pages', 'A few words at a time'], ['lines', 'Whole line'], ['stack', 'Line + next line (lyrics)']]) },
        { k: 'maxWords', label: 'Words at a time', type: 'range', min: 1, max: 8, step: 1, show: (s) => s.display === 'pages' },
        { k: 'nextLines', label: 'Upcoming lines shown', type: 'range', min: 0, max: 3, step: 1, show: (s) => s.display === 'stack' },
        { k: 'maxRows', label: 'Max rows', type: 'range', min: 1, max: 3, step: 1 },
        { k: 'maxWidth', label: 'Max width', type: 'range', min: 30, max: 100, step: 1, unit: '%' },
        { k: 'y', label: 'Height on screen', type: 'range', min: 5, max: 95, step: 0.5, unit: '%' },
        { k: 'x', label: 'Left / right', type: 'range', min: 0, max: 100, step: 0.5, unit: '%' },
        { k: 'align', label: 'Align', type: 'seg', options: o([['left', 'Left'], ['center', 'Centre'], ['right', 'Right']]) },
      ],
    },
    {
      group: 'Text', open: true, items: [
        { k: 'font', label: 'Font', type: 'font' },
        { k: 'weight', label: 'Weight', type: 'weight' },
        { k: 'italic', label: 'Italic', type: 'toggle' },
        { k: 'size', label: 'Size', type: 'range', min: 1.5, max: 16, step: 0.1, unit: '%' },
        { k: 'textCase', label: 'Case', type: 'seg', options: o([['none', 'As said'], ['upper', 'CAPS'], ['lower', 'lower']]) },
        { k: 'punctuation', label: 'Punctuation', type: 'seg', options: o([['keep', 'Keep'], ['soft', 'No commas'], ['strip', 'None']]) },
        { k: 'tracking', label: 'Letter spacing', type: 'range', min: -0.08, max: 0.4, step: 0.005, unit: 'em' },
        { k: 'lineHeight', label: 'Line height', type: 'range', min: 0.75, max: 1.8, step: 0.01 },
        { k: 'wordGap', label: 'Word spacing', type: 'range', min: 0.4, max: 2.5, step: 0.05 },
      ],
    },
    {
      group: 'Colour & highlight', open: true, items: [
        { k: 'color', label: 'Text', type: 'color' },
        { k: 'highlight', label: 'Spoken word', type: 'select', options: o([['none', 'No highlight'], ['color', 'Changes colour'], ['box', 'Box behind it'], ['underline', 'Underline'], ['wipe', 'Fills in as sung']]) },
        { k: 'activeColor', label: 'Highlight colour', type: 'color', show: (s) => s.highlight === 'color' || s.highlight === 'wipe' },
        { k: 'boxColor', label: 'Box colour', type: 'color', show: isBox },
        { k: 'boxText', label: 'Text on box', type: 'color', show: (s) => s.highlight === 'box' },
        { k: 'boxRadius', label: 'Box rounding', type: 'range', min: 0, max: 0.6, step: 0.01, show: (s) => s.highlight === 'box' },
        { k: 'boxPadX', label: 'Box padding', type: 'range', min: 0, max: 0.5, step: 0.01, show: (s) => s.highlight === 'box' },
        { k: 'boxSlide', label: 'Box slide time', type: 'range', min: 0, max: 0.4, step: 0.01, unit: 's', show: isBox },
        { k: 'futureOpacity', label: 'Not-yet-sung words', type: 'range', min: 0, max: 1, step: 0.01, show: (s) => s.reveal === 'page' },
        { k: 'pastColor', label: 'Already-sung colour', type: 'color', optional: true },
        { k: 'keyColor', label: 'Key word colour', type: 'color', help: 'Alt-click a word in the transcript to make it a key word.' },
        { k: 'keyScale', label: 'Key word size', type: 'range', min: 0.8, max: 1.6, step: 0.01 },
      ],
    },
    {
      group: 'Outline, shadow & glow', items: [
        { k: 'stroke', label: 'Outline', type: 'range', min: 0, max: 0.3, step: 0.005, unit: 'em' },
        { k: 'strokeColor', label: 'Outline colour', type: 'color', show: (s) => s.stroke > 0 },
        { k: 'shadow', label: 'Shadow', type: 'toggle' },
        { k: 'shadowColor', label: 'Shadow colour', type: 'color', show: (s) => s.shadow },
        { k: 'shadowOpacity', label: 'Shadow strength', type: 'range', min: 0, max: 1, step: 0.01, show: (s) => s.shadow },
        { k: 'shadowBlur', label: 'Shadow softness', type: 'range', min: 0, max: 0.8, step: 0.01, unit: 'em', show: (s) => s.shadow },
        { k: 'shadowX', label: 'Shadow X', type: 'range', min: -0.2, max: 0.2, step: 0.005, unit: 'em', show: (s) => s.shadow },
        { k: 'shadowY', label: 'Shadow Y', type: 'range', min: -0.2, max: 0.2, step: 0.005, unit: 'em', show: (s) => s.shadow },
        { k: 'glow', label: 'Glow', type: 'toggle' },
        { k: 'glowColor', label: 'Glow colour', type: 'color', show: (s) => s.glow },
        { k: 'glowSize', label: 'Glow size', type: 'range', min: 0.05, max: 1.2, step: 0.01, unit: 'em', show: (s) => s.glow },
        { k: 'glowStrength', label: 'Glow strength', type: 'range', min: 0.1, max: 1, step: 0.01, show: (s) => s.glow },
        { k: 'glowActiveOnly', label: 'Glow only on the spoken word', type: 'toggle', show: (s) => s.glow },
      ],
    },
    {
      group: 'Background box', items: [
        { k: 'backdrop', label: 'Box behind caption', type: 'toggle' },
        { k: 'backdropColor', label: 'Colour', type: 'color', show: (s) => s.backdrop },
        { k: 'backdropOpacity', label: 'Opacity', type: 'range', min: 0, max: 1, step: 0.01, show: (s) => s.backdrop },
        { k: 'backdropPadX', label: 'Padding sides', type: 'range', min: 0, max: 1.2, step: 0.01, unit: 'em', show: (s) => s.backdrop },
        { k: 'backdropPadY', label: 'Padding top/bottom', type: 'range', min: 0, max: 1, step: 0.01, unit: 'em', show: (s) => s.backdrop },
        { k: 'backdropRadius', label: 'Rounding', type: 'range', min: 0, max: 1, step: 0.01, unit: 'em', show: (s) => s.backdrop },
      ],
    },
    {
      group: 'Motion', items: [
        { k: 'reveal', label: 'Words appear', type: 'seg', options: o([['page', 'All together'], ['word', 'As spoken']]) },
        { k: 'inAnim', label: 'Entrance', type: 'select', options: o([['none', 'None (cut)'], ['fade', 'Fade'], ['pop', 'Pop'], ['rise', 'Rise'], ['drop', 'Drop'], ['slam', 'Slam'], ['blur', 'Blur in'], ['typewriter', 'Typewriter']]) },
        { k: 'inDur', label: 'Entrance time', type: 'range', min: 0, max: 0.8, step: 0.01, unit: 's' },
        { k: 'inStagger', label: 'Stagger', type: 'range', min: 0, max: 0.15, step: 0.005, unit: 's', show: (s) => s.reveal === 'page' },
        { k: 'activeScale', label: 'Spoken word grows', type: 'range', min: 0.9, max: 1.4, step: 0.01 },
        { k: 'activeLift', label: 'Spoken word lifts', type: 'range', min: 0, max: 0.3, step: 0.005, unit: 'em' },
        { k: 'activeDur', label: 'Grow time', type: 'range', min: 0.02, max: 0.4, step: 0.01, unit: 's' },
        { k: 'outAnim', label: 'Exit', type: 'select', options: o([['none', 'None (cut)'], ['fade', 'Fade'], ['rise', 'Rise away'], ['blur', 'Blur out'], ['shrink', 'Shrink']]) },
        { k: 'outDur', label: 'Exit time', type: 'range', min: 0.02, max: 0.8, step: 0.01, unit: 's', show: (s) => s.outAnim !== 'none' },
      ],
    },
    {
      group: 'Emphasis', items: [
        { k: 'loudSize', label: 'Louder words bigger', type: 'range', min: 0, max: 1, step: 0.01, help: 'Measured from the vocal, word by word.' },
        { k: 'loudColorOn', label: 'Colour the loudest words', type: 'toggle' },
        { k: 'loudColor', label: 'Loud colour', type: 'color', show: (s) => s.loudColorOn },
        { k: 'loudThreshold', label: 'How loud counts', type: 'range', min: 0.4, max: 1, step: 0.01, show: (s) => s.loudColorOn },
        { k: 'jitter', label: 'Random tilt', type: 'range', min: 0, max: 12, step: 0.5, unit: '°' },
        { k: 'shake', label: 'Shake on loud words', type: 'range', min: 0, max: 0.15, step: 0.005, unit: 'em' },
      ],
    },
    {
      group: 'Timing', items: [
        { k: 'leadIn', label: 'Show before the voice', type: 'range', min: 0, max: 0.6, step: 0.01, unit: 's' },
        { k: 'hold', label: 'Hold after', type: 'range', min: 0, max: 1.5, step: 0.01, unit: 's' },
        { k: 'minDur', label: 'Minimum on screen', type: 'range', min: 0.1, max: 2, step: 0.01, unit: 's' },
        { k: 'gapFill', label: 'Bridge gaps shorter than', type: 'range', min: 0, max: 3, step: 0.05, unit: 's' },
      ],
    },
  ];
})();
