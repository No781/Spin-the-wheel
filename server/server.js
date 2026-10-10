'use strict';

/*
 * Spin the Wheel: realtime rooms.
 *
 * One process does two jobs:
 *   1. serves the static site (index.html, style.css, script.js, config.js)
 *   2. runs a WebSocket endpoint at /ws where clients join "rooms"
 *
 * The server is authoritative: it validates every edit, picks spin winners with
 * a cryptographic random draw, and tells every client in the room the same
 * animation (start time, duration, final angle) so the wheel lands together.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT) || 8080;
const HOST = process.env.HOST || '127.0.0.1';
const STATIC_DIR = process.env.STATIC_DIR || path.join(__dirname, '..');
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data', 'rooms.json');
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);

const LIMITS = {
  options: 60,
  nameLen: 60,
  peerNameLen: 24,
  clientsPerRoom: 50,
  rooms: 5000,
  connectionsPerIp: 25,
  history: 12,
  payload: 16 * 1024,
  idleDays: 30,
  reactions: 6,      // number of emoji the client offers
  burst: 60,         // message bucket size
  refillPerSec: 30,  // messages per second, sustained
};

const TAU = Math.PI * 2;
const ID_RE = /^[a-z0-9]{4,16}$/;
const STATUSES = ['active', 'idle', 'away'];
const ROOM_RE = /^[a-z0-9]{6,24}$/;
const SPIN_LEAD_MS = 500;   // gives every client time to get the message before the wheel starts
const SPIN_TAIL_MS = 250;   // grace after the animation ends before edits are allowed again

const mod = (a, n) => ((a % n) + n) % n;
const rnd = () => crypto.randomBytes(6).readUIntBE(0, 6) / 2 ** 48;
const clientId = () => crypto.randomBytes(5).toString('hex');

/* ---------------------------------------------------------------- static */

const PUBLIC_FILES = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/script.js': ['script.js', 'text/javascript; charset=utf-8'],
  '/config.js': ['config.js', 'text/javascript; charset=utf-8'],
};

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  "img-src 'self' data:",
  "connect-src 'self' ws: wss:",
  "frame-ancestors 'none'",
  "base-uri 'none'",
].join('; ');

const httpServer = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];
  const headers = {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': CSP,
  };

  if (url === '/healthz') {
    res.writeHead(200, { ...headers, 'Content-Type': 'text/plain' });
    return res.end('ok');
  }

  const entry = PUBLIC_FILES[url];
  if (!entry || (req.method !== 'GET' && req.method !== 'HEAD')) {
    res.writeHead(404, { ...headers, 'Content-Type': 'text/plain' });
    return res.end('Not found');
  }
  fs.readFile(path.join(STATIC_DIR, entry[0]), (err, body) => {
    if (err) {
      res.writeHead(404, { ...headers, 'Content-Type': 'text/plain' });
      return res.end('Not found');
    }
    res.writeHead(200, { ...headers, 'Content-Type': entry[1], 'Cache-Control': 'no-cache' });
    res.end(req.method === 'HEAD' ? undefined : body);
  });
});

/* ----------------------------------------------------------------- rooms */

const rooms = new Map();

function newRoom(id) {
  return {
    id, options: [], removeWinner: false, history: [], rot: 0, seq: 0, spin: null,
    clients: new Set(), created: Date.now(), lastActive: Date.now(),
  };
}

const cleanText = (s, max) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, max);
const cleanWeight = (v) => {
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 10000) : 0;
};
const isActive = (o) => o.name.trim() && o.weight > 0;

function loadRooms() {
  try {
    const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    for (const [id, r] of Object.entries(data.rooms || {})) {
      if (!ROOM_RE.test(id)) continue;
      const room = newRoom(id);
      room.options = (r.options || []).slice(0, LIMITS.options).map((o) => ({
        id: String(o.id), name: cleanText(o.name, LIMITS.nameLen), weight: cleanWeight(o.weight),
      }));
      room.removeWinner = !!r.removeWinner;
      room.history = (r.history || []).slice(0, LIMITS.history);
      room.rot = Number(r.rot) || 0;
      room.created = r.created || Date.now();
      room.lastActive = r.lastActive || Date.now();
      rooms.set(id, room);
    }
    console.log(`Loaded ${rooms.size} room(s)`);
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('Could not load rooms:', e.message);
  }
}

let persistTimer = null;
function persistSoon() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => { persistTimer = null; persistNow(); }, 1500);
}

function persistNow() {
  const out = {};
  for (const r of rooms.values()) {
    out[r.id] = {
      options: r.options, removeWinner: r.removeWinner, history: r.history,
      rot: r.rot, created: r.created, lastActive: r.lastActive,
    };
  }
  try {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    const tmp = `${DATA_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ rooms: out }));
    fs.renameSync(tmp, DATA_FILE);
  } catch (e) {
    console.error('Could not save rooms:', e.message);
  }
}

setInterval(() => {
  const cutoff = Date.now() - LIMITS.idleDays * 86400000;
  let removed = 0;
  for (const [id, r] of rooms) {
    if (!r.clients.size && r.lastActive < cutoff) { rooms.delete(id); removed++; }
  }
  if (removed) { console.log(`Purged ${removed} idle room(s)`); persistSoon(); }
}, 3600000).unref();

const snapshot = (room) => ({
  id: room.id, seq: room.seq, options: room.options, removeWinner: room.removeWinner,
  history: room.history, rot: room.rot,
  spin: room.spin ? publicSpin(room.spin) : null,
});

const publicSpin = (s) => ({
  id: s.id, by: s.by, byName: s.byName, winnerId: s.winnerId, winnerName: s.winnerName,
  fromRot: s.fromRot, delta: s.delta, startAt: s.startAt, duration: s.duration,
});

const peersOf = (room) => [...room.clients].map((c) => ({
  id: c.id, name: c.name, focus: c.focus, status: c.status, since: c.since,
}));

function send(client, msg) {
  if (client.ws.readyState === 1) client.ws.send(JSON.stringify(msg));
}

function broadcast(room, msg, except) {
  const data = JSON.stringify(msg);
  for (const c of room.clients) {
    if (c !== except && c.ws.readyState === 1) c.ws.send(data);
  }
}

/* ------------------------------------------------------------ operations */

// Applies a client edit to the room. Returns the sanitised op to broadcast, or null if rejected.
function applyOp(room, op) {
  if (!op || typeof op !== 'object') return null;
  switch (op.op) {
    case 'add': {
      if (room.options.length >= LIMITS.options || !ID_RE.test(op.id) || room.options.some((o) => o.id === op.id)) return null;
      const o = { id: op.id, name: cleanText(op.name, LIMITS.nameLen), weight: cleanWeight(op.weight) };
      room.options.push(o);
      return { op: 'add', ...o };
    }
    case 'set': {
      const o = room.options.find((x) => x.id === op.id);
      if (!o) return null;
      const out = { op: 'set', id: o.id };
      if ('name' in op) { o.name = cleanText(op.name, LIMITS.nameLen); out.name = o.name; }
      if ('weight' in op) { o.weight = cleanWeight(op.weight); out.weight = o.weight; }
      return out;
    }
    case 'remove': {
      const i = room.options.findIndex((x) => x.id === op.id);
      if (i < 0) return null;
      room.options.splice(i, 1);
      return { op: 'remove', id: op.id };
    }
    case 'equalize':
      room.options.forEach((o) => { o.weight = 1; });
      return { op: 'equalize' };
    case 'clear':
      room.options = [];
      return { op: 'clear' };
    case 'setting':
      room.removeWinner = !!op.removeWinner;
      return { op: 'setting', removeWinner: room.removeWinner };
    default:
      return null;
  }
}

function startSpin(room, client) {
  if (room.spin) return send(client, { t: 'error', code: 'busy' });
  const act = room.options.filter(isActive);
  if (act.length < 2) return send(client, { t: 'error', code: 'need2' });

  const total = act.reduce((s, o) => s + o.weight, 0);
  let x = rnd() * total;
  let idx = act.length - 1;
  for (let i = 0; i < act.length; i++) {
    if (x < act[i].weight) { idx = i; break; }
    x -= act[i].weight;
  }
  let before = 0;
  for (let i = 0; i < idx; i++) before += act[i].weight;
  const winner = act[idx];

  // Land inside the winning slice, away from its edges. Same geometry the clients draw.
  const target = ((before + winner.weight * (0.12 + 0.76 * rnd())) / total) * TAU;
  const wanted = mod(-Math.PI / 2 - target, TAU);
  const turns = 5 + Math.floor(rnd() * 3);
  const delta = mod(wanted - mod(room.rot, TAU), TAU) + turns * TAU;
  const duration = Math.round(5200 + rnd() * 1400);
  const startAt = Date.now() + SPIN_LEAD_MS;

  room.spin = {
    id: clientId(), by: client.id, byName: client.name, winnerId: winner.id, winnerName: winner.name.trim(),
    fromRot: room.rot, delta, startAt, duration, timer: null,
  };
  room.lastActive = Date.now();
  broadcast(room, { t: 'spin', spin: publicSpin(room.spin), now: Date.now() });
  room.spin.timer = setTimeout(() => endSpin(room), startAt + duration + SPIN_TAIL_MS - Date.now());
}

function endSpin(room) {
  const s = room.spin;
  if (!s) return;
  room.rot = mod(s.fromRot + s.delta, TAU);
  const item = { optId: s.winnerId, name: s.winnerName, by: s.byName, at: Date.now() };
  room.history.unshift(item);
  room.history.length = Math.min(room.history.length, LIMITS.history);
  room.spin = null;

  let removed = null;
  if (room.removeWinner && room.options.some((o) => o.id === s.winnerId)) {
    room.options = room.options.filter((o) => o.id !== s.winnerId);
    removed = s.winnerId;
  }
  room.seq++;
  room.lastActive = Date.now();
  broadcast(room, { t: 'spinEnd', item, removed, seq: room.seq });
  persistSoon();
}

/* ------------------------------------------------------------ websockets */

const wss = new WebSocketServer({ noServer: true, maxPayload: LIMITS.payload });
const ipCounts = new Map();

function remoteIp(req) {
  if (TRUST_PROXY) {
    const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (fwd) return fwd;
  }
  return req.socket.remoteAddress || 'unknown';
}

function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // not a browser; origin checks only protect browser users
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  try { return new URL(origin).host === req.headers.host; } catch (_) { return false; }
}

httpServer.on('upgrade', (req, socket, head) => {
  const reject = (code, text) => { socket.write(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\n\r\n`); socket.destroy(); };
  if ((req.url || '').split('?')[0] !== '/ws') return reject(404, 'Not Found');
  if (!originAllowed(req)) return reject(403, 'Forbidden');
  const ip = remoteIp(req);
  if ((ipCounts.get(ip) || 0) >= LIMITS.connectionsPerIp) return reject(429, 'Too Many Requests');
  wss.handleUpgrade(req, socket, head, (ws) => { ws.ip = ip; wss.emit('connection', ws, req); });
});

wss.on('connection', (ws) => {
  ipCounts.set(ws.ip, (ipCounts.get(ws.ip) || 0) + 1);
  const client = {
    id: clientId(), ws, room: null, name: 'Guest', focus: null,
    status: 'active', since: Date.now(), lastReact: 0, // presence: active | idle | away
    tokens: LIMITS.burst, refilled: Date.now(),
  };
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  // Protocol errors (oversize frames, bad frames) surface here; without a listener they would crash the process.
  ws.on('error', () => ws.terminate());

  // A connection that never joins a room is dropped quickly.
  const joinTimer = setTimeout(() => { if (!client.room) ws.close(4000, 'join timeout'); }, 8000);

  ws.on('message', (raw, isBinary) => {
    if (isBinary) return ws.close(1003, 'text only');
    const now = Date.now();
    client.tokens = Math.min(LIMITS.burst, client.tokens + ((now - client.refilled) / 1000) * LIMITS.refillPerSec);
    client.refilled = now;
    if (client.tokens < 1) return ws.close(4008, 'rate limit');
    client.tokens -= 1;

    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (_) { return; }
    if (!msg || typeof msg.t !== 'string') return;
    try { handle(client, msg); } catch (e) { console.error('handler error:', e); }
  });

  ws.on('close', () => {
    clearTimeout(joinTimer);
    const n = (ipCounts.get(ws.ip) || 1) - 1;
    if (n <= 0) ipCounts.delete(ws.ip); else ipCounts.set(ws.ip, n);
    const room = client.room;
    if (!room) return;
    room.clients.delete(client);
    room.lastActive = Date.now();
    broadcast(room, { t: 'peers', peers: peersOf(room) });
    broadcast(room, { t: 'focus', by: client.id, id: null });
  });
});

setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 15000).unref();

function handle(client, msg) {
  if (msg.t === 'ping') return send(client, { t: 'pong', c: msg.c, s: Date.now() });

  if (msg.t === 'join') {
    if (client.room) return;
    const id = String(msg.room || '');
    if (!ROOM_RE.test(id)) return send(client, { t: 'error', code: 'badroom' });
    let room = rooms.get(id);
    if (!room) {
      if (!msg.create) return send(client, { t: 'error', code: 'notfound' });
      if (rooms.size >= LIMITS.rooms) return send(client, { t: 'error', code: 'full' });
      room = newRoom(id);
      rooms.set(id, room);
      const seed = msg.seed && typeof msg.seed === 'object' ? msg.seed : {};
      const seen = new Set();
      for (const row of Array.isArray(seed.options) ? seed.options.slice(0, LIMITS.options) : []) {
        if (!Array.isArray(row)) continue;
        let oid = typeof row[2] === 'string' && ID_RE.test(row[2]) ? row[2] : `o${clientId().slice(0, 7)}`;
        if (seen.has(oid)) oid = `o${clientId().slice(0, 7)}`;
        seen.add(oid);
        room.options.push({ id: oid, name: cleanText(row[0], LIMITS.nameLen), weight: cleanWeight(row[1]) });
      }
      room.removeWinner = !!seed.removeWinner;
      persistSoon();
    }
    if (room.clients.size >= LIMITS.clientsPerRoom) return send(client, { t: 'error', code: 'roomfull' });

    client.name = cleanText(msg.name, LIMITS.peerNameLen).trim() || 'Guest';
    client.room = room;
    room.clients.add(client);
    room.lastActive = Date.now();
    send(client, { t: 'welcome', you: client.id, now: Date.now(), room: snapshot(room), peers: peersOf(room) });
    broadcast(room, { t: 'peers', peers: peersOf(room) }, client);
    return;
  }

  const room = client.room;
  if (!room) return;
  room.lastActive = Date.now();

  switch (msg.t) {
    case 'op': {
      if (room.spin) {
        send(client, { t: 'error', code: 'spinning' });
        return send(client, { t: 'snapshot', room: snapshot(room) });
      }
      const op = applyOp(room, msg.op);
      if (!op) return send(client, { t: 'snapshot', room: snapshot(room) });
      room.seq++;
      broadcast(room, { t: 'op', op, by: client.id, seq: room.seq });
      persistSoon();
      return;
    }
    case 'spin':
      return startSpin(room, client);
    case 'focus': {
      const id = typeof msg.id === 'string' && ID_RE.test(msg.id) ? msg.id : null;
      client.focus = id;
      return broadcast(room, { t: 'focus', by: client.id, id }, client);
    }
    case 'name': {
      client.name = cleanText(msg.name, LIMITS.peerNameLen).trim() || 'Guest';
      return broadcast(room, { t: 'peers', peers: peersOf(room) });
    }
    case 'status': {
      if (!STATUSES.includes(msg.s) || msg.s === client.status) return;
      client.status = msg.s;
      client.since = Date.now();
      return broadcast(room, { t: 'presence', id: client.id, status: client.status, since: client.since }, client);
    }
    case 'react': {
      // Reactions are an index into a fixed emoji list kept on the client, so no free text travels.
      const now = Date.now();
      if (!Number.isInteger(msg.i) || msg.i < 0 || msg.i >= LIMITS.reactions || now - client.lastReact < 300) return;
      client.lastReact = now;
      return broadcast(room, { t: 'react', by: client.id, i: msg.i }, client);
    }
    case 'sync':
      return send(client, { t: 'snapshot', room: snapshot(room) });
    default:
  }
}

/* ------------------------------------------------------------------ boot */

loadRooms();
httpServer.listen(PORT, HOST, () => console.log(`Spin the Wheel listening on http://${HOST}:${PORT}`));

function shutdown() {
  console.log('Shutting down…');
  if (persistTimer) clearTimeout(persistTimer);
  persistNow();
  wss.clients.forEach((ws) => ws.close(1001, 'server restarting'));
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
