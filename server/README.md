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
- A single-page shell: a left rail lists the 50 most recent runs (goal,
  verdict, relative time, live-updated every 5s) and stays on screen while
  the main panel swaps between three views, navigated client-side with no
  full page reload:
  - **Detail** (`/runs/:traceId`, or `/` for the most recent run) — the
    Flight Recorder view: goal, verdict, a scrubbable step timeline with
    play/pause/speed controls, per-step expansion showing raw
    input/output, and a Coverage panel showing which of the run's
    harness manifest entries were actually used.
  - **Harness** (`/runs/:traceId/harness`) — the skills, sub-agents, and
    MCP servers that run's harness had available, reshaped from the
    manifest `mcp/` stamps on every run. Always follows whichever run is
    selected in the rail.
  - **Analytics** (`/analytics`) — aggregates coverage across every run
    in the store: which skills/sub-agents/MCP servers are used vs.
    registered but never touched ("dead weight").
  Every route above is a real server route — direct load, reload, and
  shared links all work without a client-side navigation step. Harness
  and Analytics are fully server-rendered (no-JS renders the real page).
  The Detail view builds its timeline in the browser from an embedded
  JSON island, as it always has (this predates the unified shell — see
  the Flight Recorder design spec) — with JS disabled you get the static
  skeleton, not the rendered replay. Client-side navigation (via
  `/app.js`) is progressive enhancement over the server routes, not a
  replacement for them.

## Building from source

```bash
cd server
npm install
npm run build
npm test
```

`tsconfig.json`'s `"moduleDetection": "legacy"` is what lets
`src/static/app.ts` compile as a classic browser `<script>` (no
`export {}` wrapper forcing ES-module treatment) instead of an ES
module, despite the rest of this package being `"type": "module"` —
`src/static/app.ts` is served as-is via `GET /app.js` and loaded with a
plain `<script src="/app.js">`, not imported.

## License

Apache-2.0 — see [LICENSE](LICENSE).
