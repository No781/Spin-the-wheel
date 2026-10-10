// End-to-end test of a Spin the Wheel server over WebSocket: join a room, measure latency, spin,
// wait for the result, and make sure a second client sees the shared state.
//
//   node check.js ws://127.0.0.1:8080/ws
//   node check.js wss://wheel.example.com/ws [--ip 127.0.0.1]   (--ip: connect to this address instead of resolving the name)
'use strict';
const path = require('path');
let WebSocket;
try { WebSocket = require(path.join(__dirname, '..', 'server', 'node_modules', 'ws')); }
catch (_) { console.log('FAIL cannot load the ws module (run npm ci in server/)'); process.exit(2); }

const url = process.argv[2];
const ipIdx = process.argv.indexOf('--ip');
const forceIp = ipIdx > 0 ? process.argv[ipIdx + 1] : null;
if (!url) { console.log('usage: node check.js <ws-url> [--ip ADDR]'); process.exit(2); }

const origin = url.replace(/^ws/, 'http').replace(/\/ws$/, '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function connect() {
  const opts = { headers: { Origin: origin }, handshakeTimeout: 8000 };
  if (forceIp) opts.lookup = (host, o, cb) => (o && o.all ? cb(null, [{ address: forceIp, family: 4 }]) : cb(null, forceIp, 4));
  const ws = new WebSocket(url, opts);
  const queue = [];
  const waiters = [];
  ws.on('message', (d) => {
    const m = JSON.parse(d.toString());
    const i = waiters.findIndex((w) => w.type === m.t);
    if (i >= 0) waiters.splice(i, 1)[0].resolve(m); else queue.push(m);
  });
  const next = (type, ms = 8000) => new Promise((resolve, reject) => {
    const q = queue.findIndex((m) => m.t === type);
    if (q >= 0) return resolve(queue.splice(q, 1)[0]);
    const w = { type, resolve };
    waiters.push(w);
    setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0) { waiters.splice(i, 1); reject(new Error(`timed out waiting for "${type}"`)); } }, ms);
  });
  const opened = new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); ws.on('unexpected-response', (_, r) => reject(new Error(`HTTP ${r.statusCode} during WebSocket handshake`))); });
  return { ws, next, opened, send: (o) => ws.send(JSON.stringify(o)) };
}

(async () => {
  const room = 'chk' + Math.random().toString(36).slice(2, 12);
  const a = connect();
  await a.opened;
  console.log('ok   WebSocket connected');

  a.send({ t: 'join', room, name: 'check-A', create: true, seed: { options: [['One', 1, 'oa1x'], ['Two', 1, 'ob2x'], ['Three', 2, 'oc3x']] } });
  const welcome = await a.next('welcome');
  if (welcome.room.options.length !== 3) throw new Error('welcome did not contain the seeded options');
  console.log('ok   joined a test room and got the options back');

  const t0 = Date.now();
  a.send({ t: 'ping', c: t0 });
  await a.next('pong');
  console.log(`ok   round trip ${Date.now() - t0} ms`);

  const b = connect();
  await b.opened;
  b.send({ t: 'join', room, name: 'check-B' });
  await b.next('welcome');
  const peers = await a.next('peers');
  if (peers.peers.length !== 2) throw new Error('second client did not show up in the room');
  console.log('ok   a second client joined and the first one saw it (presence works)');

  a.send({ t: 'op', op: { op: 'set', id: 'oa1x', weight: 3 } });
  const op = await b.next('op');
  if (op.op.weight !== 3) throw new Error('edit was not relayed');
  console.log('ok   an edit made by one client reached the other');

  const started = Date.now();
  b.send({ t: 'spin' });
  const spinA = await a.next('spin');
  await b.next('spin');
  if (!['oa1x', 'ob2x', 'oc3x'].includes(spinA.spin.winnerId)) throw new Error('spin winner is not one of the options');
  console.log(`ok   spin started on both clients (winner: ${spinA.spin.winnerName})`);
  const end = await a.next('spinEnd', spinA.spin.duration + 4000);
  await b.next('spinEnd');
  if (end.item.name !== spinA.spin.winnerName) throw new Error('result in the history differs from the spin');
  console.log(`ok   spin finished after ${((Date.now() - started) / 1000).toFixed(1)} s and went into the shared history`);

  a.ws.close(); b.ws.close();
  await sleep(100);
  console.log('PASS');
  process.exit(0);
})().catch((e) => { console.log('FAIL ' + e.message); process.exit(1); });
