# trailai-tether

Tether's local, self-hosted server — accepts the OTLP traces
[`trailai-mcp`](https://www.npmjs.com/package/trailai-mcp) sends and stores
them in embedded SQLite. No install beyond Node, no account, no API key.

## Run it

```bash
npx trailai-tether
```

Starts listening on `http://localhost:4319` (override with `TETHER_PORT`).
Data persists across restarts in an OS-appropriate app-data directory
(resolved via `env-paths`) — the exact path is printed on startup.

## Point your coding agent at it

`trailai-mcp` already defaults to `http://localhost:4319` with no
authentication when `TRAIL_URL`/`TRAIL_PUBLIC_KEY`/`TRAIL_SECRET_KEY` are
unset — so once this server is running, no extra configuration is needed:

```bash
claude mcp add trail -- npx -y trailai-mcp
```

## What's here today

- `POST /traces` — OTLP/JSON ingestion, matches the wire format
  `trailai-mcp` already sends. No auth (nothing to protect on one
  developer's own machine).
- `GET /` — a placeholder page confirming the server is running and how
  many runs have been ingested. The real Flight Recorder UI (run timeline,
  goal-attainment verdict, harness anatomy) is separate, larger, upcoming
  work — this is just the ingestion/storage foundation it will sit on.

## Building from source

```bash
cd server
npm install
npm run build
npm test
```

## License

Apache-2.0 — see [LICENSE](LICENSE).
