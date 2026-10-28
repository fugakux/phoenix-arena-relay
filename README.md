# phoenix-arena-relay

Matchmaking and message relay for the 1v1 battle mode of the Phoenix / Ascent browser range
(https://phoenix-ascent-arena.vercel.app). Two players press **1V1 BATTLE** (optionally with the same room code), the
relay pairs them, forwards their state and hits, keeps kills and deaths and ends the match at 30 kills or after 10 minutes (Deathmatch rules). It simulates nothing, so a free Render
instance is enough. Protocol: [PROTOCOL.md](PROTOCOL.md).

```bash
npm ci
npm test
PORT=8787 npm start
```

Settings (environment): `PORT` (default 8787), `ALLOWED_ORIGINS` (comma separated, default the deployed range; any
`localhost` / `127.0.0.1` page is always allowed), `FIRST_TO` (default 30), `TIME_LIMIT` seconds (default 600), `MAX_CLIENTS` (default 200).

Point a local copy of the range at a local relay with `arena.html?server=ws://127.0.0.1:8787/ws`.
