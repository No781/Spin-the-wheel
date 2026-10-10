(() => {
  'use strict';

  const TAU = Math.PI * 2;
  const STORAGE_KEY = 'spin-the-wheel:v1';
  const MAX_OPTIONS = 60;
  const FONT = '"DM Sans", system-ui, -apple-system, "Segoe UI", sans-serif';

  // Coastal palette: sea blues, forest mosses and driftwood browns, alternating families so neighbours differ.
  const PALETTE = [
    '#6b8350', '#4f86a0', '#94653f', '#93a362', '#86b0bd',
    '#3f6149', '#b8946a', '#355f7a', '#a9784f', '#5e9690',
  ];

  const DEFAULTS = [['Pizza', 3], ['Tacos', 2], ['Sushi', 2], ['Ramen', 1], ['Salad', 1]];
  const EYEBROWS = ['The wheel has spoken', 'Fate says', 'And the winner is', 'Destiny picked', 'It landed on'];

  const $ = (id) => document.getElementById(id);
  const els = {
    wrap: $('wheel-wrap'), canvas: $('wheel'), pointer: $('pointer'), hub: $('hub'),
    spin: $('spin'), status: $('status'), list: $('list'), count: $('count'), panel: document.querySelector('.panel'),
    addForm: $('add-form'), addName: $('add-name'), addWeight: $('add-weight'),
    equalize: $('equalize'), share: $('share'), clear: $('clear'),
    optRemove: $('opt-remove'), optSound: $('opt-sound'),
    history: $('history'), historyList: $('history-list'), clearHistory: $('clear-history'),
    dialog: $('result'), rSwatch: $('result-swatch'), rEyebrow: $('result-eyebrow'), rName: $('result-name'),
    rChance: $('result-chance'), rNote: $('result-note'), rAgain: $('result-again'), rClose: $('result-close'),
    confetti: $('confetti'), toast: $('toast'),
    eyebrow: $('eyebrow'), lede: $('lede'), panelTitle: $('panel-title'),
    editor: $('editor'), viewer: $('viewer-list'), makeOwn: $('make-own'),
    send: $('send'), sendOpen: $('send-open'), sendClose: $('send-close'), sendTitle: $('send-title'),
    sendNames: $('send-names'), sendCreate: $('send-create'), sendOut: $('send-out'), sendLinks: $('send-links'),
    sendCopyAll: $('send-copy-all'), sendFileNote: $('send-file-note'),
    lookupUrl: $('lookup-url'), lookupGo: $('lookup-go'), lookupOut: $('lookup-out'),
    liveOpen: $('live-open'), liveBar: $('live-bar'), liveDot: $('live-dot'), liveText: $('live-text'),
    livePeers: $('live-peers'), liveName: $('live-name'), liveCopy: $('live-copy'), liveLeave: $('live-leave'),
    liveRtt: $('live-rtt'), liveReact: $('live-react'), liveActivity: $('live-activity'), reactions: $('reactions'),
  };
  const ctx = els.canvas.getContext('2d');

  const state = { options: [], removeWinner: false, sound: true, history: [] };
  let rotation = 0;
  let spinning = false;
  let pointerKick = 0;
  let theme = {};
  let playMode = false; // opened from a personal link: read-only wheel with a fixed outcome
  let playInfo = null;
  let live = null;      // set when this page is in a shared live room (see "live rooms" below)

  const mod = (a, n) => ((a % n) + n) % n;
  const prefersReducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function rand() {
    if (window.crypto && crypto.getRandomValues) {
      const b = new Uint32Array(1);
      crypto.getRandomValues(b);
      return b[0] / 4294967296;
    }
    return Math.random();
  }

  /* ---------------- state ---------------- */

  const ID_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';
  function randomId(n) {
    let s = '';
    for (let i = 0; i < n; i++) s += ID_ALPHABET[Math.floor(rand() * ID_ALPHABET.length)];
    return s;
  }

  const makeOption = (name, weight, id) => ({ id: id || `o${randomId(7)}`, name: String(name), weight: Number(weight) });

  function cleanWeight(v) {
    const n = typeof v === 'number' ? v : parseFloat(v);
    return Number.isFinite(n) && n > 0 ? Math.min(n, 10000) : 0;
  }

  function save() {
    if (playMode || live) return; // never overwrite the visitor's own saved list
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        options: state.options.map((o) => [o.name, o.weight]),
        removeWinner: state.removeWinner,
        sound: state.sound,
        history: state.history,
      }));
    } catch (_) { /* storage unavailable */ }
  }

  function parsePairs(data) {
    if (!Array.isArray(data)) return null;
    const out = [];
    for (const row of data.slice(0, MAX_OPTIONS)) {
      if (!Array.isArray(row)) continue;
      out.push(makeOption(String(row[0] ?? '').slice(0, 60), cleanWeight(row[1])));
    }
    return out;
  }

  /* ---------------- personal links ---------------- */

  const LINK_PREFIX = '#s=';

  function b64Encode(obj) {
    let bin = '';
    new TextEncoder().encode(JSON.stringify(obj)).forEach((b) => { bin += String.fromCharCode(b); });
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function b64Decode(str) {
    const bin = atob(str.replace(/-/g, '+').replace(/_/g, '/'));
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
  }

  // Returns {t: title, n: name, k: seed, o: [[name, weight], ...]} or null if the payload isn't valid.
  function parsePersonal(encoded) {
    try {
      const d = b64Decode(encoded);
      if (!d || typeof d.k !== 'string' || !/^[A-Za-z0-9_-]{4,40}$/.test(d.k)) return null;
      if (!Array.isArray(d.o) || d.o.length < 2 || d.o.length > MAX_OPTIONS) return null;
      const o = d.o.map((r) => [String(r[0] ?? '').trim().slice(0, 60), cleanWeight(r[1])]).filter((r) => r[0] && r[1] > 0);
      if (o.length < 2) return null;
      return { t: String(d.t || '').slice(0, 80), n: String(d.n || '').slice(0, 40), k: d.k, o };
    } catch (_) { return null; }
  }

  // Deterministic float in [0, 1) from a string seed (xmur3 hash feeding sfc32).
  function seededUnit(seed) {
    let h = 1779033703 ^ seed.length;
    for (let i = 0; i < seed.length; i++) {
      h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
      h = (h << 13) | (h >>> 19);
    }
    const hash = () => {
      h = Math.imul(h ^ (h >>> 16), 2246822507);
      h = Math.imul(h ^ (h >>> 13), 3266489909);
      return (h ^= h >>> 16) >>> 0;
    };
    let a = hash(), b = hash(), c = hash(), d = hash();
    const next = () => {
      a >>>= 0; b >>>= 0; c >>>= 0; d >>>= 0;
      let t = (a + b) | 0;
      a = b ^ (b >>> 9);
      b = (c + (c << 3)) | 0;
      c = (c << 21) | (c >>> 11);
      d = (d + 1) | 0;
      t = (t + d) | 0;
      c = (c + t) | 0;
      return (t >>> 0) / 4294967296;
    };
    for (let i = 0; i < 15; i++) next();
    return next();
  }

  function pickIndex(weights, r) {
    const total = weights.reduce((s, w) => s + w, 0);
    let x = r * total;
    for (let i = 0; i < weights.length; i++) {
      if (x < weights[i]) return i;
      x -= weights[i];
    }
    return weights.length - 1;
  }

  const winnerFor = (p) => p.o[pickIndex(p.o.map((r) => r[1]), seededUnit(p.k))][0];

  function load() {
    if (/^#r=[a-z0-9]{6,24}$/.test(location.hash)) {
      live = makeLive(location.hash.slice(3));
      return;
    }
    if (location.hash.startsWith(LINK_PREFIX)) {
      const info = parsePersonal(location.hash.slice(LINK_PREFIX.length));
      if (info) {
        playMode = true;
        playInfo = info;
        state.options = info.o.map(([n, w]) => makeOption(n, w));
        return;
      }
    }

    let loaded = null;
    try {
      const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
      if (raw) {
        loaded = parsePairs(raw.options);
        state.removeWinner = !!raw.removeWinner;
        state.sound = raw.sound !== false;
        if (Array.isArray(raw.history)) {
          state.history = raw.history
            .filter((h) => h && typeof h.name === 'string')
            .slice(0, 12)
            .map((h) => ({ name: h.name.slice(0, 60), color: typeof h.color === 'string' ? h.color : PALETTE[0] }));
        }
      }
    } catch (_) { /* ignore corrupt storage */ }

    if (location.hash.startsWith('#o=')) {
      try {
        const shared = parsePairs(JSON.parse(decodeURIComponent(location.hash.slice(3))));
        if (shared && shared.length) loaded = shared;
      } catch (_) { /* ignore bad link */ }
      history.replaceState(null, '', location.pathname + location.search);
    }

    state.options = loaded || DEFAULTS.map(([n, w]) => makeOption(n, w));
  }

  /* ---------------- derived data ---------------- */

  const active = () => state.options.filter((o) => o.name.trim() && o.weight > 0);

  function colorMap() {
    const act = active();
    const map = new Map();
    act.forEach((o, i) => {
      let idx = i % PALETTE.length;
      // avoid the last slice matching the first when the palette wraps
      if (i === act.length - 1 && i > 0 && idx === 0) idx = Math.floor(PALETTE.length / 2);
      map.set(o.id, PALETTE[idx]);
    });
    return map;
  }

  const fmtPct = (p) => `${+p.toFixed(1)}%`;

  /* ---------------- drawing ---------------- */

  function readTheme() {
    const cs = getComputedStyle(document.documentElement);
    const v = (name) => cs.getPropertyValue(name).trim();
    theme = { card: v('--card'), ink: v('--ink'), inkSoft: v('--ink-soft'), rim: v('--rim'), peg: v('--peg'), empty: v('--bg-deep') };
  }

  function luminance(hex) {
    const n = parseInt(hex.slice(1), 16);
    const lin = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * lin(n >> 16) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
  }

  // Pick whichever of the dark/light label colours has more contrast against the slice.
  const INK_DARK = '#1c140e';
  const INK_LIGHT = '#f6efe0';
  function inkOn(hex) {
    const l = luminance(hex);
    const contrast = (other) => (Math.max(l, other) + 0.05) / (Math.min(l, other) + 0.05);
    return contrast(luminance(INK_DARK)) >= contrast(luminance(INK_LIGHT)) ? INK_DARK : INK_LIGHT;
  }

  function draw() {
    const size = els.canvas.clientWidth;
    if (!size) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const px = Math.round(size * dpr);
    if (els.canvas.width !== px) { els.canvas.width = px; els.canvas.height = px; }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size, size);

    const c = size / 2;
    const outer = c - size * 0.014;
    const R = outer - size * 0.05;
    const act = active();
    const total = act.reduce((s, o) => s + o.weight, 0);
    const colors = colorMap();

    // rim
    ctx.beginPath();
    ctx.arc(c, c, outer, 0, TAU);
    ctx.fillStyle = theme.rim;
    ctx.fill();

    if (!act.length) {
      ctx.beginPath();
      ctx.arc(c, c, R, 0, TAU);
      ctx.fillStyle = theme.empty;
      ctx.fill();
      ctx.fillStyle = theme.inkSoft;
      ctx.font = `italic 500 ${size * 0.045}px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('Add some options', c, c + size * 0.15);
      return;
    }

    ctx.save();
    ctx.translate(c, c);
    ctx.rotate(rotation);

    // slices
    const bounds = [];
    let a = 0;
    act.forEach((o) => {
      const span = (o.weight / total) * TAU;
      bounds.push([a, a + span]);
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.arc(0, 0, R, a, a + span);
      ctx.closePath();
      ctx.fillStyle = colors.get(o.id);
      ctx.fill();
      if (act.length > 1) {
        ctx.lineWidth = Math.max(1.5, size * 0.004);
        ctx.strokeStyle = theme.card;
        ctx.stroke();
      }
      a += span;
    });

    // labels
    const textEdge = R - size * 0.04;
    const maxW = textEdge - size * 0.13;
    const innerR = textEdge - maxW * 0.5;
    act.forEach((o, i) => {
      const [s, e] = bounds[i];
      const span = e - s;
      const fs = Math.min(size * 0.052, span * innerR * 0.5);
      if (fs < 8.5) return;
      ctx.save();
      ctx.rotate(s + span / 2);
      ctx.font = `600 ${fs}px ${FONT}`;
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = inkOn(colors.get(o.id));
      let label = o.name.trim();
      if (ctx.measureText(label).width > maxW) {
        while (label.length > 1 && ctx.measureText(label + '…').width > maxW) label = label.slice(0, -1);
        label = label.trimEnd() + '…';
      }
      ctx.fillText(label, textEdge, 0);
      ctx.restore();
    });

    // pegs on the rim
    if (act.length > 1) {
      ctx.fillStyle = theme.peg;
      const pegR = size * 0.0085;
      const pegPos = R + size * 0.025;
      bounds.forEach(([s]) => {
        ctx.beginPath();
        ctx.arc(Math.cos(s) * pegPos, Math.sin(s) * pegPos, pegR, 0, TAU);
        ctx.fill();
      });
    }
    ctx.restore();

    // soft inner edge
    ctx.beginPath();
    ctx.arc(c, c, R, 0, TAU);
    ctx.lineWidth = size * 0.006;
    ctx.strokeStyle = 'rgb(0 0 0 / 0.12)';
    ctx.stroke();
  }

  function setPointer() {
    els.pointer.style.transform = `translateX(-50%) rotate(${-pointerKick * 26}deg)`;
  }

  /* ---------------- sound ---------------- */

  let actx = null;
  let lastTick = 0;

  function audio() {
    if (!state.sound) return null;
    if (!actx) {
      try { actx = new (window.AudioContext || window.webkitAudioContext)(); } catch (_) { return null; }
    }
    if (actx.state === 'suspended') actx.resume();
    return actx;
  }

  function tone(freq, start, dur, type, peak, endFreq) {
    const a = audio();
    if (!a) return;
    const t = a.currentTime + start;
    const o = a.createOscillator();
    const g = a.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (endFreq) o.frequency.exponentialRampToValueAtTime(endFreq, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(a.destination);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  function tick() {
    const now = performance.now();
    if (now - lastTick < 28) return;
    lastTick = now;
    tone(880 + Math.random() * 90, 0, 0.05, 'triangle', 0.1, 420);
  }

  function chime() {
    [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => tone(f, i * 0.11, 0.55, 'sine', 0.13));
  }

  /* ---------------- spinning ---------------- */

  const easeOut = (t) => 1 - Math.pow(1 - t, 4);

  function sliceIndexAt(localAngle, act, total) {
    let acc = 0;
    for (let i = 0; i < act.length; i++) {
      acc += (act[i].weight / total) * TAU;
      if (localAngle < acc) return i;
    }
    return act.length - 1;
  }

  // Buttons and the editor panel are locked while spinning, and while a live room is disconnected.
  function syncControls() {
    const offline = !!live && !live.connected;
    els.panel.inert = spinning || offline;
    els.spin.disabled = spinning || offline || active().length < 2;
    els.hub.disabled = els.spin.disabled;
    els.spin.textContent = spinning ? 'Spinning…' : 'Spin the wheel';
  }

  function setSpinning(on) {
    spinning = on;
    syncControls();
  }

  function updateStatus(text) {
    if (text != null) { els.status.textContent = text; return; }
    if (live && !live.connected) { els.status.textContent = 'Connecting to the room…'; return; }
    els.status.textContent = active().length < 2
      ? 'Add at least two options with a weight above zero.'
      : 'Ready when you are.';
  }

  function spin() {
    if (spinning) return;
    const act = active();
    if (act.length < 2) { updateStatus(); return; }
    if (live) {
      if (live.connected) { audio(); liveSend({ t: 'spin' }); }
      return;
    }

    const total = act.reduce((s, o) => s + o.weight, 0);
    const idx = pickIndex(act.map((o) => o.weight), playMode ? seededUnit(playInfo.k) : rand());
    let before = 0;
    for (let i = 0; i < idx; i++) before += act[i].weight;
    const winner = act[idx];
    const chance = (winner.weight / total) * 100;

    // land somewhere inside the winning slice, away from its edges
    const within = 0.12 + 0.76 * rand();
    const target = ((before + winner.weight * within) / total) * TAU;
    const wanted = mod(-Math.PI / 2 - target, TAU);
    const reduced = prefersReducedMotion();
    const turns = reduced ? 1 : 5 + Math.floor(rand() * 3);
    const startRot = rotation;
    const delta = mod(wanted - mod(startRot, TAU), TAU) + turns * TAU;
    const duration = reduced ? 1100 : 5200 + rand() * 1400;
    const color = colorMap().get(winner.id);

    audio(); // unlock audio inside the user gesture
    setSpinning(true);
    updateStatus('Round and round…');

    let t0 = null;
    let last = null;
    let lastIdx = sliceIndexAt(mod(-Math.PI / 2 - startRot, TAU), act, total);

    function frame(now) {
      if (t0 === null) { t0 = now; last = now; }
      const t = Math.min(1, (now - t0) / duration);
      rotation = startRot + delta * easeOut(t);

      const i = sliceIndexAt(mod(-Math.PI / 2 - rotation, TAU), act, total);
      if (i !== lastIdx) { lastIdx = i; pointerKick = 1; tick(); }
      pointerKick = Math.max(0, pointerKick - (now - last) / 110);
      last = now;
      setPointer();
      draw();

      if (t < 1) requestAnimationFrame(frame);
      else finish(winner, chance, color);
    }
    requestAnimationFrame(frame);
  }

  function finish(winner, chance, color) {
    rotation = mod(rotation, TAU);
    pointerKick = 0;
    setPointer();
    setSpinning(false);
    updateStatus(`${winner.name.trim()} it is!`);

    if (!playMode) {
      state.history.unshift({ name: winner.name.trim(), color });
      state.history.length = Math.min(state.history.length, 12);
      save();
      renderHistory();
    }
    chime();
    showResult(winner, chance, color);
  }

  /* ---------------- result dialog ---------------- */

  let pendingRemoval = null;
  let spinAfterClose = false;

  function showResult(winner, chance, color) {
    els.rEyebrow.textContent = EYEBROWS[Math.floor(rand() * EYEBROWS.length)];
    els.rName.textContent = winner.name.trim();
    els.rChance.textContent = `It had a ${fmtPct(chance)} chance.`;
    els.rSwatch.style.setProperty('--dot', color);
    const removes = state.removeWinner && !playMode;
    pendingRemoval = removes && !live ? winner.id : null; // in a live room the server removes it
    els.rNote.textContent = playMode ? 'This link always lands on the same result.' : 'Removed from the wheel.';
    els.rNote.hidden = !removes && !playMode;
    els.rAgain.hidden = playMode;
    if (typeof els.dialog.showModal === 'function') {
      els.dialog.showModal();
      (playMode ? els.rClose : els.rAgain).focus();
    }
    burst();
  }

  els.dialog.addEventListener('close', () => {
    stopConfetti();
    if (pendingRemoval != null) {
      state.options = state.options.filter((o) => o.id !== pendingRemoval);
      pendingRemoval = null;
      renderList();
      save();
    }
    if (spinAfterClose) { spinAfterClose = false; spin(); }
  });
  els.dialog.addEventListener('click', (e) => { if (e.target === els.dialog) els.dialog.close(); });
  els.rClose.addEventListener('click', () => els.dialog.close());
  els.rAgain.addEventListener('click', () => { spinAfterClose = true; els.dialog.close(); });

  /* ---------------- confetti ---------------- */

  let confettiRaf = 0;

  function stopConfetti() {
    cancelAnimationFrame(confettiRaf);
    els.confetti.classList.remove('on');
    try { els.confetti.hidePopover(); } catch (_) { /* unsupported */ }
  }

  function burst() {
    if (prefersReducedMotion()) return;
    const cv = els.confetti;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const W = window.innerWidth;
    const H = window.innerHeight;
    cv.width = W * dpr;
    cv.height = H * dpr;
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    cv.classList.add('on');
    try { cv.showPopover(); } catch (_) { /* unsupported: still visible via .on */ }

    const count = Math.min(170, Math.round(W / 5));
    const pieces = Array.from({ length: count }, () => {
      const ang = -Math.PI / 2 + (Math.random() - 0.5) * 1.9;
      const sp = 7 + Math.random() * 11;
      return {
        x: W / 2, y: H * 0.5,
        vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp,
        w: 6 + Math.random() * 7, h: 4 + Math.random() * 5,
        rot: Math.random() * TAU, vr: (Math.random() - 0.5) * 0.35,
        color: PALETTE[Math.floor(Math.random() * PALETTE.length)],
        round: Math.random() < 0.3,
      };
    });

    const start = performance.now();
    const life = 3400;
    function frame(now) {
      const age = now - start;
      g.clearRect(0, 0, W, H);
      g.globalAlpha = age > life - 700 ? Math.max(0, (life - age) / 700) : 1;
      pieces.forEach((p) => {
        p.vy += 0.3;
        p.vx *= 0.992;
        p.vy *= 0.992;
        p.x += p.vx;
        p.y += p.vy;
        p.rot += p.vr;
        g.save();
        g.translate(p.x, p.y);
        g.rotate(p.rot);
        g.fillStyle = p.color;
        if (p.round) { g.beginPath(); g.arc(0, 0, p.w / 2.2, 0, TAU); g.fill(); }
        else g.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
        g.restore();
      });
      if (age < life) confettiRaf = requestAnimationFrame(frame);
      else stopConfetti();
    }
    confettiRaf = requestAnimationFrame(frame);
  }

  /* ---------------- option list ---------------- */

  const ROW_HTML = `
    <span class="opt-dot" aria-hidden="true"></span>
    <input class="opt-name" type="text" maxlength="60" placeholder="Option name" aria-label="Option name">
    <input class="opt-weight" type="number" min="0" step="any" inputmode="decimal" aria-label="Weight">
    <output class="opt-pct">0%</output>
    <button type="button" class="opt-remove">&times;</button>
    <span class="opt-bar" aria-hidden="true"><i></i></span>`;

  function rowFor(o) {
    const li = document.createElement('li');
    li.className = 'opt';
    li.dataset.id = o.id;
    li.innerHTML = ROW_HTML;
    li.querySelector('.opt-name').value = o.name;
    li.querySelector('.opt-weight').value = o.weight;
    return li;
  }

  function renderList() {
    els.list.textContent = '';
    state.options.forEach((o) => els.list.appendChild(rowFor(o)));
    updateDerived();
    if (live) renderFocus();
  }

  function updateDerived() {
    const act = active();
    const total = act.reduce((s, o) => s + o.weight, 0);
    const colors = colorMap();

    els.list.querySelectorAll('.opt').forEach((li) => {
      const o = state.options.find((x) => x.id === li.dataset.id);
      if (!o) return;
      const on = colors.has(o.id);
      const pct = on ? (o.weight / total) * 100 : 0;
      li.classList.toggle('is-off', !on);
      li.style.setProperty('--dot', on ? colors.get(o.id) : 'transparent');
      li.querySelector('.opt-pct').textContent = fmtPct(pct);
      li.querySelector('.opt-bar i').style.width = `${pct}%`;
      li.querySelector('.opt-remove').setAttribute('aria-label', `Remove ${o.name.trim() || 'option'}`);
    });

    const off = state.options.length - act.length;
    els.count.textContent = state.options.length
      ? `${act.length} on the wheel${off ? ` · ${off} sitting out` : ''}`
      : '';
    els.canvas.setAttribute('aria-label', act.length
      ? `Wheel with ${act.length} options: ${act.map((o) => o.name.trim()).join(', ')}`
      : 'Empty wheel');
    syncControls();
    if (!spinning) updateStatus();
    draw();
    if (live) renderHistory(); // slice colours follow the list, so refresh history dots too
  }

  els.list.addEventListener('input', (e) => {
    const li = e.target.closest('.opt');
    const o = li && state.options.find((x) => x.id === li.dataset.id);
    if (!o) return;
    if (e.target.matches('.opt-name')) { o.name = e.target.value; emit({ op: 'set', id: o.id, name: o.name }); }
    else if (e.target.matches('.opt-weight')) { o.weight = cleanWeight(e.target.value); emit({ op: 'set', id: o.id, weight: o.weight }); }
    else return;
    updateDerived();
    save();
  });

  els.list.addEventListener('click', (e) => {
    const btn = e.target.closest('.opt-remove');
    if (!btn) return;
    const li = btn.closest('.opt');
    const idx = state.options.findIndex((x) => x.id === li.dataset.id);
    if (idx < 0) return;
    const [removed] = state.options.splice(idx, 1);
    emit({ op: 'remove', id: removed.id });
    renderList();
    save();
    const next = els.list.querySelectorAll('.opt-remove')[Math.min(idx, state.options.length - 1)];
    (next || els.addName).focus();
  });

  els.addForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const name = els.addName.value.trim();
    if (!name) { els.addName.focus(); return; }
    if (state.options.length >= MAX_OPTIONS) { toast(`That's the maximum of ${MAX_OPTIONS} options.`); return; }
    const raw = els.addWeight.value.trim();
    const weight = raw === '' ? 1 : cleanWeight(raw);
    const added = makeOption(name, weight);
    state.options.push(added);
    emit({ op: 'add', id: added.id, name: added.name, weight: added.weight });
    els.addName.value = '';
    renderList();
    save();
    els.list.scrollTop = els.list.scrollHeight;
    els.addName.focus();
  });

  els.equalize.addEventListener('click', () => {
    state.options.forEach((o) => { o.weight = 1; });
    emit({ op: 'equalize' });
    renderList();
    save();
    toast('All chances are now equal.');
  });

  els.clear.addEventListener('click', () => {
    if (!state.options.length) return;
    if (!window.confirm('Remove all options?')) return;
    state.options = [];
    emit({ op: 'clear' });
    renderList();
    save();
    els.addName.focus();
  });

  els.share.addEventListener('click', async () => {
    const data = state.options.map((o) => [o.name, o.weight]);
    const url = `${location.href.split('#')[0]}#o=${encodeURIComponent(JSON.stringify(data))}`;
    try {
      await navigator.clipboard.writeText(url);
      toast('Link copied to clipboard.');
    } catch (_) {
      window.prompt('Copy this link:', url);
    }
  });

  els.optRemove.addEventListener('change', () => {
    state.removeWinner = els.optRemove.checked;
    emit({ op: 'setting', removeWinner: state.removeWinner });
    save();
  });
  els.optSound.addEventListener('change', () => { state.sound = els.optSound.checked; save(); });

  /* ---------------- history ---------------- */

  function renderHistory() {
    els.history.hidden = !state.history.length;
    els.historyList.textContent = '';
    state.history.forEach((h) => {
      const li = document.createElement('li');
      const dot = document.createElement('i');
      dot.style.background = h.color || (live && colorMap().get(h.optId)) || PALETTE[0];
      const name = document.createElement('span');
      name.textContent = h.name;
      li.append(dot, name);
      els.historyList.appendChild(li);
    });
  }

  els.clearHistory.addEventListener('click', () => { state.history = []; save(); renderHistory(); });

  /* ---------------- toast ---------------- */

  let toastTimer = 0;
  function toast(msg) {
    els.toast.textContent = msg;
    els.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => els.toast.classList.remove('show'), 2200);
  }

  /* ---------------- init ---------------- */

  els.spin.addEventListener('click', spin);
  els.hub.addEventListener('click', spin);

  new ResizeObserver(draw).observe(els.wrap);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(draw);

  /* ---------------- sending links ---------------- */

  const baseUrl = () => location.href.split('#')[0];
  const linkFor = (p) => `${baseUrl()}${LINK_PREFIX}${b64Encode(p)}`;

  const newSeed = () => randomId(10);

  async function copyText(text, okMsg) {
    try {
      await navigator.clipboard.writeText(text);
      toast(okMsg);
    } catch (_) {
      window.prompt('Copy this:', text);
    }
  }

  let createdLinks = [];

  function createLinks() {
    const act = active();
    if (act.length < 2) { toast('Add at least two options with a weight above zero first.'); return; }
    const names = els.sendNames.value.split(/[\n,]+/).map((n) => n.trim().slice(0, 40)).filter(Boolean).slice(0, 30);
    if (!names.length) { toast('Add at least one name.'); els.sendNames.focus(); return; }
    const title = els.sendTitle.value.trim().slice(0, 80);
    const o = act.map((x) => [x.name.trim(), x.weight]);

    createdLinks = names.map((n) => {
      const p = { t: title, n, k: newSeed(), o };
      return { name: n, url: linkFor(p), result: winnerFor(p) };
    });

    els.sendLinks.textContent = '';
    createdLinks.forEach((l) => {
      const li = document.createElement('li');
      const who = document.createElement('span');
      who.className = 'who';
      who.textContent = l.name;
      const copy = document.createElement('button');
      copy.type = 'button';
      copy.className = 'btn ghost';
      copy.textContent = 'Copy link';
      copy.addEventListener('click', () => copyText(l.url, `Link for ${l.name} copied.`));
      const reveal = document.createElement('button');
      reveal.type = 'button';
      reveal.className = 'btn ghost';
      reveal.textContent = 'Reveal';
      const res = document.createElement('span');
      res.className = 'res';
      res.hidden = true;
      res.textContent = l.result;
      reveal.addEventListener('click', () => {
        res.hidden = !res.hidden;
        reveal.textContent = res.hidden ? 'Reveal' : 'Hide';
      });
      li.append(who, copy, reveal, res);
      els.sendLinks.appendChild(li);
    });
    els.sendOut.hidden = false;
    els.sendOut.scrollIntoView({ block: 'nearest', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
  }

  function lookup() {
    const v = els.lookupUrl.value;
    const i = v.indexOf(LINK_PREFIX);
    const p = i < 0 ? null : parsePersonal(v.slice(i + LINK_PREFIX.length).trim());
    els.lookupOut.textContent = p
      ? `${p.n || 'This link'} gets: ${winnerFor(p)}`
      : "That doesn't look like a wheel link.";
  }

  els.sendOpen.addEventListener('click', () => {
    els.sendFileNote.hidden = location.protocol !== 'file:';
    if (typeof els.send.showModal === 'function') els.send.showModal();
    els.sendNames.focus();
  });
  els.sendClose.addEventListener('click', () => els.send.close());
  els.send.addEventListener('click', (e) => { if (e.target === els.send) els.send.close(); });
  els.sendCreate.addEventListener('click', createLinks);
  els.sendCopyAll.addEventListener('click', () => {
    copyText(createdLinks.map((l) => `${l.name}: ${l.url}`).join('\n'), 'All links copied.');
  });
  els.lookupGo.addEventListener('click', lookup);
  els.lookupUrl.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); lookup(); } });

  /* ---------------- recipient view ---------------- */

  function setupPlay() {
    document.body.classList.add('play');
    els.eyebrow.textContent = playInfo.n ? `A spin for ${playInfo.n}` : 'A spin for you';
    els.lede.textContent = playInfo.t || 'Someone sent you a wheel. Give it a spin!';
    document.title = playInfo.t ? `${playInfo.t} · Spin the Wheel` : 'Spin the Wheel';
    els.panelTitle.textContent = "What's on the wheel";
    els.editor.hidden = true;
    els.viewer.hidden = false;
    els.makeOwn.hidden = false;

    const act = active();
    const total = act.reduce((s, o) => s + o.weight, 0);
    const colors = colorMap();
    act.forEach((o) => {
      const li = document.createElement('li');
      li.className = 'opt ro';
      li.style.setProperty('--dot', colors.get(o.id));
      li.innerHTML = '<span class="opt-dot" aria-hidden="true"></span><span class="opt-label-ro"></span><output class="opt-pct"></output><span class="opt-bar" aria-hidden="true"><i></i></span>';
      li.querySelector('.opt-label-ro').textContent = o.name;
      li.querySelector('.opt-pct').textContent = fmtPct((o.weight / total) * 100);
      li.querySelector('.opt-bar i').style.width = `${(o.weight / total) * 100}%`;
      els.viewer.appendChild(li);
    });
  }

  /* ---------------- live rooms ---------------- */

  // A live room is a wheel shared through the server. The server owns the options and picks every
  // winner; clients send edits, receive everyone else's, and animate the same spin from the same
  // start time so it lands together on every screen.

  const NAME_KEY = 'spin-the-wheel:name';
  const ADJECTIVES = ['Mossy', 'Salty', 'Misty', 'Tidal', 'Sandy', 'Breezy', 'Rusty', 'Calm', 'Sunny', 'Wild'];
  const CREATURES = ['Otter', 'Heron', 'Gull', 'Seal', 'Crab', 'Puffin', 'Pelican', 'Whale', 'Fox', 'Stag'];
  const pickOne = (list) => list[Math.floor(rand() * list.length)];

  function makeLive(roomId) {
    let name = '';
    try { name = localStorage.getItem(NAME_KEY) || ''; } catch (_) { /* storage unavailable */ }
    return {
      roomId, name: name || `${pickOne(ADJECTIVES)} ${pickOne(CREATURES)}`,
      you: null, ws: null, connected: false, everConnected: false, closing: false,
      peers: [], focus: new Map(), seq: 0, retry: 0, timer: 0,
      rtt: 0, log: [], lastReact: 0,
      offset: 0, bestRtt: Infinity, // serverTime ~= Date.now() + offset
      seed: null,                   // list to create the room with (only when this page created it)
    };
  }

  const peerColor = (id) => PALETTE[parseInt(id.slice(0, 4), 16) % PALETTE.length];
  const inviteUrl = () => `${baseUrl()}#r=${live.roomId}`;

  function liveSend(msg) {
    if (live && live.ws && live.ws.readyState === 1) live.ws.send(JSON.stringify(msg));
  }

  // Sends an edit to the room (no-op when not live). The local state is already updated.
  function emit(op) {
    if (live) liveSend({ t: 'op', op });
  }

  function setupLive() {
    document.body.classList.add('live');
    els.eyebrow.textContent = 'a live room';
    els.lede.textContent = 'Everyone here edits the same wheel and sees every spin land together.';
    els.liveBar.hidden = false;
    els.liveName.value = live.name;
    REACTIONS.forEach(([emoji, label], i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = emoji;
      b.setAttribute('aria-label', label);
      b.title = label;
      b.addEventListener('click', () => sendReaction(i));
      els.liveReact.appendChild(b);
    });
    renderLive();
    syncControls();
  }

  function leaveLive(message) {
    if (live) {
      live.closing = true;
      clearTimeout(live.timer);
      if (live.ws) live.ws.close();
    }
    if (message) toast(message);
    setTimeout(() => { history.replaceState(null, '', baseUrl()); location.reload(); }, message ? 1700 : 0);
  }

  function liveConnect() {
    const url = window.SPIN_WS_URL || `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`;
    let ws;
    try { ws = new WebSocket(url); } catch (_) { return leaveLive("Couldn't reach the live server."); }
    live.ws = ws;

    ws.onopen = () => {
      ws.send(JSON.stringify({
        t: 'join', room: live.roomId, name: live.name, create: !!live.seed, seed: live.seed,
      }));
      // a few pings so we can estimate the clock difference to the server
      for (let i = 0; i < 4; i++) setTimeout(() => liveSend({ t: 'ping', c: Date.now() }), i * 200);
    };
    ws.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch (_) { return; }
      onLiveMessage(msg);
    };
    ws.onclose = () => {
      if (live.closing || live.ws !== ws) return;
      live.connected = false;
      live.peers = [];
      renderLive();
      syncControls();
      updateStatus();
      if (!live.everConnected && live.retry >= 2) { leaveLive("Couldn't reach the live server."); return; }
      live.timer = setTimeout(liveConnect, Math.min(10000, 800 * 2 ** live.retry++));
    };
    ws.onerror = () => { /* onclose follows */ };
  }

  function onLiveMessage(m) {
    switch (m.t) {
      case 'welcome':
        live.you = m.you;
        live.connected = true;
        live.everConnected = true;
        live.retry = 0;
        live.seed = null;
        live.peers = m.peers;
        if (live.bestRtt === Infinity) live.offset = m.now - Date.now();
        rebuildFocus();
        applySnapshot(m.room);
        myStatus = 'active';                     // the server starts everyone as active...
        if (document.hidden) setMyStatus('away'); // ...so correct it if this tab is in the background
        renderLive();
        syncControls();
        break;
      case 'snapshot':
        applySnapshot(m.room);
        break;
      case 'pong': {
        const rtt = Date.now() - m.c;
        live.rtt = rtt;
        els.liveRtt.textContent = `${Math.round(rtt)} ms`;
        if (rtt < live.bestRtt) { live.bestRtt = rtt; live.offset = m.s + rtt / 2 - Date.now(); }
        break;
      }
      case 'peers': {
        const before = new Map(live.peers.map((p) => [p.id, p.name]));
        live.peers = m.peers;
        const after = new Set(m.peers.map((p) => p.id));
        m.peers.forEach((p) => { if (!before.has(p.id) && p.id !== live.you) { logActivity(`join:${p.id}`, `${p.name} joined`); pulsePeer(p.id); } });
        before.forEach((name, id) => { if (!after.has(id)) { logActivity(`left:${id}`, `${name} left`); live.focus.delete(id); } });
        rebuildFocus();
        renderLive();
        break;
      }
      case 'presence': {
        const p = live.peers.find((x) => x.id === m.id);
        if (p) { p.status = m.status; p.since = m.since; renderLive(); }
        break;
      }
      case 'react':
        showReaction(m.by, m.i);
        break;
      case 'focus':
        if (m.id) live.focus.set(m.by, m.id); else live.focus.delete(m.by);
        renderFocus();
        renderLive();
        if (m.id) pulsePeer(m.by);
        break;
      case 'op':
        if (m.seq > live.seq + 1) { liveSend({ t: 'sync' }); break; } // missed something: ask for a fresh copy
        live.seq = Math.max(live.seq, m.seq);
        if (m.by !== live.you) {
          const note = describeOp(m.op, peerName(m.by)); // describe before applying, while the old state is still there
          applyRemoteOp(m.op);
          logActivity(note.key, note.text);
          pulsePeer(m.by);
          flashRow(m.op, m.by);
        }
        break;
      case 'spin':
        logActivity(`spin:${m.spin.id}`, `${m.spin.byName || 'Someone'} spun the wheel`);
        pulsePeer(m.spin.by);
        if (!spinning) runLiveSpin(m.spin);
        break;
      case 'spinEnd':
        live.seq = Math.max(live.seq, m.seq);
        logActivity(`won:${m.item.at}`, `${m.item.name} won`);
        state.history.unshift(m.item);
        state.history.length = Math.min(state.history.length, 12);
        renderHistory();
        if (m.removed) applyRemoteOp({ op: 'remove', id: m.removed });
        break;
      case 'error':
        if (m.code === 'notfound') leaveLive("That room doesn't exist any more.");
        else if (m.code === 'badroom') leaveLive("That isn't a valid room link.");
        else if (m.code === 'full' || m.code === 'roomfull') leaveLive('That room is full right now.');
        else if (m.code === 'spinning') toast('Hold on, the wheel is spinning.');
        else if (m.code === 'need2') updateStatus();
        break;
      default:
    }
  }

  function applySnapshot(room) {
    state.options = room.options.map((o) => makeOption(o.name, o.weight, o.id));
    state.removeWinner = !!room.removeWinner;
    state.history = room.history.slice(0, 12);
    live.seq = room.seq;
    els.optRemove.checked = state.removeWinner;
    if (!spinning) rotation = room.rot;
    renderList();
    renderHistory();
    if (room.spin && !spinning) runLiveSpin(room.spin);
  }

  function setInputValue(input, value) {
    const text = String(value);
    if (input.value === text) return;
    const keepCaret = document.activeElement === input && input.type === 'text';
    const [a, b] = keepCaret ? [input.selectionStart, input.selectionEnd] : [0, 0];
    input.value = text;
    if (keepCaret) input.setSelectionRange(Math.min(a, text.length), Math.min(b, text.length));
  }

  // Applies an edit made by someone else, touching as little DOM as possible so typing isn't disturbed.
  function applyRemoteOp(op) {
    switch (op.op) {
      case 'add':
        if (state.options.some((o) => o.id === op.id)) return;
        state.options.push(makeOption(op.name, op.weight, op.id));
        els.list.appendChild(rowFor(state.options[state.options.length - 1]));
        break;
      case 'set': {
        const o = state.options.find((x) => x.id === op.id);
        const li = els.list.querySelector(`.opt[data-id="${op.id}"]`);
        if (!o || !li) return;
        if ('name' in op) { o.name = op.name; setInputValue(li.querySelector('.opt-name'), op.name); }
        if ('weight' in op) { o.weight = op.weight; setInputValue(li.querySelector('.opt-weight'), op.weight); }
        break;
      }
      case 'remove': {
        const i = state.options.findIndex((x) => x.id === op.id);
        if (i < 0) return;
        state.options.splice(i, 1);
        const li = els.list.querySelector(`.opt[data-id="${op.id}"]`);
        if (li) li.remove();
        break;
      }
      case 'equalize':
        state.options.forEach((o) => { o.weight = 1; });
        renderList();
        return;
      case 'clear':
        state.options = [];
        renderList();
        return;
      case 'setting':
        state.removeWinner = !!op.removeWinner;
        els.optRemove.checked = state.removeWinner;
        break;
      default:
        return;
    }
    updateDerived();
  }

  // Animates a spin the server started, so it matches every other screen in the room.
  function runLiveSpin(sp) {
    const act = active();
    const total = act.reduce((s, o) => s + o.weight, 0);
    const w = act.find((o) => o.id === sp.winnerId);
    const winner = { id: sp.winnerId, name: sp.winnerName };
    const chance = w && total ? (w.weight / total) * 100 : 0;
    const color = colorMap().get(sp.winnerId) || PALETTE[0];
    const reduced = prefersReducedMotion();
    const delta = reduced ? mod(sp.delta, TAU) : sp.delta; // same final angle, without the long spin
    const duration = reduced ? 1100 : sp.duration;

    audio();
    setSpinning(true);
    updateStatus(`${sp.byName || 'Someone'} spun the wheel…`);
    rotation = sp.fromRot;

    let last = performance.now();
    let lastIdx = sliceIndexAt(mod(-Math.PI / 2 - sp.fromRot, TAU), act, total);

    function frame(now) {
      const t = Math.min(1, Math.max(0, (Date.now() + live.offset - sp.startAt) / duration));
      rotation = sp.fromRot + delta * easeOut(t);

      const i = sliceIndexAt(mod(-Math.PI / 2 - rotation, TAU), act, total);
      if (i !== lastIdx) { lastIdx = i; pointerKick = 1; tick(); }
      pointerKick = Math.max(0, pointerKick - (now - last) / 110);
      last = now;
      setPointer();
      draw();

      if (t < 1) { requestAnimationFrame(frame); return; }
      rotation = mod(sp.fromRot + sp.delta, TAU);
      pointerKick = 0;
      setPointer();
      setSpinning(false);
      updateStatus(`${winner.name} it is!`);
      chime();
      showResult(winner, chance, color);
    }
    requestAnimationFrame(frame);
  }

  /* presence */

  function rebuildFocus() {
    live.focus = new Map(live.peers.filter((p) => p.focus).map((p) => [p.id, p.focus]));
    renderFocus();
  }

  // Shows who else is editing which row.
  function renderFocus() {
    els.list.querySelectorAll('.opt[data-editor]').forEach((li) => li.removeAttribute('data-editor'));
    live.focus.forEach((optId, peerId) => {
      if (peerId === live.you) return;
      const peer = live.peers.find((p) => p.id === peerId);
      const li = els.list.querySelector(`.opt[data-id="${optId}"]`);
      if (peer && li) li.dataset.editor = peer.name;
    });
  }

  function renderLive() {
    els.liveDot.classList.toggle('on', live.connected);
    els.liveText.textContent = live.connected
      ? `Live room · ${live.peers.length} here`
      : (live.everConnected ? 'Reconnecting…' : 'Connecting…');
    if (!live.connected) els.liveRtt.textContent = '';

    // you first, then whoever is most present
    const rank = { active: 0, idle: 1, away: 2 };
    const sorted = [...live.peers].sort((x, y) =>
      (y.id === live.you) - (x.id === live.you) || rank[x.status] - rank[y.status]);
    const SHOW = 8;

    els.livePeers.textContent = '';
    sorted.slice(0, SHOW).forEach((p) => {
      const editing = live.focus.has(p.id) && p.status === 'active';
      const li = document.createElement('li');
      li.className = `peer is-${p.status}${editing ? ' is-editing' : ''}`;
      li.dataset.id = p.id;
      li.style.setProperty('--c', peerColor(p.id));
      const avatar = document.createElement('span');
      avatar.className = 'avatar';
      avatar.textContent = ([...p.name][0] || '?').toUpperCase();
      const who = document.createElement('span');
      who.className = 'who';
      const name = document.createElement('strong');
      name.textContent = p.id === live.you ? `${p.name} (you)` : p.name;
      const sub = document.createElement('small');
      sub.textContent = peerLabel(p);
      who.append(name, sub);
      li.append(avatar, who);
      els.livePeers.appendChild(li);
    });
    if (sorted.length > SHOW) {
      const more = document.createElement('li');
      more.className = 'peers-more';
      more.textContent = `+ ${sorted.length - SHOW} more`;
      els.livePeers.appendChild(more);
    }
  }

  /* presence: online / idle / away, without needing a mouse (works the same on a phone) */

  const REACTIONS = [['👋', 'Wave'], ['🎉', 'Celebrate'], ['🤞', 'Fingers crossed'], ['😂', 'Laugh'], ['❤️', 'Love'], ['👀', 'Watching']];
  const IDLE_MS = Number(window.SPIN_IDLE_MS) || 45000; // no touch/key/scroll for this long = idle
  let myStatus = 'active';

  const serverNow = () => Date.now() + live.offset;
  const peerName = (id) => (live.peers.find((p) => p.id === id) || {}).name || 'Someone';

  function ago(ms) {
    const sec = Math.max(0, Math.round(ms / 1000));
    if (sec < 60) return `${sec}s`;
    const min = Math.floor(sec / 60);
    return min < 60 ? `${min}m` : `${Math.floor(min / 60)}h`;
  }

  function peerLabel(p) {
    const optId = live.focus.get(p.id);
    const opt = optId && state.options.find((o) => o.id === optId);
    if (opt && p.status === 'active') return `editing ${opt.name.trim() || 'an option'}`;
    if (p.status === 'away') return `away · ${ago(serverNow() - (p.since || 0))}`;
    if (p.status === 'idle') return `idle · ${ago(serverNow() - (p.since || 0))}`;
    return 'active now';
  }

  function setMyStatus(next) {
    if (!live || myStatus === next) return;
    myStatus = next;
    liveSend({ t: 'status', s: next });
    const me = live.peers.find((p) => p.id === live.you);
    if (me) { me.status = next; me.since = serverNow(); renderLive(); }
  }

  let lastInput = Date.now();
  function noteActivity() {
    lastInput = Date.now();
    if (live && !document.hidden) setMyStatus('active');
  }
  // touch, keyboard, scroll and pointer all count, so a phone user tapping or scrolling is "active"
  ['pointerdown', 'pointermove', 'keydown', 'touchstart', 'touchmove', 'scroll', 'wheel', 'input'].forEach((ev) => {
    window.addEventListener(ev, noteActivity, { passive: true, capture: true });
  });
  // a hidden tab or a locked phone is "away"
  document.addEventListener('visibilitychange', () => {
    if (!live) return;
    if (document.hidden) setMyStatus('away'); else noteActivity();
  });
  window.addEventListener('pagehide', () => { if (live) liveSend({ t: 'status', s: 'away' }); });

  setInterval(() => {
    if (!live || !live.connected) return;
    if (myStatus === 'active' && Date.now() - lastInput > IDLE_MS) setMyStatus('idle');
    liveSend({ t: 'ping', c: Date.now() }); // keeps the connection warm and measures latency
  }, Math.min(10000, Math.max(500, IDLE_MS / 3)));

  setInterval(() => { if (live && live.connected) renderLive(); }, 10000); // keeps "idle · 2m" fresh

  /* activity: a pulse on whoever just did something, a flash on the row they changed, a short feed */

  function pulsePeer(id) {
    const el = els.livePeers.querySelector(`.peer[data-id="${id}"]`);
    if (!el) return;
    el.classList.remove('pulse');
    void el.offsetWidth; // restart the animation
    el.classList.add('pulse');
  }

  function flashRow(op, by) {
    if (op.op !== 'set' && op.op !== 'add') return;
    const li = els.list.querySelector(`.opt[data-id="${op.id}"]`);
    if (!li) return;
    li.style.setProperty('--c', peerColor(by));
    li.classList.remove('flash');
    void li.offsetWidth;
    li.classList.add('flash');
  }

  function describeOp(op, who) {
    const opt = state.options.find((o) => o.id === op.id);
    const label = (opt && opt.name.trim()) || 'an option';
    switch (op.op) {
      case 'add': return { key: `add:${op.id}`, text: `${who} added “${op.name.trim() || 'a new option'}”` };
      case 'remove': return { key: `rm:${op.id}`, text: `${who} removed “${label}”` };
      case 'equalize': return { key: 'eq', text: `${who} equalized the chances` };
      case 'clear': return { key: 'clear', text: `${who} cleared the wheel` };
      case 'setting': return { key: 'setting', text: `${who} turned remove-the-winner ${op.removeWinner ? 'on' : 'off'}` };
      case 'set':
        return 'weight' in op
          ? { key: `w:${who}:${op.id}`, text: `${who} set “${label}” to ${op.weight}` }
          : { key: `n:${who}:${op.id}`, text: `${who} renamed an option to “${(op.name || '').trim() || '…'}”` };
      default: return { key: 'op', text: `${who} changed the wheel` };
    }
  }

  // Newest first, three lines. A burst of the same change (typing a name) updates one line instead of flooding.
  function logActivity(key, text) {
    const now = Date.now();
    const head = live.log[0];
    if (head && head.key === key && now - head.at < 4000) { head.text = text; head.at = now; }
    else live.log.unshift({ key, text, at: now });
    live.log.length = Math.min(live.log.length, 3);
    els.liveActivity.textContent = '';
    live.log.forEach((entry) => {
      const li = document.createElement('li');
      li.textContent = entry.text;
      els.liveActivity.appendChild(li);
    });
  }

  function sendReaction(i) {
    const now = Date.now();
    if (!live || !live.connected || now - live.lastReact < 350) return;
    live.lastReact = now;
    liveSend({ t: 'react', i });
    showReaction(live.you, i);
  }

  function showReaction(by, i) {
    if (!REACTIONS[i]) return;
    pulsePeer(by);
    if (els.reactions.childElementCount > 30) return;
    const el = document.createElement('div');
    el.className = 'float';
    el.style.left = `${12 + Math.random() * 70}%`;
    el.style.setProperty('--drift', Math.round((Math.random() - 0.5) * 60));
    const emoji = document.createElement('span');
    emoji.textContent = REACTIONS[i][0];
    const who = document.createElement('small');
    who.textContent = by === live.you ? 'You' : peerName(by);
    el.append(emoji, who);
    el.addEventListener('animationend', () => el.remove());
    els.reactions.appendChild(el);
  }

  els.list.addEventListener('focusin', (e) => {
    const li = e.target.closest('.opt');
    if (!live || !li) return;
    liveSend({ t: 'focus', id: li.dataset.id });
    live.focus.set(live.you, li.dataset.id);
    renderLive();
  });
  els.list.addEventListener('focusout', () => {
    if (!live) return;
    liveSend({ t: 'focus', id: null });
    live.focus.delete(live.you);
    renderLive();
  });

  els.liveName.addEventListener('input', () => {
    if (!live) return;
    live.name = els.liveName.value.trim().slice(0, 24) || 'Guest';
    try { localStorage.setItem(NAME_KEY, live.name); } catch (_) { /* storage unavailable */ }
    liveSend({ t: 'name', name: live.name });
  });
  els.liveCopy.addEventListener('click', () => copyText(inviteUrl(), 'Invite link copied.'));
  els.liveLeave.addEventListener('click', () => leaveLive());

  // Turns the wheel you're looking at into a live room and puts you in it.
  els.liveOpen.addEventListener('click', () => {
    if (location.protocol === 'file:') { toast('Open the site from your server to go live.'); return; }
    if (live) return;
    live = makeLive(randomId(10));
    live.seed = { options: state.options.map((o) => [o.name, o.weight, o.id]), removeWinner: state.removeWinner };
    history.replaceState(null, '', inviteUrl());
    setupLive();
    liveConnect();
  });

  load();
  els.optRemove.checked = state.removeWinner;
  els.optSound.checked = state.sound;
  readTheme();
  if (playMode) {
    setupPlay();
    updateDerived();
  } else {
    renderList();
    renderHistory();
    if (live) { setupLive(); liveConnect(); }
  }
  setPointer();
})();
