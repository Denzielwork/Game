/*
 * Game client: networking, client-side prediction, interpolation, rendering.
 *
 * - Own player: predicted locally with the shared Sim, reconciled against the
 *   server's authoritative state (replaying un-acknowledged inputs).
 * - Other players: rendered ~100ms in the past, interpolated between snapshots.
 */
const Game = (() => {
  const { C } = Sim;
  const TICK = C.TICK;
  const TICK_MS = TICK * 1000;
  const INTERP_TICKS = 3;
  const SLOT_COLORS = ['#ff595e', '#ffca3a', '#8ac926', '#1982c4', '#9b6bff', '#ff924c', '#00b3a4', '#f15bb5'];
  const EMOTES = ['👍', '😂', '😮', '🎉', '😎', '❤️'];
  const INK = '#2b2140';
  const reduceMotion = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;

  const cb = {};
  let canvas;
  let ctx;
  let ws = null;
  let S = fresh();
  let active = false;
  let bg = null;
  let bgScale = 0;
  let view = { cw: 0, ch: 0, dpr: 1, scale: 1, availH: 0, cy: 0 };
  const keys = new Set();
  const stick = { x: 0, y: 0 };
  let dashUntil = 0;
  let acc = 0;
  let lastTs = 0;
  let shake = 0;
  let pingTimer = null;
  const particles = [];
  const floaters = [];
  const bubbles = new Map();
  const anims = new Map();
  const coinSeen = new Map();
  const sprites = new Map();
  let lastCountdownSecond = -1;

  function fresh() {
    return {
      id: null, code: null, token: null, seq: 0,
      roster: new Map(), hostId: null, phase: 'lobby', tl: 0,
      snaps: [], latest: null, coins: [], clockBase: null,
      pred: null, prev: null, pending: [], offset: { x: 0, y: 0 },
      ping: 0, status: 'idle', leaving: false, noReconnect: false,
    };
  }

  // ------------------------------------------------------------------ network

  function wsUrl() {
    return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
  }

  function send(obj) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
  }

  function attempt(first) {
    return new Promise((resolve, reject) => {
      let done = false;
      const sock = new WebSocket(wsUrl());
      ws = sock;
      sock.onopen = () => sock.send(JSON.stringify(first));
      sock.onmessage = (ev) => {
        let m;
        try { m = JSON.parse(ev.data); } catch { return; }
        if (!done) {
          if (m.t === 'welcome') { done = true; resolve(m); }
          else if (m.t === 'err') { done = true; reject({ code: m.code, msg: m.msg }); sock.close(); return; }
        }
        if (sock === ws) onMessage(m);
      };
      sock.onclose = () => {
        if (!done) { done = true; reject({ code: 'network', msg: "Couldn't reach the game server. Is it running?" }); return; }
        if (sock === ws) onClosed();
      };
      sock.onerror = () => {};
    });
  }

  async function join(opts) {
    if (ws) { try { ws.close(); } catch { /* ignore */ } }
    S = fresh();
    const first = opts.mode === 'create'
      ? { t: 'create', n: opts.name, a: opts.avatar }
      : opts.mode === 'resume'
        ? { t: 'resume', code: opts.code, token: opts.token }
        : { t: 'join', code: opts.code, n: opts.name, a: opts.avatar };
    await attempt(first);
    setStatus('connected');
    startPing();
    return { code: S.code };
  }

  function startPing() {
    clearInterval(pingTimer);
    pingTimer = setInterval(() => send({ t: 'p', n: performance.now() }), 2000);
    send({ t: 'p', n: performance.now() });
  }

  function setStatus(st) {
    S.status = st;
    if (cb.onStatus) cb.onStatus(st);
  }

  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

  async function onClosed() {
    clearInterval(pingTimer);
    if (S.leaving || S.noReconnect) { setStatus('closed'); return; }
    setStatus('reconnecting');
    for (const d of [300, 700, 1200, 2000, 3000, 3000, 3000, 3000, 3000, 3000]) {
      await sleep(d);
      if (S.leaving || S.noReconnect) return;
      try {
        await attempt({ t: 'resume', code: S.code, token: S.token });
        setStatus('connected');
        startPing();
        return;
      } catch (e) {
        if (e.code === 'bad_session' || e.code === 'blocked') break;
      }
    }
    S.noReconnect = true;
    setStatus('closed');
    if (cb.onBye) cb.onBye('lost');
  }

  function onMessage(m) {
    switch (m.t) {
      case 'welcome':
        S.id = m.id; S.code = m.code; S.token = m.token;
        S.pred = null; S.prev = null; S.pending = []; S.snaps = []; S.clockBase = null;
        try { sessionStorage.setItem('cs-session', JSON.stringify({ code: m.code, token: m.token })); } catch { /* ignore */ }
        break;
      case 'room': {
        const before = S.roster.size;
        S.roster = new Map(m.players.map((p) => [p.id, p]));
        S.hostId = m.host;
        if (S.roster.size > before && before > 0) Sfx.join();
        setPhase(m.ph);
        if (cb.onRoster) cb.onRoster();
        break;
      }
      case 's': onSnapshot(m); break;
      case 'q':
        S.ping = Math.round(performance.now() - m.n);
        if (cb.onPing) cb.onPing(S.ping);
        break;
      case 'bye':
        S.noReconnect = true;
        try { sessionStorage.removeItem('cs-session'); } catch { /* ignore */ }
        if (cb.onBye) cb.onBye(m.reason);
        break;
      default:
    }
  }

  function setPhase(ph) {
    if (ph === S.phase) return;
    const old = S.phase;
    S.phase = ph;
    if (ph === 'countdown') {
      S.pending = [];
      lastCountdownSecond = -1;
      particles.length = 0;
      floaters.length = 0;
    }
    if (ph === 'results' && old === 'playing') {
      const scores = getScores();
      if (scores[0] && scores[0].id === S.id) Sfx.win();
    }
    if (cb.onPhase) cb.onPhase(ph, old);
  }

  function onSnapshot(m) {
    const now = performance.now();
    const sample = now - m.k * TICK_MS;
    if (S.clockBase === null || sample < S.clockBase) S.clockBase = sample;
    else S.clockBase += (sample - S.clockBase) * 0.01;

    const players = new Map();
    for (const p of m.p) players.set(p[0], { x: p[1], y: p[2], f: p[3], score: p[4] });
    const snap = { k: m.k, players };
    S.snaps.push(snap);
    if (S.snaps.length > 30) S.snaps.shift();
    S.latest = snap;
    S.coins = m.c;
    S.tl = m.tl;
    setPhase(m.ph);
    if (m.me) reconcile(m.me);
    if (m.e) for (const e of m.e) onEvent(e);

    if (S.phase === 'countdown') {
      const sec = Math.ceil(S.tl);
      if (sec !== lastCountdownSecond) {
        lastCountdownSecond = sec;
        if (sec > 0) Sfx.tick();
      }
    }
    if (cb.onTick) cb.onTick();
  }

  function reconcile(me) {
    const [ack, x, y, kx, ky, stun, dash, dcd, lx, ly, ddx, ddy] = me;
    const b = { x, y, kx, ky, stun, dash, dcd, lx, ly, ddx, ddy };
    while (S.pending.length && S.pending[0].s <= ack) S.pending.shift();
    if (S.phase !== 'countdown') for (const inp of S.pending) Sim.step(b, inp, TICK);

    if (S.pred) {
      const dx = S.pred.x - b.x;
      const dy = S.pred.y - b.y;
      if (Math.hypot(dx, dy) > 160) {
        S.offset.x = 0; S.offset.y = 0;
        S.prev = { x: b.x, y: b.y };
      } else {
        // Keep what is on screen continuous; the error fades out smoothly.
        S.offset.x += dx; S.offset.y += dy;
        S.prev.x += b.x - S.pred.x; S.prev.y += b.y - S.pred.y;
      }
    } else {
      S.prev = { x: b.x, y: b.y };
    }
    S.pred = b;
  }

  function onEvent(e) {
    const mine = (id) => id === S.id;
    switch (e[0]) {
      case 'c': {
        const [, id, x, y, v] = e;
        burst(x, y, v >= 5 ? '#7df9ff' : '#ffd23f', v >= 5 ? 18 : 8, 150);
        if (mine(id)) {
          floaters.push({ x, y: y - 20, text: `+${v}`, color: v >= 5 ? '#7df9ff' : '#ffe066', life: 0.9 });
          if (v >= 5) Sfx.gem(); else Sfx.coin();
        }
        break;
      }
      case 'h': {
        const [, victim, x, y, attacker, loss] = e;
        burst(x, y, '#ffffff', 14, 260);
        burst(x, y, '#ff6b6b', 8, 200);
        if (loss > 0) floaters.push({ x, y: y - 30, text: `-${loss}`, color: '#ff6b6b', life: 1.1 });
        if (!reduceMotion) shake = mine(victim) || mine(attacker) ? 14 : 6;
        Sfx.hit();
        break;
      }
      case 'd':
        burst(e[2], e[3], '#ffffff', 5, 90);
        if (mine(e[1])) Sfx.dash();
        break;
      case 'e':
        bubbles.set(e[1], { text: EMOTES[e[2]] || '👍', until: performance.now() + 2200 });
        Sfx.pop();
        break;
      default:
    }
  }

  // ------------------------------------------------------------------- input

  function readInput(now) {
    let x = 0;
    let y = 0;
    if (keys.has('ArrowLeft') || keys.has('KeyA')) x -= 1;
    if (keys.has('ArrowRight') || keys.has('KeyD')) x += 1;
    if (keys.has('ArrowUp') || keys.has('KeyW')) y -= 1;
    if (keys.has('ArrowDown') || keys.has('KeyS')) y += 1;
    if (x === 0 && y === 0) { x = stick.x; y = stick.y; }
    return { x, y, dash: now < dashUntil };
  }

  function pressDash() {
    dashUntil = performance.now() + 160;
  }

  function onKeyDown(e) {
    if (!active || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
    const code = e.code;
    if (/^(Arrow|Key[WASD])/.test(code)) { keys.add(code); e.preventDefault(); return; }
    if (code === 'Space' || code === 'ShiftLeft' || code === 'ShiftRight') {
      e.preventDefault();
      if (!e.repeat) pressDash();
      return;
    }
    const n = /^(Digit|Numpad)([1-6])$/.exec(code);
    if (n && !e.repeat) emote(Number(n[2]) - 1);
  }

  function onKeyUp(e) { keys.delete(e.code); }
  function clearInput() { keys.clear(); stick.x = 0; stick.y = 0; }

  function bindTouch(zone, knob, dashBtn) {
    let pid = null;
    let ox = 0;
    let oy = 0;
    const R = 56;
    const setKnob = (dx, dy) => { knob.style.transform = `translate(${dx}px, ${dy}px)`; };
    zone.addEventListener('pointerdown', (e) => {
      if (pid !== null) return;
      pid = e.pointerId; ox = e.clientX; oy = e.clientY;
      zone.setPointerCapture(pid);
      zone.classList.add('on');
      e.preventDefault();
    });
    zone.addEventListener('pointermove', (e) => {
      if (e.pointerId !== pid) return;
      let dx = e.clientX - ox;
      let dy = e.clientY - oy;
      const len = Math.hypot(dx, dy);
      if (len > R) { dx = (dx / len) * R; dy = (dy / len) * R; }
      stick.x = dx / R; stick.y = dy / R;
      if (Math.hypot(stick.x, stick.y) < 0.15) { stick.x = 0; stick.y = 0; }
      setKnob(dx, dy);
    });
    const end = (e) => {
      if (e.pointerId !== pid) return;
      pid = null; stick.x = 0; stick.y = 0; setKnob(0, 0);
      zone.classList.remove('on');
    };
    zone.addEventListener('pointerup', end);
    zone.addEventListener('pointercancel', end);
    dashBtn.addEventListener('pointerdown', (e) => { e.preventDefault(); pressDash(); });
  }

  function emote(i) { if (S.id !== null) send({ t: 'emote', id: i }); }

  // ------------------------------------------------------------- simulation

  function tick(now) {
    if (!S.pred || S.status !== 'connected') return;
    S.prev = { x: S.pred.x, y: S.pred.y };
    if (S.phase === 'countdown') { S.pending.length = 0; return; }
    const inp = readInput(now);
    S.seq++;
    inp.s = S.seq;
    Sim.step(S.pred, inp, TICK);
    if (S.pred.dash > 0) dashUntil = 0;
    S.pending.push(inp);
    if (S.pending.length > 90) S.pending.shift();
    send({ t: 'in', s: inp.s, x: Math.round(inp.x * 100) / 100, y: Math.round(inp.y * 100) / 100, d: inp.dash ? 1 : 0 });
  }

  // --------------------------------------------------------------- remote state

  function sampleRemote(id, rt) {
    const snaps = S.snaps;
    if (!snaps.length) return null;
    let a = null;
    let b = null;
    for (let i = snaps.length - 1; i >= 0; i--) {
      if (snaps[i].k <= rt) { a = snaps[i]; b = snaps[i + 1] || null; break; }
    }
    if (!a) a = snaps[0];
    const pa = a.players.get(id);
    if (!b) return pa || null;
    const pb = b.players.get(id);
    if (!pa) return pb || null;
    if (!pb) return pa;
    if (Math.hypot(pb.x - pa.x, pb.y - pa.y) > 250) return pb;
    const t = Math.max(0, Math.min(1, (rt - a.k) / (b.k - a.k)));
    return { x: pa.x + (pb.x - pa.x) * t, y: pa.y + (pb.y - pa.y) * t, f: pa.f, score: pb.score };
  }

  function getScores() {
    const list = [];
    for (const r of S.roster.values()) {
      const lp = S.latest && S.latest.players.get(r.id);
      list.push({ id: r.id, name: r.n, avatar: r.a, slot: r.s, on: !!r.on, score: lp ? lp.score : 0 });
    }
    list.sort((a, b) => b.score - a.score || a.id - b.id);
    return list;
  }

  // -------------------------------------------------------------- rendering

  function resize() {
    if (!canvas) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const cw = canvas.clientWidth;
    const ch = canvas.clientHeight;
    if (!cw || !ch) return;
    canvas.width = Math.round(cw * dpr);
    canvas.height = Math.round(ch * dpr);
    // Leave room for the HUD (top) and the emote bar (bottom, desktop only).
    const touchUi = document.body.classList.contains('touch-device');
    const padT = 56;
    const padB = touchUi ? 8 : 62;
    const availH = Math.max(100, ch - padT - padB);
    const fit = Math.min((cw - 16) / C.W, availH / C.H);
    // Narrow screens (phones in portrait): zoom in and follow the player.
    const scale = fit < 0.4 ? Math.min(cw / 600, availH / C.H) : fit;
    view = { cw, ch, dpr, scale, availH, cy: padT + availH / 2 };
    bg = null;
  }

  function mulberry(seed) {
    return () => {
      seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function buildBackground() {
    const px = Math.max(1, view.scale * view.dpr);
    const c = document.createElement('canvas');
    c.width = Math.ceil(C.W * px);
    c.height = Math.ceil(C.H * px);
    const g = c.getContext('2d');
    g.scale(px, px);
    // grass checkerboard
    const T = 80;
    for (let y = 0; y < C.H; y += T) {
      for (let x = 0; x < C.W; x += T) {
        g.fillStyle = ((x / T + y / T) & 1) ? '#84d673' : '#7acb69';
        g.fillRect(x, y, T, T);
      }
    }
    // decorations
    const rnd = mulberry(11);
    for (let i = 0; i < 90; i++) {
      const x = 20 + rnd() * (C.W - 40);
      const y = 20 + rnd() * (C.H - 40);
      if (C.OBSTACLES.some((o) => Math.hypot(x - o.x, y - o.y) < o.r + 26)) continue;
      if (rnd() < 0.55) {
        g.strokeStyle = '#5fb251'; g.lineWidth = 2.5; g.lineCap = 'round';
        g.beginPath(); g.moveTo(x - 5, y + 4); g.lineTo(x - 3, y - 4); g.moveTo(x, y + 4); g.lineTo(x, y - 6); g.moveTo(x + 5, y + 4); g.lineTo(x + 3, y - 4); g.stroke();
      } else {
        const col = ['#ffffff', '#ffe066', '#ff9eb5', '#c9a7ff'][Math.floor(rnd() * 4)];
        g.fillStyle = col;
        for (let k = 0; k < 5; k++) {
          const a = (k / 5) * Math.PI * 2;
          g.beginPath(); g.arc(x + Math.cos(a) * 4, y + Math.sin(a) * 4, 3, 0, Math.PI * 2); g.fill();
        }
        g.fillStyle = '#ff9f1c'; g.beginPath(); g.arc(x, y, 2.4, 0, Math.PI * 2); g.fill();
      }
    }
    // obstacles
    for (const o of C.OBSTACLES) {
      g.fillStyle = 'rgba(0,0,0,.16)';
      g.beginPath(); g.ellipse(o.x + 4, o.y + o.r * 0.25 + 8, o.r + 6, o.r * 0.9, 0, 0, Math.PI * 2); g.fill();
      if (o.kind === 'pond') {
        g.fillStyle = '#e8d8a8'; g.strokeStyle = INK; g.lineWidth = 4;
        g.beginPath(); g.arc(o.x, o.y, o.r + 8, 0, Math.PI * 2); g.fill(); g.stroke();
        g.fillStyle = '#58c4ff';
        g.beginPath(); g.arc(o.x, o.y, o.r, 0, Math.PI * 2); g.fill(); g.stroke();
        g.strokeStyle = 'rgba(255,255,255,.7)'; g.lineWidth = 3;
        g.beginPath(); g.arc(o.x, o.y, o.r * 0.62, 0.3, 2.2); g.stroke();
        g.beginPath(); g.arc(o.x, o.y, o.r * 0.38, 3.4, 5.2); g.stroke();
        g.fillStyle = '#3fae5a'; g.strokeStyle = INK; g.lineWidth = 2.5;
        g.beginPath(); g.arc(o.x + 26, o.y + 18, 13, 0.4, Math.PI * 2 - 0.4); g.lineTo(o.x + 26, o.y + 18); g.fill(); g.stroke();
        g.fillStyle = '#ff9eb5';
        g.beginPath(); g.arc(o.x + 26, o.y + 15, 4, 0, Math.PI * 2); g.fill();
      } else {
        const lobes = [[0, 0, 1], [-0.55, 0.2, 0.7], [0.55, 0.2, 0.7], [0, -0.45, 0.72], [0, 0.5, 0.7]];
        g.strokeStyle = INK; g.lineWidth = 4;
        for (const [dx, dy, s] of lobes) {
          g.fillStyle = '#2f9e57';
          g.beginPath(); g.arc(o.x + dx * o.r * 0.75, o.y + dy * o.r * 0.75, o.r * 0.62 * s + 6, 0, Math.PI * 2); g.fill(); g.stroke();
        }
        g.fillStyle = '#3cc16b';
        g.beginPath(); g.arc(o.x - 6, o.y - 8, o.r * 0.62, 0, Math.PI * 2); g.fill();
        g.fillStyle = '#ff6b8b';
        for (const [dx, dy] of [[-18, -10], [14, -18], [20, 12], [-8, 18]]) {
          g.beginPath(); g.arc(o.x + dx, o.y + dy, 4.5, 0, Math.PI * 2); g.fill();
        }
      }
    }
    // fence
    g.strokeStyle = INK; g.lineWidth = 12;
    g.strokeRect(0, 0, C.W, C.H);
    g.strokeStyle = '#b9824f'; g.lineWidth = 7;
    g.strokeRect(0, 0, C.W, C.H);
    bg = c;
    bgScale = px;
  }

  function spriteFor(i) {
    let s = sprites.get(i);
    if (!s) {
      s = { canvas: null };
      const img = Avatars.image(i);
      const build = () => {
        const c = document.createElement('canvas');
        c.width = 160; c.height = 160;
        c.getContext('2d').drawImage(img, 0, 0, 160, 160);
        s.canvas = c;
      };
      if (img.complete && img.naturalWidth) build();
      else img.addEventListener('load', build, { once: true });
      sprites.set(i, s);
    }
    return s.canvas;
  }

  function burst(x, y, color, n, speed) {
    if (reduceMotion) n = Math.ceil(n / 3);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const v = speed * (0.35 + Math.random() * 0.65);
      particles.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 0.5 + Math.random() * 0.3, max: 0.8, color, size: 2.5 + Math.random() * 3 });
    }
    if (particles.length > 400) particles.splice(0, particles.length - 400);
  }

  function roundRect(g, x, y, w, h, r) {
    g.beginPath();
    g.moveTo(x + r, y);
    g.arcTo(x + w, y, x + w, y + h, r);
    g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r);
    g.arcTo(x, y, x + w, y, r);
    g.closePath();
  }

  function drawCoin(g, c, t) {
    const [id, x, y, type] = c;
    if (!coinSeen.has(id)) coinSeen.set(id, t);
    const pop = Math.min(1, (t - coinSeen.get(id)) / 220);
    const s = 1 - Math.pow(1 - pop, 3);
    const bob = Math.sin(t / 220 + id) * 3;
    g.save();
    g.translate(x, y);
    g.fillStyle = 'rgba(0,0,0,.2)';
    g.beginPath(); g.ellipse(0, 12, 10 * s, 4 * s, 0, 0, Math.PI * 2); g.fill();
    g.translate(0, -4 + bob);
    g.scale(s, s);
    g.lineWidth = 3; g.strokeStyle = INK;
    if (type === 1) {
      const pulse = 1 + Math.sin(t / 130) * 0.07;
      g.scale(pulse, pulse);
      g.fillStyle = '#5ee7ff';
      g.beginPath(); g.moveTo(0, -17); g.lineTo(14, -4); g.lineTo(0, 16); g.lineTo(-14, -4); g.closePath(); g.fill(); g.stroke();
      g.fillStyle = '#c8f8ff';
      g.beginPath(); g.moveTo(0, -17); g.lineTo(-14, -4); g.lineTo(-3, -4); g.closePath(); g.fill();
      g.strokeStyle = 'rgba(43,33,64,.5)'; g.lineWidth = 1.5;
      g.beginPath(); g.moveTo(-14, -4); g.lineTo(14, -4); g.moveTo(0, -17); g.lineTo(-3, -4); g.lineTo(0, 16); g.stroke();
    } else {
      const squash = Math.abs(Math.cos(t / 380 + id));
      g.scale(0.35 + 0.65 * squash, 1);
      g.fillStyle = '#ffd23f';
      g.beginPath(); g.arc(0, 0, 11, 0, Math.PI * 2); g.fill(); g.stroke();
      g.strokeStyle = '#e29a00'; g.lineWidth = 2;
      g.beginPath(); g.arc(0, 0, 6.5, 0, Math.PI * 2); g.stroke();
      g.fillStyle = 'rgba(255,255,255,.8)';
      g.beginPath(); g.arc(-4, -4, 2.2, 0, Math.PI * 2); g.fill();
    }
    g.restore();
  }

  function drawPlayer(g, ent, t, dt) {
    const r = S.roster.get(ent.id);
    if (!r) return;
    let a = anims.get(ent.id);
    if (!a) { a = { lx: ent.x, ly: ent.y, speed: 0, phase: Math.random() * 6, vx: 0 }; anims.set(ent.id, a); }
    const vx = (ent.x - a.lx) / Math.max(dt, 0.001);
    const vy = (ent.y - a.ly) / Math.max(dt, 0.001);
    a.lx = ent.x; a.ly = ent.y;
    const sp = Math.min(500, Math.hypot(vx, vy));
    a.speed += (sp - a.speed) * Math.min(1, dt * 12);
    a.vx += (vx - a.vx) * Math.min(1, dt * 10);
    if (a.speed > 25) a.phase += dt * (8 + a.speed / 40);

    const dashing = !!(ent.f & 1);
    const stunned = !!(ent.f & 2);
    const invuln = !!(ent.f & 4);
    const online = !!(ent.f & 8);
    const color = SLOT_COLORS[r.s % SLOT_COLORS.length];
    const moving = Math.min(1, a.speed / 120);

    if (dashing && Math.random() < 0.7) burst(ent.x, ent.y + 10, 'rgba(255,255,255,.9)', 1, 40);

    g.save();
    g.globalAlpha = online ? (invuln && Math.floor(t / 90) % 2 ? 0.45 : 1) : 0.35;
    // shadow + team ring
    g.fillStyle = 'rgba(0,0,0,.22)';
    g.beginPath(); g.ellipse(ent.x, ent.y + 22, 24, 8, 0, 0, Math.PI * 2); g.fill();
    g.strokeStyle = color; g.lineWidth = 5;
    g.beginPath(); g.ellipse(ent.x, ent.y + 20, 25, 9, 0, 0, Math.PI * 2); g.stroke();
    g.strokeStyle = INK; g.lineWidth = 1.5;
    g.beginPath(); g.ellipse(ent.x, ent.y + 20, 28, 11.5, 0, 0, Math.PI * 2); g.stroke();

    // dash cooldown (own player)
    if (ent.id === S.id && S.pred && S.pred.dcd > 0) {
      const f = 1 - S.pred.dcd / C.DASH_CD;
      g.strokeStyle = 'rgba(255,255,255,.95)'; g.lineWidth = 3;
      g.beginPath(); g.ellipse(ent.x, ent.y + 20, 31, 13.5, 0, 0, Math.PI * 2 * f); g.stroke();
    }

    // body sprite with squash/stretch, lean and bounce
    const bounce = reduceMotion ? 0 : -Math.abs(Math.sin(a.phase)) * 5 * moving;
    const sx = 1 + (reduceMotion ? 0 : Math.sin(a.phase * 2) * 0.04 * moving) + (dashing ? 0.18 : 0);
    const sy = 1 - (reduceMotion ? 0 : Math.sin(a.phase * 2) * 0.04 * moving) - (dashing ? 0.12 : 0);
    const lean = Math.max(-0.28, Math.min(0.28, a.vx / 900)) + (stunned ? Math.sin(t / 60) * 0.18 : 0);
    g.translate(ent.x, ent.y - 8 + bounce);
    g.rotate(lean);
    g.scale(sx, sy);
    const spr = spriteFor(r.a);
    if (spr) g.drawImage(spr, -34, -38, 68, 68);
    else { g.fillStyle = '#ddd'; g.beginPath(); g.arc(0, 0, 24, 0, Math.PI * 2); g.fill(); }
    g.restore();

    // stun stars
    if (stunned) {
      g.save();
      g.fillStyle = '#ffe066'; g.strokeStyle = INK; g.lineWidth = 1.5;
      for (let i = 0; i < 3; i++) {
        const ang = t / 160 + i * 2.1;
        g.beginPath(); g.arc(ent.x + Math.cos(ang) * 22, ent.y - 44 + Math.sin(ang) * 6, 4.5, 0, Math.PI * 2); g.fill(); g.stroke();
      }
      g.restore();
    }

    // name tag
    g.save();
    g.font = '800 14px ui-rounded, "Segoe UI", system-ui, sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    const label = online ? r.n : `${r.n} …`;
    const w = g.measureText(label).width + 16;
    const ty = ent.y - 60;
    g.globalAlpha = online ? 1 : 0.6;
    g.fillStyle = 'rgba(255,255,255,.94)';
    roundRect(g, ent.x - w / 2, ty - 11, w, 22, 11); g.fill();
    g.strokeStyle = color; g.lineWidth = 3; g.stroke();
    g.fillStyle = INK;
    g.fillText(label, ent.x, ty + 1);
    if (ent.id === S.id) {
      g.fillStyle = color; g.strokeStyle = INK; g.lineWidth = 2;
      const bob = Math.sin(t / 200) * 2;
      g.beginPath(); g.moveTo(ent.x - 7, ty - 21 + bob); g.lineTo(ent.x + 7, ty - 21 + bob); g.lineTo(ent.x, ty - 13 + bob); g.closePath(); g.fill(); g.stroke();
    }
    g.restore();

    const bub = bubbles.get(ent.id);
    if (bub) {
      if (t > bub.until) bubbles.delete(ent.id);
      else {
        const age = bub.until - t;
        const pop = Math.min(1, (2200 - age) / 180);
        g.save();
        g.translate(ent.x + 30, ent.y - 84);
        g.scale(pop, pop);
        g.globalAlpha = Math.min(1, age / 300);
        g.fillStyle = '#fff'; g.strokeStyle = INK; g.lineWidth = 3;
        roundRect(g, -20, -20, 40, 36, 14); g.fill(); g.stroke();
        g.font = '24px system-ui, "Apple Color Emoji", "Segoe UI Emoji", sans-serif';
        g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillText(bub.text, 0, 0);
        g.restore();
      }
    }
  }

  function render(ts, dt) {
    const { cw, ch, dpr, scale } = view;
    if (!cw) return;
    const g = ctx;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = '#2b2140';
    g.fillRect(0, 0, canvas.width, canvas.height);
    if (!bg || Math.abs(bgScale - scale * dpr) > 0.001) buildBackground();

    // Collect entities at their render positions.
    const ents = [];
    const rt = S.clockBase === null ? 0 : (ts - S.clockBase) / TICK_MS - INTERP_TICKS;
    for (const r of S.roster.values()) {
      if (r.id === S.id && S.pred) continue;
      const p = sampleRemote(r.id, rt);
      if (p) ents.push({ id: r.id, x: p.x, y: p.y, f: p.f });
    }
    let me = null;
    if (S.pred && S.id !== null) {
      const alpha = Math.min(1, acc / TICK);
      const prev = S.prev || S.pred;
      const lp = S.latest && S.latest.players.get(S.id);
      const f = (S.pred.dash > 0 ? 1 : 0) | (S.pred.stun > 0 ? 2 : 0) | ((lp ? lp.f : 8) & 4) | 8;
      me = {
        id: S.id,
        x: prev.x + (S.pred.x - prev.x) * alpha + S.offset.x,
        y: prev.y + (S.pred.y - prev.y) * alpha + S.offset.y,
        f,
      };
      ents.push(me);
    }
    const decay = Math.exp(-dt * 11);
    S.offset.x *= decay; S.offset.y *= decay;

    // Camera.
    const vw = cw / scale;
    const vh = view.availH / scale;
    let camX = C.W / 2;
    let camY = C.H / 2;
    if (vw < C.W - 1 && me) camX = Math.max(vw / 2, Math.min(C.W - vw / 2, me.x));
    if (vh < C.H - 1 && me) camY = Math.max(vh / 2, Math.min(C.H - vh / 2, me.y));
    shake *= Math.exp(-dt * 9);
    const sx = shake > 0.3 ? (Math.random() - 0.5) * shake : 0;
    const sy = shake > 0.3 ? (Math.random() - 0.5) * shake : 0;
    g.setTransform(scale * dpr, 0, 0, scale * dpr, (cw / 2 - camX * scale + sx) * dpr, (view.cy - camY * scale + sy) * dpr);

    g.drawImage(bg, 0, 0, C.W, C.H);

    // Coins.
    const live = new Set();
    for (const c of S.coins) { live.add(c[0]); drawCoin(g, c, ts); }
    for (const id of coinSeen.keys()) if (!live.has(id)) coinSeen.delete(id);

    // Players, back to front.
    ents.sort((a, b) => a.y - b.y);
    for (const e of ents) drawPlayer(g, e, ts, dt);

    // Particles and floating text.
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.life -= dt;
      if (p.life <= 0) { particles.splice(i, 1); continue; }
      p.x += p.vx * dt; p.y += p.vy * dt;
      p.vx *= 0.92; p.vy *= 0.92;
      g.globalAlpha = Math.max(0, p.life / p.max);
      g.fillStyle = p.color;
      g.beginPath(); g.arc(p.x, p.y, p.size * g.globalAlpha + 0.5, 0, Math.PI * 2); g.fill();
    }
    g.globalAlpha = 1;
    g.font = '900 24px ui-rounded, "Segoe UI", system-ui, sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.lineWidth = 5; g.strokeStyle = INK; g.lineJoin = 'round';
    for (let i = floaters.length - 1; i >= 0; i--) {
      const f = floaters[i];
      f.life -= dt; f.y -= 46 * dt;
      if (f.life <= 0) { floaters.splice(i, 1); continue; }
      g.globalAlpha = Math.min(1, f.life * 2.5);
      g.strokeText(f.text, f.x, f.y);
      g.fillStyle = f.color;
      g.fillText(f.text, f.x, f.y);
    }
    g.globalAlpha = 1;
  }

  function frame(ts) {
    requestAnimationFrame(frame);
    const dt = Math.min(0.1, (ts - (lastTs || ts)) / 1000);
    lastTs = ts;
    if (!active) return;
    acc += dt;
    let guard = 0;
    while (acc >= TICK && guard++ < 6) { tick(ts); acc -= TICK; }
    if (guard >= 6) acc = 0;
    render(ts, dt);
  }

  // ------------------------------------------------------------------- API

  function init(canvasEl, callbacks) {
    canvas = canvasEl;
    ctx = canvas.getContext('2d', { alpha: false });
    Object.assign(cb, callbacks);
    window.addEventListener('resize', resize);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', clearInput);
    document.addEventListener('visibilitychange', () => { if (document.hidden) clearInput(); });
    requestAnimationFrame(frame);
  }

  function setActive(v) {
    active = v;
    if (v) { lastTs = 0; acc = 0; requestAnimationFrame(resize); }
    else clearInput();
  }

  function leave() {
    S.leaving = true;
    clearInterval(pingTimer);
    send({ t: 'leave' });
    try { sessionStorage.removeItem('cs-session'); } catch { /* ignore */ }
    const sock = ws;
    setTimeout(() => { try { sock.close(); } catch { /* ignore */ } }, 150);
    ws = null;
  }

  return {
    init, join, leave, setActive, bindTouch, resize,
    start: () => send({ t: 'start' }),
    kick: (id) => send({ t: 'kick', id }),
    emote, dash: pressDash, getScores,
    get state() { return S; },
    get cooldown() { return S.pred ? Math.max(0, S.pred.dcd) / C.DASH_CD : 0; },
    EMOTES, SLOT_COLORS,
  };
})();
