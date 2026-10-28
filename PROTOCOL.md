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
| `{t:'hello', v:1, name, agent, skin?}` | Display name (16 chars, letters/digits/space/.-), agent (`Phoenix` or `Clay`) and Vandal skin (`standard` or a skin asset path). |
| `{t:'queue', code?, name?, agent?, skin?}` | Join the public queue, or wait for the player who sends the same room code (up to 8 letters/digits). Name, agent and skin replace the hello values, so the opponent is told the agent actually played. |
| `{t:'leave'}` | Leave the queue or end the current match (the opponent gets `end` with reason `left`). |
| `{t:'s', c, x, y, z, vx, vy, vz, yw, p, cr, g, a, hp, ar, w, n, tr, ag}` | Own state, about 30 per second, forwarded as sent. `c` sender clock (s), position (m), velocity (m/s), yaw / pitch (rad), crouch 0-1, grounded, alive, health, armor, weapon, shot counter, fire held, agent, `pg` own ping (ms, for the scoreboard). |
| `{t:'hit', dmg, region, w}` | Own shot or knife hit on the opponent. `dmg` 0-1000; `region` `head` / `body` / `legs`. |
| `{t:'dead', by}` | Own death. `by: 'foe'` scores a kill for the opponent; `'self'` (falls, kill volumes) does not. |
| `{t:'ev', c, k, ...}` | Ability input or actor command, forwarded as sent; `c` is the sender clock. See below. |
| `{t:'ping', c}` | Answered with `{t:'pong', c, s}`. |

## Server to client

| Message | Meaning |
|---|---|
| `{t:'welcome', id, protocol, online}` | Connection accepted. |
| `{t:'queued', position?, code?}` | Waiting in the public queue or for a room code. |
| `{t:'match', room, side, you:{id, name, agent, skin}, foe:{id, name, agent, skin}, firstTo, timeLimit, seed}` | Paired. `side` is `attack` for the first queued player, `defend` for the second. `firstTo` kills (default 30) and `timeLimit` seconds (default 600). |
| `{t:'s', ...}` / `{t:'hit', ...}` | The opponent's state / their hit on you. |
| `{t:'kill'}` | Your opponent reported a death caused by you. |
| `{t:'score', you, foe, deaths:{you, foe}, left}` | Kills, deaths and seconds left after every death. |
| `{t:'end', reason, winner, you, foe, deaths}` | `score` (first to `firstTo`), `time` (after `timeLimit`; the higher score wins, `winner` null on a tie), `left`, `disconnect` or `server-restart`. |
| `{t:'error', code}` | `protocol` when the client speaks another version. |

## Abilities (`ev`)

The range replays each player's abilities on the opponent's screen with a second copy of the same decoded controller
(Phoenix or Raze), fed these inputs at the sender-clock time the opponent's body is drawn at. That copy's only target is
the receiving player, so ability damage, burns, Blast Pack knockback and the Curveball blind are decided by the player
they land on. The state message's `tr` (fire held) bends Blaze.

| `k` | Fields | Input |
|---|---|---|
| `equip` | `kind`, `on` | Equip an ability (`on`) or put it away |
| `cast` | `kind`, `o`, `f`, `r`, `sec` | Throw / fire: origin, forward and right vectors (m), alternate fire |
| `cancel` | | Cancel the held ability or finish a Blaze |
| `ult` | `o`, `yaw`, `pitch` | Run It Back (origin, view) / Showstopper equip |
| `return` | `death` | Run It Back returning because the player died |
| `detonate` | `id` | Detonate the Blast Pack with that id |
| `reset` | | Practice reset (clears the player's abilities) |
| `destroy` | `what`, `id` | You shot down the receiver's `bot` or `satchel` on your screen: end theirs |

## Limits

4 KB per message, 150 messages per second per socket (sockets that keep flooding are closed with 1008),
200 sockets, a ping every 15 s (a socket that misses a pong is dropped). A waiting player who has sent nothing for 6 s
(clients ping every 2 s) is skipped by matchmaking, so a tab closed while queued is never matched.
