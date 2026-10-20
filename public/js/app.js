/* UI glue: landing screen, lobby, scoreboard, results. All text is set with textContent. */
(() => {
  const $ = (sel) => document.querySelector(sel);
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
  };
  const CODE_RE = /^[A-Z0-9]{6}$/;

  let avatar = Math.min(Avatars.count - 1, Math.max(0, parseInt(store.get('cs-avatar') || '', 10) || 0));
  let busy = false;
  let toastTimer = null;
  let boardSig = '';

  // ---------------------------------------------------------------- landing

  const nameInput = $('#name');
  const codeInput = $('#code');
  nameInput.value = store.get('cs-name') || '';

  const grid = $('#avatar-grid');
  Avatars.LIST.forEach((a, i) => {
    const b = el('button', 'avatar-opt');
    b.type = 'button';
    b.setAttribute('role', 'radio');
    const img = el('img');
    img.src = Avatars.url(i);
    img.alt = '';
    img.draggable = false;
    b.append(img, el('span', '', a.name));
    b.setAttribute('aria-label', a.name);
    b.addEventListener('click', () => selectAvatar(i));
    grid.append(b);
  });
  function selectAvatar(i) {
    avatar = i;
    store.set('cs-avatar', String(i));
    [...grid.children].forEach((b, j) => b.setAttribute('aria-checked', j === i ? 'true' : 'false'));
  }
  selectAvatar(avatar);

  function profile() {
    const name = nameInput.value.trim() || Avatars.LIST[avatar].name;
    store.set('cs-name', nameInput.value.trim());
    return { name, avatar };
  }

  function showError(msg) { $('#landing-error').textContent = msg || ''; }

  function setBusy(v) {
    busy = v;
    $('#btn-create').disabled = v;
    $('#btn-join').disabled = v;
  }

  async function enter(opts) {
    if (busy) return;
    showError('');
    setBusy(true);
    Sfx.unlock();
    try {
      await Game.join(opts);
      showGame();
    } catch (e) {
      showError((e && e.msg) || 'Something went wrong. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  $('#btn-create').addEventListener('click', () => enter({ mode: 'create', ...profile() }));
  function tryJoin() {
    const code = codeInput.value.toUpperCase().replace(/[\s-]/g, '');
    if (!CODE_RE.test(code)) return showError('Room codes are 6 letters or numbers.');
    enter({ mode: 'join', code, ...profile() });
  }
  $('#btn-join').addEventListener('click', tryJoin);
  codeInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') tryJoin(); });
  nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { if (CODE_RE.test(codeInput.value.toUpperCase())) tryJoin(); else codeInput.focus(); }
  });
  codeInput.addEventListener('input', () => { codeInput.value = codeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6); });

  // Invite link: /?code=ABC123 pre-fills the code.
  const invite = new URLSearchParams(location.search).get('code');
  if (invite) {
    codeInput.value = invite.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
    if (history.replaceState) history.replaceState(null, '', location.pathname);
    nameInput.focus();
  }

  // ------------------------------------------------------------------- game

  const touch = window.matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;
  if (touch) document.body.classList.add('touch-device');

  Game.init($('#stage'), {
    onRoster: () => { renderRoster(); renderBoard(true); applyPhase(Game.state.phase); },
    onPhase: (ph, old) => {
      applyPhase(ph);
      if (ph === 'playing') flashGo();
      if (ph === 'results') renderResults();
      if (old === 'results' || ph === 'countdown') boardSig = '';
    },
    onTick: onTick,
    onStatus: (st) => {
      const b = $('#banner');
      b.textContent = 'Connection lost. Reconnecting…';
      b.classList.toggle('hidden', st !== 'reconnecting');
    },
    onPing: (ms) => {
      const p = $('#ping');
      p.textContent = `${ms} ms`;
      p.classList.toggle('bad', ms > 150);
    },
    onBye: (reason) => {
      const msg = {
        kicked: 'The host removed you from the room.',
        replaced: 'You joined from another tab, so this one was closed.',
        closed: 'That room has closed.',
        lost: 'Connection lost. Please rejoin.',
      }[reason] || 'You left the room.';
      backToLanding(msg);
    },
  });
  Game.bindTouch($('#stick'), $('#knob'), $('#btn-dash'));

  const emoteBar = $('#emotes');
  Game.EMOTES.forEach((emo, i) => {
    const b = el('button', '', emo);
    b.type = 'button';
    b.setAttribute('aria-label', `Emote ${i + 1}`);
    b.addEventListener('click', () => Game.emote(i));
    emoteBar.append(b);
  });

  function showGame() {
    $('#landing').classList.add('hidden');
    $('#game').classList.remove('hidden');
    $('#room-code').textContent = Game.state.code;
    $('#lobby-code').textContent = Game.state.code;
    Game.setActive(true);
    renderRoster();
    renderBoard(true);
    applyPhase(Game.state.phase);
    document.title = `Coin Scramble · ${Game.state.code}`;
  }

  function backToLanding(msg) {
    Game.setActive(false);
    $('#game').classList.add('hidden');
    $('#landing').classList.remove('hidden');
    document.title = 'Coin Scramble';
    showError(msg || '');
    ['#lobby', '#results', '#countdown', '#board', '#banner'].forEach((s) => $(s).classList.add('hidden'));
  }

  $('#btn-leave').addEventListener('click', () => {
    Game.leave();
    backToLanding('');
  });

  $('#btn-sound').addEventListener('click', () => {
    Sfx.setMuted(!Sfx.muted);
    syncSound();
  });
  function syncSound() {
    $('#btn-sound').textContent = Sfx.muted ? '🔇' : '🔊';
    $('#btn-sound').setAttribute('aria-pressed', String(Sfx.muted));
  }
  syncSound();

  // Invite / copy
  async function copyInvite() {
    const url = `${location.origin}/?code=${Game.state.code}`;
    try {
      if (navigator.share && touch) {
        await navigator.share({ title: 'Coin Scramble', text: `Join my Coin Scramble room: ${Game.state.code}`, url });
        return;
      }
      await navigator.clipboard.writeText(url);
      toast('Invite link copied!');
      $('#copy-note').textContent = 'Invite link copied. Send it to your friends!';
    } catch {
      toast(`Room code: ${Game.state.code}`);
    }
  }
  $('#room-chip').addEventListener('click', copyInvite);
  $('#lobby-code').addEventListener('click', copyInvite);

  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.add('hidden'), 2200);
  }

  $('#btn-start').addEventListener('click', () => { Sfx.unlock(); Game.start(); });
  $('#btn-again').addEventListener('click', () => { Sfx.unlock(); Game.start(); });

  // ---------------------------------------------------------- phase + panels

  function isHost() { const s = Game.state; return s.id !== null && s.id === s.hostId; }
  function hostName() {
    const s = Game.state;
    const h = s.roster.get(s.hostId);
    return h ? h.n : 'the host';
  }

  function applyPhase(ph) {
    const lobby = $('#lobby');
    lobby.classList.toggle('hidden', ph !== 'lobby');
    $('#results').classList.toggle('hidden', ph !== 'results');
    $('#board').classList.toggle('hidden', ph === 'lobby');
    if (ph !== 'countdown' && !goTimer) $('#countdown').classList.add('hidden');

    const host = isHost();
    $('#btn-start').classList.toggle('hidden', !host);
    $('#lobby-note').textContent = host
      ? (Game.state.roster.size < 2 ? 'Waiting for friends… you can also start solo to practise.' : 'Everyone here? Hit start!')
      : `Waiting for ${hostName()} to start…`;
    $('#btn-again').classList.toggle('hidden', !host);
    $('#results-note').textContent = host ? '' : `Waiting for ${hostName()} to start the next round…`;
    if (ph === 'results') renderResults();
    onTick();
  }

  function renderRoster() {
    const s = Game.state;
    const ul = $('#roster');
    ul.replaceChildren();
    for (const p of s.roster.values()) {
      const li = el('li', p.on ? '' : 'off');
      li.style.setProperty('--slot', Game.SLOT_COLORS[p.s % Game.SLOT_COLORS.length]);
      const img = el('img');
      img.src = Avatars.url(p.a); img.alt = '';
      li.append(img, el('span', '', p.id === s.id ? `${p.n} (you)` : p.n));
      if (p.id === s.hostId) { const c = el('span', 'crown', '👑'); c.title = 'Host'; li.append(c); }
      if (isHost() && p.id !== s.id) {
        const k = el('button', 'kick', '✕');
        k.type = 'button';
        k.setAttribute('aria-label', `Remove ${p.n}`);
        k.addEventListener('click', () => Game.kick(p.id));
        li.append(k);
      }
      ul.append(li);
    }
  }

  function renderBoard(force) {
    const list = Game.getScores();
    const sig = list.map((p) => `${p.id}:${p.score}:${p.on}`).join('|') + Game.state.id;
    if (!force && sig === boardSig) return;
    boardSig = sig;
    const ol = $('#board');
    ol.replaceChildren();
    for (const p of list) {
      const li = el('li', `${p.id === Game.state.id ? 'me' : ''} ${p.on ? '' : 'off'}`.trim());
      li.style.setProperty('--slot', Game.SLOT_COLORS[p.slot % Game.SLOT_COLORS.length]);
      const img = el('img'); img.src = Avatars.url(p.avatar); img.alt = '';
      li.append(img, el('span', 'nm', p.name), el('span', 'sc', String(p.score)));
      ol.append(li);
    }
  }

  let goTimer = null;
  function flashGo() {
    const c = $('#countdown');
    c.replaceChildren(el('span', '', 'GO!'));
    c.classList.remove('hidden'); c.classList.add('pop');
    Sfx.go();
    clearTimeout(goTimer);
    goTimer = setTimeout(() => { goTimer = null; if (Game.state.phase !== 'countdown') c.classList.add('hidden'); }, 800);
  }

  let lastCountNum = null;
  function onTick() {
    const s = Game.state;
    const timer = $('#timer');
    if (s.phase === 'playing') {
      const t = Math.max(0, Math.ceil(s.tl));
      timer.textContent = `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
      timer.classList.toggle('low', t <= 10);
    } else {
      timer.classList.remove('low');
      timer.textContent = { lobby: 'Lobby', countdown: 'Get ready!', results: "Time's up!" }[s.phase] || '';
    }
    if (s.phase === 'countdown') {
      const n = Math.max(1, Math.ceil(s.tl));
      const c = $('#countdown');
      c.classList.remove('hidden');
      if (n !== lastCountNum) {
        lastCountNum = n;
        c.replaceChildren(el('span', '', String(n)));
        c.classList.remove('pop'); void c.offsetWidth; c.classList.add('pop');
      }
    } else lastCountNum = null;
    if (s.phase !== 'lobby') renderBoard(false);
  }

  function renderResults() {
    const list = Game.getScores();
    const ol = $('#results-list');
    ol.replaceChildren();
    const top = list.length ? list[0].score : 0;
    const winners = list.filter((p) => p.score === top);
    const title = $('#results-title');
    if (!list.length) title.textContent = 'Results';
    else if (winners.length > 1 && top > 0) title.textContent = `It's a tie! 🤝`;
    else title.textContent = `${list[0].name} wins! 🎉`;
    const medals = ['🥇', '🥈', '🥉'];
    list.forEach((p, i) => {
      const li = el('li', p.score === top && top > 0 ? 'first' : '');
      const img = el('img'); img.src = Avatars.url(p.avatar); img.alt = '';
      li.append(el('span', 'rank', medals[i] || String(i + 1)), img,
        el('span', '', p.id === Game.state.id ? `${p.name} (you)` : p.name), el('span', 'sc', String(p.score)));
      ol.append(li);
    });
  }

  // Dash button cooldown ring (touch).
  (function cooldownLoop() {
    const b = $('#btn-dash');
    if (document.body.classList.contains('touch-device')) b.style.setProperty('--cd', String(Game.cooldown));
    requestAnimationFrame(cooldownLoop);
  })();

  // ------------------------------------------------------- resume on refresh

  (async function tryResume() {
    let saved = null;
    try { saved = JSON.parse(sessionStorage.getItem('cs-session') || 'null'); } catch { /* ignore */ }
    if (!saved || !saved.code || !saved.token) return;
    setBusy(true);
    try {
      await Game.join({ mode: 'resume', code: saved.code, token: saved.token });
      showGame();
    } catch {
      try { sessionStorage.removeItem('cs-session'); } catch { /* ignore */ }
    } finally {
      setBusy(false);
    }
  })();
})();
