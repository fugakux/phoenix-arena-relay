# Relay protocol (version 1)

JSON text messages over `wss://<host>/ws`. Browsers must send an `Origin` of the deployed range
(`ALLOWED_ORIGINS`, default `https://phoenix-ascent-arena.vercel.app`) or a `localhost` / `127.0.0.1` page.
`GET /health` answers `ok`; `GET /` answers a JSON status (`online`, `queued`, `rooms`, `matches`).

Clients are trusted: each browser runs its own movement and shooting, reports its own hits on the opponent and its own
deaths. The relay only pairs players, forwards messages and keeps the score. It is meant for testing with friends, not
for matches between strangers who might cheat.

## Client to server

| Message | Meaning |
|---|---|
| `{t:'hello', v:1, name, agent}` | Display name (16 chars, letters/digits/space/.-) and agent (`Phoenix` or `Clay`). |
| `{t:'queue', code?}` | Join the public queue, or wait for the player who sends the same room code (up to 8 letters/digits). |
| `{t:'leave'}` | Leave the queue or end the current match (the opponent gets `end` with reason `left`). |
| `{t:'s', c, x, y, z, vx, vy, vz, yw, p, cr, g, a, hp, ar, w, n, ag}` | Own state, about 30 per second, forwarded as sent. `c` sender clock (s), position (m), velocity (m/s), yaw / pitch (rad), crouch 0-1, grounded, alive, health, armor, weapon, shot counter, agent. |
| `{t:'hit', dmg, region, w}` | Own shot or knife hit on the opponent. `dmg` 0-1000; `region` `head` / `body` / `legs`. |
| `{t:'dead', by}` | Own death. `by: 'foe'` scores a kill for the opponent; `'self'` (falls, kill volumes) does not. |
| `{t:'ev', ...}` | Reserved for ability events (forwarded as sent). |
| `{t:'ping', c}` | Answered with `{t:'pong', c, s}`. |

## Server to client

| Message | Meaning |
|---|---|
| `{t:'welcome', id, protocol, online}` | Connection accepted. |
| `{t:'queued', position?, code?}` | Waiting in the public queue or for a room code. |
| `{t:'match', room, side, foe:{id, name, agent}, firstTo, seed}` | Paired. `side` is `attack` for the first queued player, `defend` for the second. |
| `{t:'s', ...}` / `{t:'hit', ...}` | The opponent's state / their hit on you. |
| `{t:'kill'}` | Your opponent reported a death caused by you. |
| `{t:'score', you, foe}` | Score after every death. |
| `{t:'end', reason, winner, you, foe}` | `score` (first to `firstTo`), `left`, `disconnect` or `server-restart`. |
| `{t:'error', code}` | `protocol` when the client speaks another version. |

## Limits

4 KB per message, 150 messages per second per socket (sockets that keep flooding are closed with 1008),
200 sockets, a ping every 15 s (a socket that misses a pong is dropped).
