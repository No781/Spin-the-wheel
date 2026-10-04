(() => {
  'use strict';

  const TAU = Math.PI * 2;
  const STORAGE_KEY = 'spin-the-wheel:v1';
  const MAX_OPTIONS = 60;
  const FONT = '"DM Sans", system-ui, -apple-system, "Segoe UI", sans-serif';

  // Muted, natural palette: sage, terracotta, sand, dusty blue, ochre, rose, moss, clay, stone, slate.
  const PALETTE = [
    '#8b9b76', '#c4745a', '#d9c5a0', '#8e9aaf', '#d4a373',
    '#b5838d', '#6b8068', '#cb997e', '#a5a58d', '#7a8a99',
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
  };
  const ctx = els.canvas.getContext('2d');

  const state = { options: [], removeWinner: false, sound: true, history: [] };
  let uid = 0;
  let rotation = 0;
  let spinning = false;
  let pointerKick = 0;
  let theme = {};

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

  function load() {
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

  function inkOn(hex) {
    const n = parseInt(hex.slice(1), 16);
    const lum = (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
    return lum > 0.6 ? '#3a342b' : '#fbf6ec';
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
    let r = rand() * total;
    let idx = act.length - 1;
    let before = 0;
    for (let i = 0; i < act.length; i++) {
      if (r < act[i].weight) { idx = i; break; }
      r -= act[i].weight;
    }
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

    state.history.unshift({ name: winner.name.trim(), color });
    state.history.length = Math.min(state.history.length, 12);
    save();
    renderHistory();
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
    pendingRemoval = state.removeWinner ? winner.id : null;
    els.rNote.hidden = !pendingRemoval;
    if (typeof els.dialog.showModal === 'function') {
      els.dialog.showModal();
      els.rAgain.focus();
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
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { readTheme(); draw(); });
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(draw);

  load();
  els.optRemove.checked = state.removeWinner;
  els.optSound.checked = state.sound;
  readTheme();
  renderList();
  renderHistory();
  setPointer();
})();
