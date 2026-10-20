'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const WebSocket = require('ws');
const { createApp } = require('../server/app.js');
const sec = require('../server/security.js');
const Sim = require('../public/js/sim.js');

async function boot(config = {}) {
  const app = createApp({ room: { countdownSec: 0.1, roundSec: 0.5 }, ...config });
  const addr = await app.listen(0, '127.0.0.1');
  return { app, port: addr.port, origin: `http://127.0.0.1:${addr.port}` };
}

function client(port, headers = { Origin: `http://127.0.0.1:${port}` }) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers });
  const inbox = [];
  const waiters = [];
  ws.on('message', (d) => {
    const m = JSON.parse(d.toString());
    const i = waiters.findIndex((w) => w.pred(m));
    if (i >= 0) waiters.splice(i, 1)[0].resolve(m);
    else inbox.push(m);
  });
  ws.next = (pred, ms = 2000) => {
    const idx = inbox.findIndex(pred);
    if (idx >= 0) return Promise.resolve(inbox.splice(idx, 1)[0]);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout waiting for message')), ms);
      waiters.push({ pred, resolve: (m) => { clearTimeout(timer); resolve(m); } });
    });
  };
  ws.json = (o) => ws.send(JSON.stringify(o));
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
    ws.once('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
  });
}

function get(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path, headers }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    }).on('error', reject);
  });
}

test('room codes are unambiguous and normalised', () => {
  for (let i = 0; i < 200; i++) {
    const code = sec.generateRoomCode();
    assert.equal(code.length, 6);
    assert.equal(sec.normalizeCode(code), code);
  }
  assert.equal(sec.normalizeCode('abc-def'), null); // B/F-style ambiguity: B is not in the alphabet
  assert.equal(sec.normalizeCode('<script>'), null);
  assert.equal(sec.normalizeCode(12345), null);
});

test('names are sanitised', () => {
  assert.equal(sec.sanitizeName('<b>Bob</b>'), 'bBobb');
  assert.equal(sec.sanitizeName('   '), 'Player');
  assert.equal(sec.sanitizeName({}), 'Player');
  assert.equal(sec.sanitizeName('Zoë 😀 Müller‮'), 'Zoë Müller');
  assert.ok(Array.from(sec.sanitizeName('x'.repeat(100))).length <= 16);
});

test('shared simulation: speed, walls, obstacles, dash', () => {
  const b = Sim.newBody(100, 100);
  for (let i = 0; i < 30; i++) Sim.step(b, { x: 1, y: 0, dash: false }, Sim.C.TICK);
  assert.ok(Math.abs(b.x - (100 + Sim.C.SPEED)) < 1, 'moves at SPEED');
  // diagonal input is normalised, not faster
  const d = Sim.newBody(100, 100);
  for (let i = 0; i < 30; i++) Sim.step(d, { x: 1, y: 1, dash: false }, Sim.C.TICK);
  assert.ok(Math.hypot(d.x - 100, d.y - 100) < Sim.C.SPEED + 1);
  // absurd analog values are clamped
  const g = Sim.newBody(100, 100);
  for (let i = 0; i < 30; i++) Sim.step(g, { x: 50, y: 0, dash: false }, Sim.C.TICK);
  assert.ok(g.x - 100 < Sim.C.SPEED + 1);
  // walls
  const w = Sim.newBody(Sim.C.W - 30, 100);
  for (let i = 0; i < 60; i++) Sim.step(w, { x: 1, y: 0, dash: false }, Sim.C.TICK);
  assert.equal(w.x, Sim.C.W - Sim.C.R);
  // obstacle
  const o = Sim.C.OBSTACLES[0];
  const p = Sim.newBody(o.x - 200, o.y);
  for (let i = 0; i < 120; i++) Sim.step(p, { x: 1, y: 0, dash: false }, Sim.C.TICK);
  assert.ok(Math.hypot(p.x - o.x, p.y - o.y) >= o.r + Sim.C.R - 0.001);
  // dash has a cooldown
  const k = Sim.newBody(100, 600);
  Sim.step(k, { x: 1, y: 0, dash: true }, Sim.C.TICK);
  assert.ok(k.dash > 0 && k.dcd > 0);
  const dashTime = k.dash;
  while (k.dash > 0) Sim.step(k, { x: 1, y: 0, dash: true }, Sim.C.TICK);
  Sim.step(k, { x: 1, y: 0, dash: true }, Sim.C.TICK);
  assert.equal(k.dash, 0, 'cannot re-dash during cooldown');
  assert.ok(dashTime <= Sim.C.DASH_TIME);
});

test('static server: security headers, no traversal, only GET', async () => {
  const { app, port } = await boot();
  try {
    const home = await get(port, '/');
    assert.equal(home.status, 200);
    assert.match(home.headers['content-security-policy'], /default-src 'none'/);
    assert.equal(home.headers['x-content-type-options'], 'nosniff');
    assert.equal(home.headers['x-frame-options'], 'DENY');
    for (const bad of ['/../package.json', '/%2e%2e/package.json', '/..%2fserver/app.js', '/server/app.js', '/%00']) {
      const r = await get(port, bad);
      assert.ok([400, 403, 404].includes(r.status), `${bad} -> ${r.status}`);
      assert.ok(!r.body.includes('createApp'), `${bad} leaked source`);
    }
    const post = await new Promise((resolve) => {
      const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/' }, (res) => resolve(res.statusCode));
      req.end();
    });
    assert.equal(post, 405);
  } finally { await app.close(); }
});

test('websocket rejects missing or foreign origins', async () => {
  const { app, port } = await boot();
  try {
    await assert.rejects(client(port, {}), /403/);
    await assert.rejects(client(port, { Origin: 'https://evil.example' }), /403/);
    const ok = await client(port);
    ok.close();
  } finally { await app.close(); }
});

test('create, join with code, play a round, reconnect, leave', async () => {
  const { app, port } = await boot();
  try {
    const a = await client(port);
    a.json({ t: 'create', n: 'Amara', a: 0 });
    const wa = await a.next((m) => m.t === 'welcome');
    assert.match(wa.code, /^[A-Z0-9]{6}$/);
    assert.ok(wa.token.length >= 30);

    const b = await client(port);
    b.json({ t: 'join', code: wa.code.toLowerCase(), n: 'Amara', a: 3 });
    const wb = await b.next((m) => m.t === 'welcome');
    assert.equal(wb.code, wa.code);
    const roster = await b.next((m) => m.t === 'room' && m.players.length === 2);
    assert.deepEqual(roster.players.map((p) => p.n).sort(), ['Amara', 'Amara 2']); // unique names
    assert.equal(roster.host, wa.id);

    // Non-host cannot start the game
    b.json({ t: 'start' });
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(app.rooms.get(wa.code).phase, 'lobby');

    // Host starts: countdown -> playing -> results
    a.json({ t: 'start' });
    await a.next((m) => m.t === 's' && m.ph === 'countdown');
    await a.next((m) => m.t === 's' && m.ph === 'playing');
    a.json({ t: 'in', s: 1, x: 1, y: 0, d: 0 });
    const snap = await a.next((m) => m.t === 's' && m.me && m.me[0] === 1);
    assert.equal(snap.me.length, 12);
    await a.next((m) => m.t === 's' && m.ph === 'results');

    // Reconnect b with its token
    const bToken = wb.token;
    b.close();
    await a.next((m) => m.t === 'room' && m.players.some((p) => p.id === wb.id && p.on === 0));
    const b2 = await client(port);
    b2.json({ t: 'resume', code: wa.code, token: bToken });
    const wb2 = await b2.next((m) => m.t === 'welcome');
    assert.equal(wb2.id, wb.id);

    // A forged token must not work
    const evil = await client(port);
    evil.json({ t: 'resume', code: wa.code, token: 'x'.repeat(32) });
    const err = await evil.next((m) => m.t === 'err');
    assert.equal(err.code, 'bad_session');

    // Host can kick
    a.json({ t: 'kick', id: wb.id });
    await b2.next((m) => m.t === 'bye' && m.reason === 'kicked');

    a.json({ t: 'leave' });
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(app.rooms.get(wa.code).players.size, 0);
    a.close(); b2.close(); evil.close();
  } finally { await app.close(); }
});

test('room is capped at 8 players and codes are validated', async () => {
  const { app, port } = await boot();
  try {
    const host = await client(port);
    host.json({ t: 'create', n: 'Host', a: 1 });
    const w = await host.next((m) => m.t === 'welcome');
    const extras = [];
    for (let i = 0; i < 7; i++) {
      const c = await client(port);
      c.json({ t: 'join', code: w.code, n: `P${i}`, a: i });
      await c.next((m) => m.t === 'welcome');
      extras.push(c);
    }
    const ninth = await client(port);
    ninth.json({ t: 'join', code: w.code, n: 'Late', a: 2 });
    assert.equal((await ninth.next((m) => m.t === 'err')).code, 'full');

    const badProfile = await client(port);
    badProfile.json({ t: 'join', code: w.code, n: 'X', a: 999 });
    assert.equal((await badProfile.next((m) => m.t === 'err')).code, 'bad_request');
    [host, ninth, badProfile, ...extras].forEach((c) => c.close());
  } finally { await app.close(); }
});

test('guessing codes gets an IP temporarily blocked', async () => {
  const { app, port } = await boot({ failedJoinsPerMinPerIp: 5 });
  try {
    const c = await client(port);
    let blocked = false;
    for (let i = 0; i < 6 && !blocked; i++) {
      c.json({ t: 'join', code: 'ACDEFG', n: 'Guess', a: 0 });
      const e = await c.next((m) => m.t === 'err');
      blocked = e.code === 'blocked';
    }
    assert.ok(blocked, 'should be blocked after repeated failures');
    await assert.rejects(client(port), /429/);
  } finally { await app.close(); }
});

test('malformed, oversized and abusive messages are survived', async () => {
  const { app, port } = await boot();
  try {
    const c = await client(port);
    c.send('not json');
    c.send('[]');
    c.send('null');
    c.send(JSON.stringify({ t: 5 }));
    c.send(JSON.stringify({ t: 'join', code: { $ne: 1 }, n: 1, a: 'x' }));
    c.send(JSON.stringify({ t: 'in', s: 1, x: 1, y: 0 })); // before auth: ignored
    c.json({ t: 'create', n: { evil: true }, a: 2 });
    const w = await c.next((m) => m.t === 'welcome');
    const room = app.rooms.get(w.code);
    const player = room.players.get(w.id);
    assert.equal(player.name, 'Player');

    // Hostile inputs never produce NaN or out-of-range positions
    for (let s = 1; s <= 20; s++) {
      c.json({ t: 'in', s, x: 'NaN', y: 1e308, d: 1 });
      c.json({ t: 'in', s: s + 100, x: -9999, y: null, d: 'yes' });
    }
    await new Promise((r) => setTimeout(r, 200));
    assert.ok(Number.isFinite(player.body.x) && Number.isFinite(player.body.y));
    assert.ok(player.body.x >= 0 && player.body.x <= Sim.C.W && player.body.y >= 0 && player.body.y <= Sim.C.H);

    // Oversized frame closes the socket
    const closed = new Promise((r) => c.once('close', (code) => r(code)));
    c.send('x'.repeat(5000));
    assert.equal(await closed, 1009);
  } finally { await app.close(); }
});

test('speed hacking by flooding inputs does not move faster', async () => {
  const { app, port } = await boot({ room: { countdownSec: 0.05, roundSec: 30 } });
  try {
    const c = await client(port);
    c.json({ t: 'create', n: 'Flash', a: 4 });
    const w = await c.next((m) => m.t === 'welcome');
    const room = app.rooms.get(w.code);
    const player = room.players.get(w.id);
    c.json({ t: 'start' });
    await c.next((m) => m.t === 's' && m.ph === 'playing');
    const start = { x: player.body.x, y: player.body.y };
    const t0 = Date.now();
    let seq = 1;
    // Send 5x more inputs than ticks, but within the rate limit.
    const timer = setInterval(() => { for (let i = 0; i < 2; i++) c.json({ t: 'in', s: seq++, x: 0, y: -1, d: 0 }); }, 15);
    await new Promise((r) => setTimeout(r, 600));
    clearInterval(timer);
    const elapsed = (Date.now() - t0) / 1000;
    const travelled = Math.hypot(player.body.x - start.x, player.body.y - start.y);
    assert.ok(travelled <= Sim.C.SPEED * elapsed * 1.15 + 15, `travelled ${travelled} in ${elapsed}s`);
    c.close();
  } finally { await app.close(); }
});

// ---------------------------------------------------------------- game rules

const { Room } = require('../server/room.js');

function fakeConn() {
  return { sent: [], send(m) { this.sent.push(m); }, kick() {} };
}

function playingRoom(n = 2) {
  const room = new Room('TESTAA', { countdownSec: 0, roundSec: 60 });
  const ps = [];
  for (let i = 0; i < n; i++) {
    const { player } = room.addPlayer(`P${i}`, i);
    room.attach(player, fakeConn());
    ps.push(player);
  }
  room.handleStart(ps[0]);
  room.update(Sim.C.TICK); // countdown -> playing
  assert.equal(room.phase, 'playing');
  return { room, ps };
}

test('collecting a coin and a gem adds to the score', () => {
  const { room, ps } = playingRoom(1);
  const p = ps[0];
  room.coins = [];
  room.coinTimer = 99; room.gemTimer = 99;
  room.addCoin(p.body.x, p.body.y, 0, 1);
  room.addCoin(p.body.x, p.body.y, 1, 1);
  room.update(Sim.C.TICK);
  assert.equal(p.score, 6);
  assert.equal(room.coins.length, 0);
});

test('dashing into a rival steals coins, stuns them, and has an invulnerability window', () => {
  const { room, ps } = playingRoom(2);
  const [a, b] = ps;
  room.coinTimer = 99; room.gemTimer = 99; room.coins = [];
  a.body.x = 400; a.body.y = 600; a.body.dash = 0.15; a.body.ddx = 1; a.body.ddy = 0;
  b.body.x = 400 + Sim.C.R * 2 - 4; b.body.y = 600;
  b.score = 5;
  a.lastIn = { x: 1, y: 0 };
  room.update(Sim.C.TICK);
  assert.equal(b.score, 2, 'victim loses 3');
  assert.ok(b.body.stun > 0);
  assert.ok(b.invuln > 0);
  assert.equal(room.coins.length, 3, 'stolen coins drop on the floor');
  // A second hit inside the invulnerability window does nothing
  a.body.dash = 0.15; a.body.ddx = 1; a.body.ddy = 0;
  b.body.x = a.body.x + Sim.C.R * 2 - 4; b.body.y = a.body.y;
  room.update(Sim.C.TICK);
  assert.equal(b.score, 2);
});

test('host migrates when the host disconnects', () => {
  const room = new Room('TESTBB');
  const { player: p1 } = room.addPlayer('One', 0);
  const { player: p2 } = room.addPlayer('Two', 1);
  const c1 = fakeConn(); const c2 = fakeConn();
  room.attach(p1, c1); room.attach(p2, c2);
  assert.equal(room.hostId, p1.id);
  room.detach(p1, c1);
  assert.equal(room.hostId, p2.id);
  room.handleStart(p1); // former host can no longer start
  assert.equal(room.phase, 'lobby');
});

test('round ends and scores reset on replay', () => {
  const { room, ps } = playingRoom(1);
  ps[0].score = 12;
  room.phaseLeft = 0.01;
  room.update(Sim.C.TICK);
  assert.equal(room.phase, 'results');
  room.handleStart(ps[0]);
  assert.equal(room.phase, 'countdown');
  assert.equal(ps[0].score, 0);
});
