# 🪙 Coin Scramble

A real-time multiplayer party game for you and your friends. One person creates a
room and shares the **6-character code** (or an invite link); everyone else joins
with it. Up to 8 players, works on desktop and phones.

**How to play:** run around the meadow grabbing coins (💎 gems are worth 5). **Dash**
into a rival to knock coins out of their pockets, and watch for the stun stars!
Most coins after 90 seconds wins.

| | Desktop | Phone / tablet |
|---|---|---|
| Move | `WASD` / arrow keys | on-screen joystick |
| Dash | `Space` / `Shift` | DASH button |
| Emotes | `1`–`6` | emote bar |

The cast is 12 hand-drawn cartoon characters from different backgrounds, ages and
abilities (hijab, turban, locs, afro, braids, glasses, a hearing aid, and more).
They're generated from small data specs in `public/js/avatars.js`, so adding more is easy.

## Run it

```bash
npm install
npm start          # http://localhost:3000
npm test           # 14 tests: rules, security, networking
```

Playing with friends over the internet needs the server reachable by them:

- **Quick test:** run a tunnel such as `npx localtunnel --port 3000` or
  `cloudflared tunnel --url http://localhost:3000` and send friends the https link.
- **Always-on hosting:** deploy anywhere that runs Node with WebSocket support
  (Render, Fly.io, Railway, a VPS). A `Dockerfile` and `render.yaml` are included.
  Static-only hosts (GitHub Pages, Netlify) will **not** work because the game needs this server.

### Configuration (environment variables)

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | Port to listen on |
| `TRUST_PROXY` | `0` | **Set to `1` when behind a reverse proxy** (Render, Fly, Railway, nginx…) so per-IP limits see each player's real IP. If you leave it `0` behind a proxy, all players share one IP and hit the limits. Never set it when exposed directly to the internet. |
| `ALLOWED_ORIGINS` | – | Extra allowed `Origin`s (comma-separated), only if your proxy rewrites the `Host` header |
| `MAX_ROOMS` | `300` | Cap on simultaneous rooms |

## How it works

- **Server-authoritative.** The server (`server/room.js`) runs the game at 30 ticks/s and
  is the only source of truth for positions, scores and coins. Clients only send
  *inputs* (direction + dash).
- **Smooth feel.** Your own character is predicted locally with the exact same movement
  code the server uses (`public/js/sim.js`) and reconciled against server state, so
  controls feel instant. Other players are interpolated ~100 ms in the past, so they
  glide instead of jittering. Disconnects auto-reconnect and resume your seat.

## Security

- **Join codes** are 6 characters from a 25-letter unambiguous alphabet, generated with
  `crypto.randomInt` (≈244 million combinations). Wrong guesses are rate-limited per IP,
  and repeated failures block that IP for 5 minutes.
- **Seat tokens**: reconnecting uses a random 192-bit token (stored only as a SHA-256 hash
  on the server, compared in constant time), so nobody can hijack another player's seat.
- **Anti-cheat:** the server clamps/validates every input, applies at most one input per
  tick (flooding the socket can't make you faster), and owns scoring.
- **WebSocket hardening:** `Origin` must match the site (blocks cross-site hijacking),
  512-byte message cap, per-connection token-bucket rate limit, JSON schema checks,
  per-IP connection and room-creation limits, global room/connection caps, heartbeat
  to drop dead sockets, and auth timeout for connections that never join.
- **Web hardening:** strict Content-Security-Policy (no inline script/style, no third-party
  requests), `nosniff`, no framing, no referrer, HSTS over https, GET/HEAD only,
  path-traversal-safe static serving with an extension allow-list.
- **No XSS surface:** player names are sanitised on the server (letters, numbers, spaces,
  `._-'`, 16 chars) and only ever rendered with `textContent` or canvas text.
- **Privacy:** no accounts, no cookies, no analytics, no database. Rooms live in memory and
  vanish when empty. Chat is replaced with preset emotes, so there's no free-text abuse.

Honest limits: the room code *is* the password, so only share it with people you trust.
The host can remove (kick) players. Names aren't profanity-filtered. For real
public-scale hosting, put it behind HTTPS (most hosts do this for you).

## Project layout

```
server/   index.js (boot) · app.js (HTTP + WebSocket + limits) · room.js (game rules) · security.js
public/   index.html · style.css · js/{sim,avatars,audio,game,app}.js
test/     server.test.js
```
