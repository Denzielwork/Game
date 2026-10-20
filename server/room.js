'use strict';
const Sim = require('../public/js/sim.js');
const { newToken, hashToken, tokenMatches, sanitizeName } = require('./security.js');

const { C } = Sim;

const DEFAULTS = Object.freeze({
  maxPlayers: 8,
  countdownSec: 3,
  roundSec: 90,
  disconnectGraceSec: 20,
  emptyRoomTtlSec: 60,
  maxInputQueue: 3,
  avatarCount: 12,
  emoteCount: 6,
});

const CENTER_X = C.W / 2;
const CENTER_Y = C.H / 2;

class Room {
  constructor(code, config = {}) {
    this.code = code;
    this.cfg = { ...DEFAULTS, ...config };
    this.players = new Map();
    this.nextId = 1;
    this.hostId = null;
    this.phase = 'lobby';
    this.phaseLeft = 0;
    this.tick = 0;
    this.coins = [];
    this.nextCoinId = 1;
    this.coinTimer = 0;
    this.gemTimer = 8;
    this.events = [];
    this.rosterDirty = true;
    this.emptySince = null;
    this.createdAt = Date.now();
  }

  // ---------- membership ----------

  get connectedCount() {
    let n = 0;
    for (const p of this.players.values()) if (p.conn) n++;
    return n;
  }

  get isFull() {
    return this.players.size >= this.cfg.maxPlayers;
  }

  addPlayer(name, avatar) {
    if (this.isFull) return null;
    const used = new Set([...this.players.values()].map((p) => p.slot));
    let slot = 0;
    while (used.has(slot)) slot++;

    // Keep display names unique inside a room ("Sam", "Sam 2", ...).
    const taken = new Set([...this.players.values()].map((p) => p.name.toLowerCase()));
    let finalName = sanitizeName(name);
    for (let n = 2; taken.has(finalName.toLowerCase()); n++) {
      finalName = `${sanitizeName(name).slice(0, 12)} ${n}`;
    }

    const token = newToken();
    const sp = this.spawnPoint(slot);
    const player = {
      id: this.nextId++,
      name: finalName,
      avatar: Number.isInteger(avatar) && avatar >= 0 && avatar < this.cfg.avatarCount ? avatar : 0,
      slot,
      tokenHash: hashToken(token),
      conn: null,
      body: Sim.newBody(sp.x, sp.y),
      queue: [],
      lastSeq: 0,
      ack: 0,
      lastIn: { x: 0, y: 0 },
      starved: 0,
      score: 0,
      invuln: 0,
      lastEmote: 0,
      discAt: null,
    };
    this.players.set(player.id, player);
    if (this.hostId === null) this.hostId = player.id;
    this.rosterDirty = true;
    return { player, token };
  }

  findByToken(token) {
    for (const p of this.players.values()) if (tokenMatches(token, p.tokenHash)) return p;
    return null;
  }

  attach(player, conn) {
    if (player.conn && player.conn !== conn) {
      player.conn.kick('replaced');
    }
    player.conn = conn;
    player.discAt = null;
    this.emptySince = null;
    this.rosterDirty = true;
  }

  detach(player, conn) {
    if (player.conn !== conn) return;
    player.conn = null;
    player.discAt = Date.now();
    player.queue.length = 0;
    this.rosterDirty = true;
    this.ensureHost();
  }

  removePlayer(id) {
    const p = this.players.get(id);
    if (!p) return;
    this.players.delete(id);
    this.rosterDirty = true;
    if (this.hostId === id) {
      this.hostId = null;
      this.ensureHost();
    }
    if (this.players.size === 0) this.emptySince = Date.now();
  }

  ensureHost() {
    const host = this.players.get(this.hostId);
    if (host && host.conn) return;
    let next = null;
    for (const p of this.players.values()) {
      if (p.conn) { next = p; break; }
    }
    const newId = next ? next.id : (host ? host.id : null);
    if (newId !== this.hostId) {
      this.hostId = newId;
      this.rosterDirty = true;
    }
  }

  // ---------- client messages ----------

  handleInput(player, msg) {
    const s = msg.s;
    if (!Number.isInteger(s) || s <= player.lastSeq || s > 0x7fffffff) return;
    player.lastSeq = s;
    if (this.phase === 'countdown') {
      player.ack = s;
      return;
    }
    const clamp = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(-1, Math.min(1, v)) : 0);
    player.queue.push({ s, x: clamp(msg.x), y: clamp(msg.y), dash: msg.d === 1 || msg.d === true });
    // Never let a client build up a backlog: that would be a speed hack.
    while (player.queue.length > this.cfg.maxInputQueue) player.queue.shift();
  }

  handleStart(player) {
    if (player.id !== this.hostId) return;
    if (this.phase !== 'lobby' && this.phase !== 'results') return;
    this.beginCountdown();
  }

  handleEmote(player, id) {
    if (!Number.isInteger(id) || id < 0 || id >= this.cfg.emoteCount) return;
    const now = Date.now();
    if (now - player.lastEmote < 1200) return;
    player.lastEmote = now;
    this.events.push(['e', player.id, id]);
  }

  handleKick(player, targetId) {
    if (player.id !== this.hostId || !Number.isInteger(targetId) || targetId === player.id) return;
    const target = this.players.get(targetId);
    if (!target) return;
    if (target.conn) target.conn.kick('kicked');
    this.removePlayer(targetId);
  }

  // ---------- game flow ----------

  spawnPoint(slot) {
    const a = (slot / this.cfg.maxPlayers) * Math.PI * 2 + 0.4;
    return { x: CENTER_X + Math.cos(a) * 300, y: CENTER_Y + Math.sin(a) * 300 };
  }

  beginCountdown() {
    this.phase = 'countdown';
    this.phaseLeft = this.cfg.countdownSec;
    this.coins = [];
    this.coinTimer = 0;
    this.gemTimer = 8;
    for (const p of this.players.values()) {
      const sp = this.spawnPoint(p.slot);
      p.body = Sim.newBody(sp.x, sp.y);
      p.score = 0;
      p.invuln = 0;
      p.queue.length = 0;
      p.ack = p.lastSeq;
    }
    this.rosterDirty = true;
  }

  setPhase(phase, left) {
    this.phase = phase;
    this.phaseLeft = left;
    this.rosterDirty = true;
  }

  randomFreePoint(margin = 60) {
    for (let i = 0; i < 30; i++) {
      const x = margin + Math.random() * (C.W - margin * 2);
      const y = margin + Math.random() * (C.H - margin * 2);
      let ok = true;
      for (const o of C.OBSTACLES) {
        if (Math.hypot(x - o.x, y - o.y) < o.r + 30) { ok = false; break; }
      }
      if (ok) for (const c of this.coins) if (Math.hypot(x - c.x, y - c.y) < 45) { ok = false; break; }
      if (ok) return { x, y };
    }
    return { x: CENTER_X, y: 90 };
  }

  addCoin(x, y, type, age = 0) {
    this.coins.push({ id: this.nextCoinId++, x, y, type, age, ttl: type === 1 ? 10 : 0 });
  }

  /** Advance the room by one fixed tick. Returns false when the room should be deleted. */
  update(dt) {
    this.tick++;
    const now = Date.now();

    // Drop players that stayed disconnected too long.
    for (const p of [...this.players.values()]) {
      if (!p.conn && p.discAt && now - p.discAt > this.cfg.disconnectGraceSec * 1000) this.removePlayer(p.id);
    }
    if (this.players.size === 0) return now - (this.emptySince || now) < this.cfg.emptyRoomTtlSec * 1000;
    if (this.connectedCount === 0) {
      this.emptySince = this.emptySince || now;
      if (now - this.emptySince > this.cfg.emptyRoomTtlSec * 1000) return false;
    }

    // Phase timers.
    if (this.phase === 'countdown') {
      this.phaseLeft -= dt;
      if (this.phaseLeft <= 0) this.setPhase('playing', this.cfg.roundSec);
    } else if (this.phase === 'playing') {
      this.phaseLeft -= dt;
      if (this.phaseLeft <= 0) {
        this.coins = [];
        this.setPhase('results', 0);
      }
    }

    // Movement.
    if (this.phase !== 'countdown') {
      for (const p of this.players.values()) {
        let inp;
        const queued = p.conn ? p.queue.shift() : null;
        if (queued) {
          p.lastIn = { x: queued.x, y: queued.y };
          p.ack = queued.s;
          p.starved = 0;
          inp = queued;
        } else {
          // A backgrounded tab stops sending; don't let that player run on forever.
          if (++p.starved > 6) p.lastIn = { x: 0, y: 0 };
          inp = p.conn ? { x: p.lastIn.x, y: p.lastIn.y, dash: false } : { x: 0, y: 0, dash: false };
        }
        const wasDashing = p.body.dash > 0;
        Sim.step(p.body, inp, dt);
        if (!wasDashing && p.body.dash > 0) this.events.push(['d', p.id, round(p.body.x), round(p.body.y)]);
        if (p.invuln > 0) p.invuln = Math.max(0, p.invuln - dt);
      }
      this.resolvePlayerCollisions();
    }

    if (this.phase === 'playing') this.updateCoins(dt);
    this.ensureHost();
    return true;
  }

  resolvePlayerCollisions() {
    const list = [...this.players.values()].filter((p) => p.conn);
    const R2 = C.R * 2;
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i];
        const b = list[j];
        let dx = b.body.x - a.body.x;
        let dy = b.body.y - a.body.y;
        let d = Math.hypot(dx, dy);
        if (d >= R2) continue;
        if (d < 1e-6) { dx = 1; dy = 0; d = 1; } else { dx /= d; dy /= d; }

        // Soft separation.
        const push = (R2 - d) / 2;
        a.body.x -= dx * push; a.body.y -= dy * push;
        b.body.x += dx * push; b.body.y += dy * push;
        Sim.collide(a.body, C.R);
        Sim.collide(b.body, C.R);

        const aDash = a.body.dash > 0;
        const bDash = b.body.dash > 0;
        if (aDash && !bDash) this.dashHit(a, b, dx, dy);
        else if (bDash && !aDash) this.dashHit(b, a, -dx, -dy);
      }
    }
  }

  dashHit(attacker, victim, dx, dy) {
    if (victim.invuln > 0 || this.phase !== 'playing') return;
    victim.body.kx = dx * 520;
    victim.body.ky = dy * 520;
    victim.body.stun = 0.4;
    victim.body.dash = 0;
    victim.invuln = 1.1;
    attacker.body.dash = 0;
    attacker.body.kx = -dx * 140;
    attacker.body.ky = -dy * 140;

    const loss = Math.min(victim.score, 3);
    victim.score -= loss;
    for (let i = 0; i < loss; i++) {
      const ang = Math.random() * Math.PI * 2;
      const dist = 34 + Math.random() * 30;
      const pt = { x: victim.body.x + Math.cos(ang) * dist, y: victim.body.y + Math.sin(ang) * dist };
      Sim.collide(pt, 10);
      this.addCoin(pt.x, pt.y, 0, 0);
    }
    this.events.push(['h', victim.id, round(victim.body.x), round(victim.body.y), attacker.id, loss]);
  }

  updateCoins(dt) {
    // Spawning.
    const cap = Math.min(18, 6 + this.connectedCount * 2);
    this.coinTimer -= dt;
    if (this.coinTimer <= 0 && this.coins.filter((c) => c.type === 0).length < cap) {
      const pt = this.randomFreePoint();
      this.addCoin(pt.x, pt.y, 0);
      this.coinTimer = 0.45;
    }
    this.gemTimer -= dt;
    if (this.gemTimer <= 0) {
      const pt = this.randomFreePoint(90);
      this.addCoin(pt.x, pt.y, 1);
      this.gemTimer = 11 + Math.random() * 5;
    }

    // Aging and pickups.
    const pickR = C.R + 14;
    this.coins = this.coins.filter((coin) => {
      coin.age += dt;
      if (coin.ttl && coin.age > coin.ttl) return false;
      if (coin.age < 0.4) return true;
      for (const p of this.players.values()) {
        if (!p.conn || p.body.stun > 0) continue;
        if (Math.hypot(p.body.x - coin.x, p.body.y - coin.y) < pickR) {
          const value = coin.type === 1 ? 5 : 1;
          p.score += value;
          this.events.push(['c', p.id, round(coin.x), round(coin.y), value]);
          return false;
        }
      }
      return true;
    });
  }

  // ---------- outgoing ----------

  rosterMessage() {
    return {
      t: 'room',
      code: this.code,
      ph: this.phase,
      host: this.hostId,
      max: this.cfg.maxPlayers,
      players: [...this.players.values()].map((p) => ({
        id: p.id, n: p.name, a: p.avatar, s: p.slot, on: p.conn ? 1 : 0,
      })),
    };
  }

  broadcast() {
    if (this.connectedCount === 0) {
      this.events.length = 0;
      return;
    }
    if (this.rosterDirty) {
      this.rosterDirty = false;
      this.sendAll(this.rosterMessage());
    }
    const players = [];
    for (const p of this.players.values()) {
      const b = p.body;
      const flags = (b.dash > 0 ? 1 : 0) | (b.stun > 0 ? 2 : 0) | (p.invuln > 0 ? 4 : 0) | (p.conn ? 8 : 0);
      players.push([p.id, round(b.x), round(b.y), flags, p.score]);
    }
    const shared = {
      t: 's',
      k: this.tick,
      ph: this.phase,
      tl: Math.max(0, Math.round(this.phaseLeft * 10) / 10),
      p: players,
      c: this.coins.map((c) => [c.id, round(c.x), round(c.y), c.type]),
    };
    if (this.events.length) shared.e = this.events;
    for (const p of this.players.values()) {
      if (!p.conn) continue;
      const b = p.body;
      shared.me = [
        p.ack, round(b.x, 100), round(b.y, 100), round(b.kx, 100), round(b.ky, 100),
        round(b.stun, 1000), round(b.dash, 1000), round(b.dcd, 1000),
        round(b.lx, 1000), round(b.ly, 1000), round(b.ddx, 1000), round(b.ddy, 1000),
      ];
      p.conn.send(shared);
    }
    this.events = [];
  }

  sendAll(msg) {
    for (const p of this.players.values()) if (p.conn) p.conn.send(msg);
  }

  closeAll(reason) {
    for (const p of this.players.values()) if (p.conn) p.conn.kick(reason);
  }
}

function round(v, f = 10) {
  return Math.round(v * f) / f;
}

module.exports = { Room, DEFAULTS };
