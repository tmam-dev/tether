# Tether — Plugin View System Design Spec (v1)

- **Status:** Approved — ready for implementation planning
- **Date:** 2026-08-26
- **Scope:** Let third-party developers publish an alternative *view* for one of Tether's three existing view slots (Detail/Flight Recorder, Harness, Analytics), distributed as a git repo, installed locally via a CLI command, and rendered in a sandboxed iframe against a new versioned local JSON API. Embedded panels/widgets, in-app marketplace browsing, and any Tether-hosted service are explicitly out of scope for v1 — see §5.

---

## 1. Why

Tether's current UI — the unified shell built in the [2026-08-22 unified-shell spec](2026-08-22-unified-shell-design.md) — is one team's take on how to visualize a run. The goal, from brainstorming, is to let the developer community contribute *different* takes (a different Flight Recorder layout, a different harness browser, a different analytics dashboard) on top of the same trace data, the way Claude Code plugins let the community extend an editor without forking it. This is also explicitly a growth lever: a plugin ecosystem is a reason for other developers to engage with the project beyond using it as-is, which matters for an OSS tool trying to build a community around it.

The design has to hold two constraints in tension: plugins are untrusted third-party code, but Tether's entire pitch (`server/README.md`) is "no install beyond Node, no account, no API key" — running entirely on one developer's own machine. Nothing here can require a Tether-run backend or a hosted marketplace without breaking that pitch.

## 2. Where things stand today

Verified directly (2026-08-26):

- **No JSON API exists.** Every route in `server/src/server.ts` returns either a full HTML document (`renderShell(...)`) or an HTML fragment (`/fragments/rail`, `/fragments/harness/:traceId`, `/fragments/analytics`, `/fragments/detail[/:traceId]`). The 2026-08-22 spec explicitly deferred adding one ("no JSON API is added for anything else... isn't a precedent for a broader API surface"). This spec is the "future need" that spec anticipated.
- **The three view slots this spec targets already have stable server-side view types** a plugin's data needs can be modeled on directly: `RunView` (`runs.ts`) for Detail, `HarnessView` (`harness.ts`) for Harness, `UsageView` (`analytics.ts`) for Analytics, plus `CoverageView` (`coverage.ts`) which today rides alongside `RunView` in the Detail fragment (`{...run, coverage}`).
- **No static-file serving exists for anything other than `/app.js`**, which is read once from disk at startup and kept in memory (`server.ts`'s `APP_JS` constant) — there's no general "serve a directory of files" route yet.
- **The client router (`server/src/static/app.ts`, compiled to `app.js`) already has a panel-lifecycle contract**: `mountDetailPanel(runData)` returns an `unmount()` closure the router calls before swapping panels, so a panel's listeners can't outlive it. A plugin view, once mounted, needs to fit this same contract (see §3.4).
- **Nothing in `mcp/` or `server/` references Trail** (the private enterprise sibling product) at runtime — confirmed during brainstorming and reconfirmed here since it's load-bearing for this spec: nothing below introduces a dependency on Trail, and none should be added.

## 3. Target design

### 3.1 What a plugin is

A plugin is a self-contained static web app (any framework or build tool the author wants — no constraint to match Tether's own vanilla-JS/zero-build internals) that renders one alternative view for exactly one of the three existing slots: `detail`, `harness`, or `analytics`. It is not an embedded panel, not a new top-level nav destination, and does not replace the shell's rail or top bar.

### 3.2 Distribution and installation — decentralized, local-only

- A plugin is published as a git repo containing a manifest (§3.3) and its built static assets.
- Installed via a new CLI subcommand: `npx trailai-tether plugin add <git-url>`. This clones the repo into a local plugins directory (`<tether-data-dir>/plugins/<slug>/`, alongside the existing SQLite data directory `server/src/db.ts` already resolves via `env-paths`) and validates the manifest. No network calls beyond the clone itself; no Tether-run server is contacted or required.
- `npx trailai-tether plugin dev <path-or-devserver-url>` points a given slot at a local path or a running dev server (e.g. `http://localhost:5173`) instead of the installed static files, for hot-reload during plugin development. This is the primary lever for making plugin authoring actually fast to iterate on — without it, "build a plugin" means rebuild-and-reinstall on every change.
- `npx trailai-tether plugin remove <slug>` deletes the plugin's directory and clears it from any slot it occupied.
- Discovery (finding plugins to install) is out of scope for v1 (§5) — happens on GitHub/a docs page, not inside Tether.

### 3.3 Manifest — `tether-plugin.json`, plugin repo root

```json
{
  "name": "Waterfall View",
  "slug": "waterfall-view",
  "version": "1.0.0",
  "author": "someone",
  "description": "An alternative Flight Recorder timeline as a Gantt-style waterfall.",
  "entry": "dist/index.html",
  "icon": "icon.svg",
  "replaces": "detail",
  "tetherApiVersion": 1
}
```

- `replaces` is one of `"detail" | "harness" | "analytics"` — required, fixed to exactly one slot per plugin for v1 (a plugin wanting to offer more than one view ships as more than one plugin/manifest).
- `tetherApiVersion` gates compatibility against §3.5's API version. On install, and on every server startup, a plugin whose `tetherApiVersion` doesn't match the running server's is not offered in that slot's picker — it stays installed on disk (so nothing is silently deleted) but is skipped, with a startup log line naming the plugin and the mismatch. No compatibility shims or multi-version support in v1; the plugin author re-publishes against the current version.
- `entry` is a path relative to the plugin's own directory to the HTML file the iframe loads (`GET /plugins/<slug>/<entry>`).

### 3.4 Execution model

- The Tether server gains a static-file route, `GET /plugins/:slug/*`, serving files from that plugin's installed directory (mirroring how `/app.js` is already served, generalized to a directory instead of one fixed file).
- The shell's picker (§3.6) mounts a chosen plugin in a sandboxed `<iframe src="/plugins/:slug/:entry">` inside the existing `#content` mount point, in place of the native panel.
- `sandbox="allow-scripts allow-same-origin"` — scripts run and the plugin can `fetch` same-origin (needed for §3.5's API). **This is not a security boundary, and nothing in this design should be read as claiming otherwise.** `allow-scripts` together with `allow-same-origin` on a same-origin document is well known to provide effectively no isolation: the framed script can reach `window.parent.document` and act with the host page's full privileges. So an installed plugin runs with the host page's full privileges, and must be treated as trusted code the user chose to install — the same trust level as any package they `npm install`. The `sandbox` attribute here is a compatibility/consistency convention (every plugin frame is mounted the same structural way), not an isolation mechanism.
- The omitted tokens (no `allow-top-navigation`, no `allow-popups`, no `allow-forms`) are kept for consistency, but honestly: they don't prevent a same-origin script from doing those things via `window.parent`. They constrain the *frame's own* direct actions, not what its script can drive through the host page it can already reach.
- What actually bounds a plugin is the install step (a deliberate `plugin add` of a specific git repo) and the fact that everything reachable — the whole `/api/v1/*` trace store — is already the user's own local data on their own machine. There is no user auth or cross-user data on a single local instance. A hostile-marketplace threat model is explicitly out of scope for v1 (§5); if in-app discovery/install ever ships, this trust model has to be revisited, because "the user typed a git URL they chose" is doing all of the work here.
- The router's existing panel-lifecycle contract (§2) is satisfied trivially for iframe-based panels: "unmount" is just removing the `<iframe>` from the DOM, which tears down everything inside it (its listeners, any in-flight requests) for free — no `unmount()` closure to author or maintain per plugin, unlike native panels.
- A plugin is handed its context (which `traceId`, if any) via its iframe URL's query string, e.g. `/plugins/waterfall-view/dist/index.html?traceId=<id>`, not via `postMessage` — simplest possible contract for v1, and it means a plugin under active development can be opened directly in a normal browser tab with a hand-written `?traceId=` for testing, no Tether shell required.

### 3.5 Public JSON API — new, versioned

Three new routes, additive to the existing fragment routes (which stay HTML, unchanged, still used by the native panels):

| Route | Returns | Backed by |
|---|---|---|
| `GET /api/v1/runs/:traceId` | `RunView & { coverage: CoverageView \| null }` | `getRun` + `getCoverage`, the same pair `/fragments/detail/:traceId` already assembles — this endpoint formalizes that same data as a stable, reusable contract instead of an HTML-embedded one-off |
| `GET /api/v1/harness/:traceId` | `HarnessView` | `getHarnessView` |
| `GET /api/v1/analytics` | `UsageView` | `getUsage` |

- `application/json`, CORS not needed (same-origin — the iframe is served from the same `localhost:PORT` origin as the API).
- 404 body `{ "ok": false, "error": "..." }` for an unknown `traceId`, matching this codebase's existing error-response convention (`sendError` in `server.ts`).
- Versioned via the URL prefix (`/api/v1/...`) rather than a header, so a plugin's `fetch` calls are self-documenting and a future breaking change ships as `/api/v2/...` alongside v1, not a silent behavior change under a stable URL.
- This is a genuinely public, stable contract from the moment it ships — anything reachable by a plugin's `fetch` is de facto public API regardless of how it's documented, so it's designed and versioned as one from day one rather than treated as an internal convenience that happens to be reachable.

### 3.6 Surfacing in the UI

For each of the three slots, the shell's existing top bar/tab area for that slot gains a small picker (a `<select>` is sufficient for v1 — this is not a design-polish pass) listing "native" plus every installed, version-compatible plugin whose `replaces` matches that slot. Selecting a plugin swaps `#content` to that plugin's iframe (§3.4); selecting "native" (the default) restores today's behavior exactly. The picker's current selection is a client-side preference only (not persisted server-side, not part of the URL) — reloading the page returns to native. Persisting the choice is a natural v2 addition, not required to prove the concept out.

### 3.7 Testing

- **API routes:** `server.test.js`-style coverage for the three new `/api/v1/*` routes — 200 + shape + content-type for a known `traceId`, 404 for an unknown one, matching the existing fragment-route test patterns.
- **Plugin static serving:** a test installing a fixture plugin directory and asserting `GET /plugins/:slug/*` serves its files with correct content-type, and that a path attempting traversal outside the plugin's own directory (`../../etc/passwd`-style) is rejected — this is new user-controlled path-construction in this codebase and needs the same scrutiny `decodeTraceIdOr400` already gets elsewhere in `server.ts`.
- **CLI (`plugin add`/`plugin dev`/`plugin remove`):** unit tests around manifest validation (missing/invalid `replaces`, mismatched `tetherApiVersion`) and directory management, using a temp directory rather than the real plugins directory.
- **Manual e2e:** install a real fixture plugin, confirm it appears in its slot's picker, mounts correctly, fetches from `/api/v1/*`, and that removing it clears it from the picker.

## 4. Data flow summary

```
git clone (CLI)  ─────────────▶  <data-dir>/plugins/<slug>/  ─────────────▶  GET /plugins/<slug>/*
                                          │                                          │
                                          ▼                                          ▼
                                  tether-plugin.json                          <iframe src=...>
                                  (replaces, tetherApiVersion)                        │
                                          │                                          ▼
                                          ▼                                  fetch /api/v1/...
                                  slot picker (§3.6)                                  │
                                                                                       ▼
                                                                          getRun/getHarnessView/getUsage
                                                                          (same functions native panels use)
```

## 5. Explicitly out of scope for v1

- **Embedded panels/widgets** within an existing view (a new tab in Detail, a rail widget) — v1 is full-slot-replacement views only.
- **In-app marketplace browsing/install UI** — discovery happens outside Tether; installation is CLI-only.
- **Any Tether-hosted registry, upload endpoint, or backend service** — installation is a local git clone, full stop.
- **Plugin-to-plugin communication** and **cross-run/standalone plugins** not tied to a single slot.
- **Write access to trace data** — the `/api/v1/*` routes are read-only; nothing here adds a way for a plugin to mutate the store.
- **Persisting the picker's slot selection** across reloads (§3.6) — a natural v2 addition.
- **Multi-version API compatibility shims** — a version-mismatched plugin is skipped, not adapted.
- **Any change to `POST /traces` ingestion or the native panels' own rendering** — untouched by this spec.

## 6. Open items resolved during this spec's authoring

- **Whether this depends on Trail in any way** — confirmed no, and designed to stay that way (§2, §1): everything runs against Tether's own local server and SQLite store; the only thing shared with Trail is the upstream OTel wire format, which is outside this spec entirely.
- **How a plugin gets its data** — resolved as a new versioned public JSON API (§3.5) rather than exposing the existing HTML fragment routes or giving plugins any form of direct DB access; this is also the first JSON API this codebase has had, so it's designed as a stable public contract from the start rather than grown ad hoc.
- **How a plugin is mounted in the host** — a same-origin iframe (§3.4), chosen over an inline same-origin script and a Web Component contract (steeper authoring bar, ties plugin authors to a Tether-specific JS API instead of "just build a web page"). Note this is a *containment* choice, not an *isolation* one: as §3.4 spells out, a same-origin frame with `allow-scripts` has the host page's full privileges. It buys a clean mount/unmount story and "a plugin is just a web page", not a security boundary.
- **How installed plugins surface in navigation** — a per-slot picker next to the existing native view (§3.6), not a growing top-level nav list, so installing many plugins doesn't clutter navigation.

## 7. Addendum (2026-08-30) — `io` shape widened under v1, not forked to v2

The [2026-08-29 structured-tool-call-data spec](2026-08-29-structured-tool-call-data-design.md)
widened `StepView.io`'s value type from always-`string` to
`string | object | array | number | boolean | null`, which changes the
shape of data `GET /api/v1/runs/:traceId` returns to plugins — a real
change to the "genuinely public, stable contract" this spec (§3.5) said
would never change silently under a stable URL.

**Decision:** accepted as a v1-compatible widening, not forked to
`/api/v2/*`. Reasoning: the plugin ecosystem is brand new (no known
installed plugins depend on `io` always being a string), the change is
additive at the type level (a v1 plugin that only ever handled strings
will render `[object Object]` for the new cases rather than crash), and
bumping `tetherApiVersion` would disable every installed plugin for a
widening most will tolerate. Documented in `server/README.md`'s Plugins
section so plugin authors know to handle non-string `io` values going
forward. If a future breaking change to this route is needed for
unrelated reasons, it should still fork to `/api/v2/*` per §3.5 — this
addendum is a one-time exception for a genuinely additive widening, not a
precedent for skipping versioning on breaking changes generally.
