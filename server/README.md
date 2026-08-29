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

## Plugins

A plugin is an alternative *view* for one of the three slots above — a
third-party Detail, Harness, or Analytics panel. It's a plain static web
page (any framework, any build tool), published as a git repo, installed
locally, and mounted in an iframe in place of the native panel, with the
run's `traceId` handed to it on the iframe URL's query string.

**Trust model, stated plainly:** the iframe is same-origin and its scripts
run, so an installed plugin has the host page's full privileges — it can
reach `window.parent` and read everything the `/api/v1/*` routes expose
(every prompt, model output, and verdict in your local store). The
`sandbox` attribute on the frame is a consistency convention, not a
security boundary. Install a plugin the way you'd `npm install` a package:
only if you trust the repo you're pointing at.

```bash
npx trailai-tether plugin add <git-url>   # clone + validate into <data-dir>/plugins/<slug>/
npx trailai-tether plugin dev <slug> [url]  # serve that slug's assets from a dev server (omit url to clear)
npx trailai-tether plugin remove <slug>   # delete the plugin and clear any dev override
```

`plugin dev` is the authoring loop: point a slug at e.g.
`http://localhost:5173` and Tether proxies `/plugins/<slug>/*` to your dev
server, so hot reload works while the plugin's `fetch` calls stay
same-origin.

### `tether-plugin.json` (plugin repo root)

| Field | Required | Meaning |
|---|---|---|
| `name` | yes | Display name, shown in the slot's picker. |
| `slug` | yes | Directory name and URL segment — one plain path segment, no separators. |
| `version` | yes | The plugin's own version string; Tether doesn't interpret it. |
| `author` | yes | Free-form author string. |
| `description` | yes | One-line description of the view. |
| `entry` | yes | Path (relative to the repo root) of the HTML file the iframe loads. |
| `replaces` | only for `kind: "panel"` (the default) | Exactly one of `detail`, `harness`, `analytics`. |
| `kind` | no | `"panel"` (default) or `"widget"`. A panel replaces one of the three slots above (see `replaces`); a widget is a smaller card on the Analytics dashboard (see below) and has no `replaces`. |
| `size` | only for `kind: "widget"` | `"small" \| "medium" \| "large"` — the widget's footprint in the Analytics dashboard's grid. |
| `tetherApiVersion` | yes | The plugin API version this targets — currently `1`. A mismatch leaves the plugin installed but skipped, with a warning on install and on every server startup. |
| `icon` | no | Path to an icon in the repo. |

### What a plugin can read

Three read-only JSON endpoints, same-origin, no auth, versioned by URL
prefix (a breaking change would ship as `/api/v2/*`):

- `GET /api/v1/runs/:traceId` — the run: goal, verdict, steps, cost/tokens,
  plus `coverage` (which harness manifest entries the run touched).
- `GET /api/v1/harness/:traceId` — that run's harness: skills, sub-agents,
  MCP servers.
- `GET /api/v1/analytics` — usage aggregated across every run in the store.

Unknown `traceId` gives a 404 with `{ "ok": false, "error": "..." }`.
Nothing here writes: a plugin cannot mutate the trace store.

### Analytics widgets

A plugin with `"kind": "widget"` in its manifest mounts as a small card in a grid on the
Analytics view instead of replacing the whole view — several widgets from different plugins can
be on the dashboard at once. Installed the same way as any plugin (`plugin add`); which widgets
are currently on the dashboard is picked via the "Add widget" control on the Analytics view itself,
and persisted server-side:

- `GET /api/v1/dashboard/analytics` — `{ "slugs": string[] }`, the ordered list of widget slugs
  currently on the dashboard (filtered to widgets that are still installed and version-compatible).
- `PUT /api/v1/dashboard/analytics` — body `{ "slugs": string[] }`, replaces the list wholesale.

A widget plugin reads data the same way a full-panel Analytics plugin does — `GET /api/v1/analytics`
— there is no separate widget-specific data API.

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
