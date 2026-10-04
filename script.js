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
  };
  const ctx = els.canvas.getContext('2d');

  const state = { options: [], removeWinner: false, sound: true, history: [] };
  let uid = 0;
  let rotation = 0;
  let spinning = false;
  let pointerKick = 0;
  let theme = {};
  let playMode = false; // opened from a personal link: read-only wheel with a fixed outcome
  let playInfo = null;

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

  const makeOption = (name, weight) => ({ id: ++uid, name: String(name), weight: Number(weight) });

  function cleanWeight(v) {
    const n = typeof v === 'number' ? v : parseFloat(v);
    return Number.isFinite(n) && n > 0 ? Math.min(n, 10000) : 0;
  }

  function save() {
    if (playMode) return; // never overwrite the visitor's own saved list
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

  function setSpinning(on) {
    spinning = on;
    els.panel.inert = on;
    els.spin.disabled = on || active().length < 2;
    els.hub.disabled = els.spin.disabled;
    els.spin.textContent = on ? 'Spinning…' : 'Spin the wheel';
  }

  function updateStatus(text) {
    if (text != null) { els.status.textContent = text; return; }
    els.status.textContent = active().length < 2
      ? 'Add at least two options with a weight above zero.'
      : 'Ready when you are.';
  }

  function spin() {
    if (spinning) return;
    const act = active();
    if (act.length < 2) { updateStatus(); return; }

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
    pendingRemoval = state.removeWinner && !playMode ? winner.id : null;
    els.rNote.textContent = playMode ? 'This link always lands on the same result.' : 'Removed from the wheel.';
    els.rNote.hidden = !pendingRemoval && !playMode;
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

  function renderList() {
    els.list.textContent = '';
    state.options.forEach((o) => {
      const li = document.createElement('li');
      li.className = 'opt';
      li.dataset.id = o.id;
      li.innerHTML = ROW_HTML;
      li.querySelector('.opt-name').value = o.name;
      li.querySelector('.opt-weight').value = o.weight;
      els.list.appendChild(li);
    });
    updateDerived();
  }

  function updateDerived() {
    const act = active();
    const total = act.reduce((s, o) => s + o.weight, 0);
    const colors = colorMap();

    els.list.querySelectorAll('.opt').forEach((li) => {
      const o = state.options.find((x) => x.id === Number(li.dataset.id));
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
    if (!spinning) {
      els.spin.disabled = act.length < 2;
      els.hub.disabled = els.spin.disabled;
      updateStatus();
    }
    draw();
  }

  els.list.addEventListener('input', (e) => {
    const li = e.target.closest('.opt');
    const o = li && state.options.find((x) => x.id === Number(li.dataset.id));
    if (!o) return;
    if (e.target.matches('.opt-name')) o.name = e.target.value;
    else if (e.target.matches('.opt-weight')) o.weight = cleanWeight(e.target.value);
    else return;
    updateDerived();
    save();
  });

  els.list.addEventListener('click', (e) => {
    const btn = e.target.closest('.opt-remove');
    if (!btn) return;
    const li = btn.closest('.opt');
    const idx = state.options.findIndex((x) => x.id === Number(li.dataset.id));
    if (idx < 0) return;
    state.options.splice(idx, 1);
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
    state.options.push(makeOption(name, weight));
    els.addName.value = '';
    renderList();
    save();
    els.list.scrollTop = els.list.scrollHeight;
    els.addName.focus();
  });

  els.equalize.addEventListener('click', () => {
    state.options.forEach((o) => { o.weight = 1; });
    renderList();
    save();
    toast('All chances are now equal.');
  });

  els.clear.addEventListener('click', () => {
    if (!state.options.length) return;
    if (!window.confirm('Remove all options?')) return;
    state.options = [];
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

  els.optRemove.addEventListener('change', () => { state.removeWinner = els.optRemove.checked; save(); });
  els.optSound.addEventListener('change', () => { state.sound = els.optSound.checked; save(); });

  /* ---------------- history ---------------- */

  function renderHistory() {
    els.history.hidden = !state.history.length;
    els.historyList.textContent = '';
    state.history.forEach((h) => {
      const li = document.createElement('li');
      const dot = document.createElement('i');
      dot.style.background = h.color;
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

  function newSeed() {
    const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789';
    let s = '';
    for (let i = 0; i < 10; i++) s += alphabet[Math.floor(rand() * alphabet.length)];
    return s;
  }

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

  load();
  els.optRemove.checked = state.removeWinner;
  els.optSound.checked = state.sound;
  readTheme();
  if (playMode) { setupPlay(); updateDerived(); }
  else { renderList(); renderHistory(); }
  setPointer();
})();
