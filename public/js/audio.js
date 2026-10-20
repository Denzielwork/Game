/* Tiny synthesized sound effects (no asset files). */
const Sfx = (() => {
  let ctx = null;
  let muted = false;
  try { muted = localStorage.getItem('cs-muted') === '1'; } catch { /* storage unavailable */ }

  function ensure() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
    }
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    return ctx;
  }

  function tone(freq, dur, { type = 'sine', vol = 0.15, slide = 0, delay = 0 } = {}) {
    if (muted) return;
    const c = ensure();
    if (!c) return;
    const t = c.currentTime + delay;
    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (slide) osc.frequency.exponentialRampToValueAtTime(Math.max(30, freq + slide), t + dur);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(vol, t + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(gain).connect(c.destination);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  return {
    unlock: ensure,
    get muted() { return muted; },
    setMuted(v) {
      muted = !!v;
      try { localStorage.setItem('cs-muted', muted ? '1' : '0'); } catch { /* ignore */ }
    },
    coin() { tone(880, 0.09, { type: 'triangle', vol: 0.14 }); tone(1320, 0.14, { type: 'triangle', vol: 0.12, delay: 0.07 }); },
    gem() { [660, 880, 1100, 1760].forEach((f, i) => tone(f, 0.16, { type: 'triangle', vol: 0.13, delay: i * 0.065 })); },
    dash() { tone(420, 0.2, { type: 'sawtooth', vol: 0.05, slide: -300 }); },
    hit() { tone(160, 0.22, { type: 'square', vol: 0.12, slide: -110 }); },
    tick() { tone(520, 0.09, { type: 'square', vol: 0.07 }); },
    go() { tone(780, 0.3, { type: 'square', vol: 0.09 }); },
    pop() { tone(600, 0.08, { type: 'sine', vol: 0.1, slide: 400 }); },
    join() { tone(500, 0.08, { type: 'sine', vol: 0.09 }); tone(750, 0.1, { type: 'sine', vol: 0.09, delay: 0.08 }); },
    win() { [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.22, { type: 'triangle', vol: 0.13, delay: i * 0.12 })); },
  };
})();
