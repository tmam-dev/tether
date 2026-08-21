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
- `GET /` — a run list: goal, verdict, duration, start time, linking into each
  run's detail page.
- `GET /runs/:traceId` — the Flight Recorder view for one run: goal, verdict
  (when a judge is configured), a scrubbable step timeline with play/pause/
  speed controls, and per-step expansion showing raw input/output. Adapted
  from a design prototype, cut down to exactly what's captured today — no
  pinned criteria, sub-goals, guardrail/eval signals, diffs, or context-window
  inspector, since none of that data exists yet.

## Building from source

```bash
cd server
npm install
npm run build
npm test
```

## License

Apache-2.0 — see [LICENSE](LICENSE).
