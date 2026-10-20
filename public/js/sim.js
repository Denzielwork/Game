/*
 * Shared movement simulation.
 * Loaded by the browser (global `Sim`) and by the Node server (require).
 * The server is authoritative; the client runs the exact same step() to
 * predict its own player so controls feel instant.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Sim = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const C = Object.freeze({
    W: 1280,
    H: 720,
    R: 22, // player radius
    TICK: 1 / 30, // seconds per simulation tick
    SPEED: 230,
    DASH_SPEED: 640,
    DASH_TIME: 0.18,
    DASH_CD: 1.4,
    KNOCK_DECAY: 7,
    OBSTACLES: Object.freeze([
      Object.freeze({ x: 640, y: 360, r: 72, kind: 'pond' }),
      Object.freeze({ x: 280, y: 190, r: 46, kind: 'bush' }),
      Object.freeze({ x: 1000, y: 190, r: 46, kind: 'bush' }),
      Object.freeze({ x: 280, y: 530, r: 46, kind: 'bush' }),
      Object.freeze({ x: 1000, y: 530, r: 46, kind: 'bush' }),
    ]),
  });

  function newBody(x, y) {
    return { x, y, kx: 0, ky: 0, stun: 0, dash: 0, dcd: 0, lx: 1, ly: 0, ddx: 0, ddy: 0 };
  }

  function copyBody(b) {
    return {
      x: b.x, y: b.y, kx: b.kx, ky: b.ky, stun: b.stun, dash: b.dash, dcd: b.dcd,
      lx: b.lx, ly: b.ly, ddx: b.ddx, ddy: b.ddy,
    };
  }

  // Push a circle of radius `r` out of walls and obstacles.
  function collide(b, r) {
    if (b.x < r) b.x = r;
    else if (b.x > C.W - r) b.x = C.W - r;
    if (b.y < r) b.y = r;
    else if (b.y > C.H - r) b.y = C.H - r;
    for (const o of C.OBSTACLES) {
      let dx = b.x - o.x;
      let dy = b.y - o.y;
      const min = o.r + r;
      const d2 = dx * dx + dy * dy;
      if (d2 < min * min) {
        const d = Math.sqrt(d2);
        if (d < 1e-6) { dx = 0; dy = -1; } else { dx /= d; dy /= d; }
        b.x = o.x + dx * min;
        b.y = o.y + dy * min;
      }
    }
  }

  /**
   * Advance one body by dt seconds.
   * inp = { x, y, dash } where x,y are in [-1, 1] and dash is a boolean press.
   */
  function step(b, inp, dt) {
    let ix = inp.x;
    let iy = inp.y;
    const len = Math.hypot(ix, iy);
    if (len > 1) { ix /= len; iy /= len; }

    if (b.stun > 0) {
      b.stun = Math.max(0, b.stun - dt);
      ix = 0; iy = 0;
    } else {
      if (len > 0.05) {
        b.lx = ix / Math.max(len, 1e-6);
        b.ly = iy / Math.max(len, 1e-6);
      }
      if (inp.dash && b.dcd <= 0 && b.dash <= 0) {
        b.dash = C.DASH_TIME;
        b.dcd = C.DASH_CD;
        b.ddx = b.lx;
        b.ddy = b.ly;
      }
    }
    if (b.dcd > 0) b.dcd = Math.max(0, b.dcd - dt);

    let vx;
    let vy;
    if (b.dash > 0) {
      vx = b.ddx * C.DASH_SPEED;
      vy = b.ddy * C.DASH_SPEED;
      b.dash = Math.max(0, b.dash - dt);
    } else {
      vx = ix * C.SPEED;
      vy = iy * C.SPEED;
    }
    vx += b.kx;
    vy += b.ky;
    const decay = Math.exp(-C.KNOCK_DECAY * dt);
    b.kx *= decay;
    b.ky *= decay;
    if (Math.abs(b.kx) < 1) b.kx = 0;
    if (Math.abs(b.ky) < 1) b.ky = 0;

    b.x += vx * dt;
    b.y += vy * dt;
    collide(b, C.R);
  }

  return { C, newBody, copyBody, step, collide };
});
