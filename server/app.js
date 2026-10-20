'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { WebSocketServer } = require('ws');
const { Room } = require('./room.js');
const sec = require('./security.js');
const { C } = require('../public/js/sim.js');

const PUBLIC_DIR = path.resolve(__dirname, '..', 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

const DEFAULT_CONFIG = {
  trustProxyHops: 0, // set to 1 when running behind a single reverse proxy (Render, Fly, Railway...)
  allowedOrigins: [], // extra allowed Origin values, e.g. ['https://game.example.com']
  maxRooms: 300,
  maxConnections: 2000,
  maxConnectionsPerIp: 12,
  connectsPerMinutePerIp: 40,
  roomsPerTenMinPerIp: 8,
  failedJoinsPerMinPerIp: 8,
  authTimeoutMs: 15000,
  room: {}, // overrides for Room config (tests use short timers)
};

function createApp(userConfig = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...userConfig };
  const rooms = new Map();
  const conns = new Set();
  const connsPerIp = new Map();
  const connectRate = new sec.WindowCounter(60_000);
  const roomCreateRate = new sec.WindowCounter(600_000);
  const failedJoins = new sec.WindowCounter(60_000);
  const blockedUntil = new Map();

  // ---------- helpers ----------

  function clientIp(req) {
    const remote = req.socket.remoteAddress || 'unknown';
    if (!cfg.trustProxyHops) return remote;
    const fwd = String(req.headers['x-forwarded-for'] || '')
      .split(',').map((s) => s.trim()).filter(Boolean);
    return fwd[fwd.length - cfg.trustProxyHops] || remote;
  }

  function isSecureRequest(req) {
    if (req.socket.encrypted) return true;
    return cfg.trustProxyHops > 0 && String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
  }

  function hostOf(req) {
    const host = String(req.headers.host || '');
    return /^[a-z0-9.\-:[\]]{1,255}$/i.test(host) ? host : 'localhost';
  }

  function securityHeaders(req, res) {
    const host = hostOf(req);
    res.setHeader('Content-Security-Policy', [
      "default-src 'none'",
      "script-src 'self'",
      "style-src 'self'",
      "img-src 'self' data:",
      `connect-src 'self' ws://${host} wss://${host}`,
      "manifest-src 'self'",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
    ].join('; '));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
    if (isSecureRequest(req)) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }

  // ---------- static files ----------

  const httpServer = http.createServer((req, res) => {
    securityHeaders(req, res);
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' });
      return res.end();
    }
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    } catch {
      res.writeHead(400);
      return res.end('Bad request');
    }
    if (pathname === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      return res.end('ok');
    }
    if (pathname.includes('\0')) {
      res.writeHead(400);
      return res.end('Bad request');
    }
    if (pathname === '/') pathname = '/index.html';
    const filePath = path.resolve(PUBLIC_DIR, '.' + path.posix.normalize(pathname));
    if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + path.sep)) {
      res.writeHead(403);
      return res.end('Forbidden');
    }
    const type = MIME[path.extname(filePath).toLowerCase()];
    if (!type) {
      res.writeHead(404);
      return res.end('Not found');
    }
    fs.stat(filePath, (err, st) => {
      if (err || !st.isFile()) {
        res.writeHead(404);
        return res.end('Not found');
      }
      res.writeHead(200, {
        'Content-Type': type,
        'Content-Length': st.size,
        'Cache-Control': 'no-cache',
      });
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(filePath).pipe(res);
    });
  });
  httpServer.headersTimeout = 10_000;
  httpServer.requestTimeout = 15_000;
  httpServer.maxHeadersCount = 50;

  // ---------- websockets ----------

  const wss = new WebSocketServer({ noServer: true, maxPayload: 512, perMessageDeflate: false });

  function originAllowed(req) {
    const origin = req.headers.origin;
    if (!origin) return false; // every browser sends one; this blocks cross-site hijacking
    if (cfg.allowedOrigins.includes(origin)) return true;
    try {
      return new URL(origin).host === req.headers.host;
    } catch {
      return false;
    }
  }

  function reject(socket, code, text) {
    socket.write(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    socket.destroy();
  }

  httpServer.on('upgrade', (req, socket, head) => {
    socket.on('error', () => {});
    let pathname = '';
    try { pathname = new URL(req.url, 'http://x').pathname; } catch { /* ignore */ }
    if (pathname !== '/ws') return reject(socket, 404, 'Not Found');
    if (!originAllowed(req)) return reject(socket, 403, 'Forbidden');

    const ip = clientIp(req);
    if (conns.size >= cfg.maxConnections) return reject(socket, 503, 'Service Unavailable');
    if ((connsPerIp.get(ip) || 0) >= cfg.maxConnectionsPerIp) return reject(socket, 429, 'Too Many Requests');
    if (connectRate.add(ip) > cfg.connectsPerMinutePerIp) return reject(socket, 429, 'Too Many Requests');
    if ((blockedUntil.get(ip) || 0) > Date.now()) return reject(socket, 429, 'Too Many Requests');

    wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, ip));
  });

  function onConnection(ws, ip) {
    connsPerIp.set(ip, (connsPerIp.get(ip) || 0) + 1);
    const conn = {
      ws,
      ip,
      room: null,
      player: null,
      alive: true,
      bucket: new sec.TokenBucket(80, 50),
      strikes: 0,
      send(obj) {
        if (ws.readyState !== ws.OPEN) return;
        // Don't let a slow client build an unbounded send buffer.
        if (ws.bufferedAmount > 256 * 1024) return ws.terminate();
        ws.send(typeof obj === 'string' ? obj : JSON.stringify(obj));
      },
      kick(reason) {
        this.send({ t: 'bye', reason });
        setTimeout(() => ws.close(1000, reason), 50).unref();
      },
    };
    conns.add(conn);

    const authTimer = setTimeout(() => { if (!conn.player) ws.close(1008, 'auth timeout'); }, cfg.authTimeoutMs);
    authTimer.unref();

    ws.on('pong', () => { conn.alive = true; });
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      if (!conn.bucket.take()) {
        if (++conn.strikes > 150) ws.terminate();
        return;
      }
      let msg;
      try { msg = JSON.parse(data.toString('utf8')); } catch { return; }
      if (msg === null || typeof msg !== 'object' || Array.isArray(msg) || typeof msg.t !== 'string') return;
      try {
        handleMessage(conn, msg);
      } catch (err) {
        console.error('message handler error:', err);
      }
    });
    ws.on('close', () => {
      clearTimeout(authTimer);
      conns.delete(conn);
      const left = (connsPerIp.get(ip) || 1) - 1;
      if (left <= 0) connsPerIp.delete(ip);
      else connsPerIp.set(ip, left);
      if (conn.room && conn.player) conn.room.detach(conn.player, conn);
    });
    ws.on('error', () => {});
  }

  function noteFailedJoin(conn) {
    if (failedJoins.add(conn.ip) >= cfg.failedJoinsPerMinPerIp) {
      blockedUntil.set(conn.ip, Date.now() + 5 * 60_000);
      conn.send({ t: 'err', code: 'blocked', msg: 'Too many wrong codes. Try again in a few minutes.' });
      conn.ws.close(1008, 'blocked');
      return true;
    }
    return false;
  }

  function admit(conn, room, player, token) {
    room.attach(player, conn);
    conn.room = room;
    conn.player = player;
    conn.send({ t: 'welcome', code: room.code, id: player.id, token, world: { w: C.W, h: C.H }, tick: room.tick });
    conn.send(room.rosterMessage());
  }

  function handleMessage(conn, msg) {
    if (!conn.player) {
      switch (msg.t) {
        case 'create': return onCreate(conn, msg);
        case 'join': return onJoin(conn, msg);
        case 'resume': return onResume(conn, msg);
        default: return;
      }
    }
    const { room, player } = conn;
    switch (msg.t) {
      case 'in': return room.handleInput(player, msg);
      case 'start': return room.handleStart(player);
      case 'emote': return room.handleEmote(player, msg.id);
      case 'kick': return room.handleKick(player, msg.id);
      case 'p':
        if (Number.isFinite(msg.n)) conn.send({ t: 'q', n: msg.n });
        return;
      case 'leave':
        room.removePlayer(player.id);
        conn.player = null;
        conn.room = null;
        return conn.ws.close(1000, 'left');
      default:
    }
  }

  function validProfile(msg) {
    return Number.isInteger(msg.a) && msg.a >= 0 && msg.a < 12;
  }

  function onCreate(conn, msg) {
    if (!validProfile(msg)) return conn.send({ t: 'err', code: 'bad_request', msg: 'Pick a character first.' });
    if (rooms.size >= cfg.maxRooms) return conn.send({ t: 'err', code: 'busy', msg: 'The server is full right now. Try again soon.' });
    if (roomCreateRate.add(conn.ip) > cfg.roomsPerTenMinPerIp) {
      return conn.send({ t: 'err', code: 'rate', msg: 'You are making rooms too fast. Wait a bit.' });
    }
    const code = sec.generateRoomCode((c) => rooms.has(c));
    if (!code) return conn.send({ t: 'err', code: 'busy', msg: 'Could not make a room. Try again.' });
    const room = new Room(code, cfg.room);
    const added = room.addPlayer(msg.n, msg.a);
    rooms.set(code, room);
    admit(conn, room, added.player, added.token);
  }

  function onJoin(conn, msg) {
    if (!validProfile(msg)) return conn.send({ t: 'err', code: 'bad_request', msg: 'Pick a character first.' });
    const code = sec.normalizeCode(msg.code);
    const room = code && rooms.get(code);
    if (!room) {
      if (noteFailedJoin(conn)) return;
      return conn.send({ t: 'err', code: 'no_room', msg: "That code didn't work. Check it and try again." });
    }
    const added = room.addPlayer(msg.n, msg.a);
    if (!added) return conn.send({ t: 'err', code: 'full', msg: 'That room is full.' });
    admit(conn, room, added.player, added.token);
  }

  function onResume(conn, msg) {
    const code = sec.normalizeCode(msg.code);
    const room = code && rooms.get(code);
    const player = room && room.findByToken(msg.token);
    if (!player) {
      if (noteFailedJoin(conn)) return;
      return conn.send({ t: 'err', code: 'bad_session', msg: 'Your session expired.' });
    }
    admit(conn, room, player, msg.token);
  }

  // ---------- loops ----------

  const TICK_MS = C.TICK * 1000;
  let nextTick = performance.now() + TICK_MS;
  let loopTimer = null;
  function loop() {
    let now = performance.now();
    let steps = 0;
    while (now >= nextTick && steps < 3) {
      nextTick += TICK_MS;
      steps++;
      for (const [code, room] of rooms) {
        const keep = room.update(C.TICK);
        room.broadcast();
        if (!keep) {
          room.closeAll('closed');
          rooms.delete(code);
        }
      }
    }
    if (now - nextTick > 500) nextTick = now + TICK_MS; // fell far behind; resync instead of spiralling
    loopTimer = setTimeout(loop, Math.max(1, nextTick - performance.now()));
  }

  const heartbeat = setInterval(() => {
    for (const conn of conns) {
      if (!conn.alive) { conn.ws.terminate(); continue; }
      conn.alive = false;
      try { conn.ws.ping(); } catch { /* ignore */ }
    }
    connectRate.sweep();
    roomCreateRate.sweep();
    failedJoins.sweep();
    const now = Date.now();
    for (const [ip, until] of blockedUntil) if (until <= now) blockedUntil.delete(ip);
  }, 15_000);
  heartbeat.unref();

  function listen(port, host) {
    return new Promise((resolve) => {
      httpServer.listen(port, host, () => {
        nextTick = performance.now() + TICK_MS;
        loop();
        resolve(httpServer.address());
      });
    });
  }

  function close() {
    clearTimeout(loopTimer);
    clearInterval(heartbeat);
    for (const conn of conns) conn.ws.terminate();
    return new Promise((resolve) => httpServer.close(() => resolve()));
  }

  return { listen, close, rooms, conns, httpServer };
}

module.exports = { createApp };
