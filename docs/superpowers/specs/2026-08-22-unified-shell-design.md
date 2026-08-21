# Tether — Unified Shell Design Spec

- **Status:** Approved — ready for implementation planning
- **Date:** 2026-08-22
- **Scope:** Replace today's four independent, full-page-reload routes (`GET /`, `GET /runs/:traceId`, `GET /harness`, `GET /analytics`) with one persistent shell — a run rail plus a swappable content panel — navigated by client-side JS with no full page reload. Visual redesign (colors, spacing, typography polish) is a separate implementation-time pass using the frontend-design skill; this spec covers structure and behavior only.

---

## 1. Why

The four pages work but don't feel like one product: each is its own document, each re-implements its own topbar/nav, and clicking between Runs → a run's detail → Harness → Analytics is four full page loads, losing scroll position and any in-page state every time. The goal — approved during brainstorming — is a single persistent shell (a left rail listing runs, always visible, plus a main panel that swaps between a run's detail, its harness, and store-wide analytics) with instant client-side navigation, so it reads as one focused developer tool instead of four linked documents.

## 2. Where things stand today

Verified directly (2026-08-22):

- **Four routes in `server/src/server.ts`**, each independently computing data and calling its own `renderXPage(...)` function, each returning a complete `<!doctype html>` document with its own `<style>` block: `renderRunListPage(runs)`, `renderFlightRecorderPage(run, coverage)`, `renderHarnessPage(view, runs)`, `renderAnalyticsPage(usage)`.
- **Three of the four pages are plain server-rendered HTML with no client JS** (`run-list.ts`, `harness.ts`, `analytics.ts`) — a data object goes in, an HTML string comes out, escaped with each file's own copy of `escapeHtml`.
- **`flight-recorder.ts` is structurally different from the other three.** It is not server-rendered markup — `renderFlightRecorderPage` serializes `{...run, coverage}` to JSON (with `<`, ` `, ` ` escaped to survive sitting inside a `<script>` block — this exact escaping was the subject of a real XSS fix in review, see the harness memory notes) and substitutes it into a `__RUN_JSON__` placeholder inside a ~250-line inline `<script>`. That script's IIFE (`renderMission`, `renderStrip`, `renderSteps`, `renderInspector`, `renderCoverage`, `initControls`, plus the play/pause/speed/scrub/keyboard-shortcut/theme-toggle logic) runs once on page load and builds the entire visible timeline from that embedded JSON, client-side. **This means Flight Recorder's rendering and escaping already happens in the browser, not on the server** — the only page of the four where that's true.
- **Each page's `<style>` block is separately authored and inconsistent.** `harness.ts` and `analytics.ts` share a near-identical CSS custom-property token set (`--bg`, `--panel`, `--line`, `--ink`, `--ink-2`, `--ink-3`, `--radius`, `--sans`, `--mono`) with light/dark values via `@media (prefers-color-scheme: dark)`. `flight-recorder.ts` has a *superset* of that same token system plus semantic tokens the other pages lack entirely (`--accent`, `--met`/`--partial`/`--failed`/`--stuck` status colors, `--shadow`). `run-list.ts` uses neither — flat hardcoded hex values, no custom properties, only a bare `body { background; color; }` override in its one dark-mode media query. There is no shared stylesheet today.
- **`harness.ts`'s `renderHarnessPage(view, runs)` takes a `runOption`-driven `<select id="runPicker">`** that navigates via `location.search = '?run=' + traceId` — a full page reload — to let a developer view an older run's manifest independent of anything else on screen.
- **`getHarnessView(db, traceId?)`** already defaults to the most recent run when `traceId` is omitted (`ORDER BY startTimeUnixNano DESC LIMIT 1`) — this exact fallback is what `/` will reuse for its default detail view.
- **No JSON API exists anywhere in this codebase**, by deliberate prior decision (Flight Recorder spec §4: "deliberately deferred; revisit only if a future need — e.g. ... a live-updating run list — actually requires client-side fetching"). That future need has now arrived. This spec deliberately still does not add a JSON API — see §3.2's reasoning.

## 3. Target design

### 3.1 Shell & routes

One new template, `server/src/templates/shell.ts`, exporting `renderShell(active: ShellState, panelHtml: string): string` where `ShellState = { view: "detail" | "harness" | "analytics"; traceId?: string }`. It renders:

- A single shared `<style>` block (promoted from `flight-recorder.ts`'s existing token superset — the richest of the four today, already has the semantic status colors the rail needs for verdict dots) — this is the one stylesheet every panel now uses. `run-list.ts`'s hardcoded hex and `harness.ts`/`analytics.ts`'s reduced token subset are retired.
- A left rail (`<nav id="rail">`) populated with the initial `listRuns(db, 50)` rows — a compact list (goal, verdict dot, relative time), replacing today's wide table. The currently-active `traceId` (if any) is marked.
- A top bar with the view-switch tabs (Detail is implicit — it's whatever run is selected — Harness and Analytics are explicit tabs).
- A `<main id="content">` mount point containing the initial panel's markup, inlined directly — **first paint is never a loading spinner**, the server renders the real initial view same as it does today.
- One `<script src="/app.js"></script>` tag (new static route, see §3.3) plus `window.__TETHER_INITIAL__ = { view, traceId }` so the client router knows it doesn't need to re-fetch what's already on screen.

Four existing routes in `server.ts` change to all call `renderShell`, computing the same data they compute today:

| Route | `ShellState` | Initial panel content |
|---|---|---|
| `GET /` | `{ view: "detail", traceId: mostRecent }` (or no `traceId` if the store is empty) | `getRun`+`getCoverage` for the most recent run from `listRuns(db, 50)[0]`, or an empty state |
| `GET /runs/:traceId` | `{ view: "detail", traceId }` | `getRun`+`getCoverage` for that run; shell-wrapped 404 for an unknown id (see below) |
| `GET /runs/:traceId/harness` | `{ view: "harness", traceId }` | `getHarnessView(db, traceId)` |
| `GET /analytics` | `{ view: "analytics" }` | `getUsage(db)` |

`GET /harness` (bare, with the old `?run=` query param) is removed — Harness now always follows rail selection, per the approved brainstorming answer, so the standalone picker has no reason to exist. When no run is selected (the Analytics view, or an empty store), the top bar's "Harness" tab is rendered **disabled** — dimmed, `aria-disabled="true"`, no click handler — rather than hidden, so the tab layout never shifts; it re-enables the moment a run is selected in the rail. This replaces today's `runs.length === 0` empty-state text in `renderHarnessPage` with a state the tab itself communicates.

Direct navigation to `/runs/:traceId` (or `/runs/:traceId/harness`) for a `traceId` that doesn't exist renders the **shell** with a "Run not found" message in `#content` and a 404 status — not the bare `{"ok": false, "error": "..."}` JSON body today's route returns. This matches §3.3's fragment-404 behavior and keeps every entry point into the app inside the same shell; a stale bookmark or shared link should never dead-end on raw JSON.

### 3.2 Fragment endpoints: markup for three panels, data for one

Three new routes return **rendered HTML fragments**, not JSON, preserving the property that all escaping for these three panels stays server-side, exactly where it is today and where the security reviews already covered it:

- `GET /fragments/rail?active=:traceId` → the rail's `<nav>` inner HTML, `listRuns(db, 50)`, with `active` row marked (this is also what the 5-second poll re-fetches, see §3.4).
- `GET /fragments/harness/:traceId` → `renderHarnessBody(getHarnessView(db, traceId))` — `harness.ts`'s existing per-view HTML, minus the topbar/picker/`<style>` it currently wraps itself in.
- `GET /fragments/analytics` → `renderAnalyticsBody(getUsage(db))` — same split.

Each of `run-list.ts`, `harness.ts`, `analytics.ts` is refactored to split its existing `renderXPage(...)` into a `renderXBody(...)` (the part that changes per request) that both the shell's initial render and its matching fragment route call — **not new rendering logic, the same function reused two ways.**

**The fourth panel — Detail (Flight Recorder) — does not get a markup fragment.** Per §2, its rendering already happens client-side from embedded JSON, and markup returned via `innerHTML` cannot contain an executable `<script>` tag (the browser silently ignores it) — swapping in Flight Recorder's current output would break it outright. Instead:

- `GET /fragments/detail/:traceId` returns a **data fragment**: a single inert `<script type="application/json" id="run-data">{...run, coverage}</script>` (a `type="application/json"` script tag is never executed, by spec, whether present at initial load or inserted via `innerHTML` — this is the same mechanism frameworks like Next.js use for `__NEXT_DATA__`) plus the static DOM skeleton the render functions already expect (`#mission`, `#strip`, `#steps`, `#inspector`, `#coverage`, etc. — currently part of `TEMPLATE`, moved here unchanged).
- `flight-recorder.ts`'s ~250-line inline script — `renderMission`/`renderStrip`/`renderSteps`/`renderInspector`/`renderCoverage`/`initControls` and the play/pause/scrub/keyboard logic — moves out of the per-page `<script>` block and into `app.js` (§3.3) as an exported `mountDetailPanel(runData)` function, loaded once by the shell instead of re-executing on every page load. **This is a relocation, not a rewrite** — same functions, same escaping, called from a different trigger (router navigation instead of page-load IIFE).
- The theme-toggle button and its `data-theme` logic move to the shell's persistent topbar (it's a global concern, not Detail-specific) and out of `mountDetailPanel`.

This keeps the core property from the brainstorming approach intact: **no rendering or escaping logic is duplicated anywhere.** Three panels' escaping stays server-side (unchanged). Detail's escaping stays exactly where it already was — client-side, inside functions that already passed security review — just invoked from a router call instead of a page-load IIFE.

No JSON API is added for anything else. `/fragments/detail/:traceId` is not a general-purpose data endpoint — it exists solely to feed `mountDetailPanel`, mirrors exactly the shape `renderFlightRecorderPage` already embeds today, and returns `text/html` (a script tag), not `application/json`, so it isn't a precedent for a broader API surface.

### 3.3 Client router: `server/src/static/app.js`, served at `GET /app.js`

A new static route serves this file's contents directly (`Content-Type: text/javascript; charset=utf-8`), read from disk once at server startup and kept in memory for the process lifetime — matching how the rest of this codebase treats its own source (no bundler, no transform, no per-request disk I/O; a code change requires a restart, same as every other route already does). Responsibilities:

- **Navigation:** event delegation on rail links and top-bar tabs — `preventDefault()`, compute the target fragment URL, `fetch` it, swap `#content`'s children (or run `mountDetailPanel` for the Detail case), `history.pushState(null, "", url)`, update `document.title`, update the rail's active-row and tab's active-state classes locally (no extra fetch needed for this part — the click itself tells the router what's now active).
- **Back/forward:** a `popstate` listener re-derives `{view, traceId}` from `location.pathname` and re-runs the same swap logic (fetch-and-mount), not a `pushState` (browsers already moved history).
- **Panel lifecycle:** before mounting a new panel, any listeners the previous panel attached to `window`/`document` (Detail's keyboard shortcuts, drag-to-scrub `mousemove`/`mouseup` on `window`) are removed. `mountDetailPanel` returns an `unmount()` closure the router calls before swapping away, so Detail's spacebar/arrow-key handling can never fire while a different panel is showing — a real bug in the naive version of this design (today those listeners exist for the page's entire lifetime because the page never changes underneath them; a shell has to be explicit about this).
- **Rail polling:** every 5 seconds, `fetch("/fragments/rail?active=" + currentTraceId)` and replace the rail's inner HTML. A failed fetch is caught and skipped silently — the next tick retries; no error UI, no backoff, no retry-count surfaced to the user (this is a convenience refresh, not a critical path).
- **Fragment fetch failure during navigation** (as opposed to polling): render a small inline block in `#content` — "Couldn't load this view. [Retry]" — where Retry re-runs the same navigation. The rail and top bar stay interactive; a failed navigation never leaves the shell in a broken state.
- **Unknown `traceId` navigation:** the fragment routes return 404 with a small HTML body ("Run not found") for this case specifically (distinct from a network-level failure) — the router renders that body as-is in `#content` rather than the generic retry block, since retrying an unknown id can't succeed.

### 3.4 URL scheme (final)

| URL | Meaning |
|---|---|
| `/` | Shell, Detail view, most recent run (or empty state) |
| `/runs/:traceId` | Shell, Detail view, that run |
| `/runs/:traceId/harness` | Shell, Harness view, that run |
| `/analytics` | Shell, Analytics view, no run selected in the rail |

Every URL is a real server route (§3.1) — direct load, reload, and shared links all work without JS, same as today. Client-side navigation (§3.3) is the fast path on top of that, not a replacement for it.

### 3.5 Testing

- **Server-side:** the three-way `renderXPage`/`renderXBody` split gets the same per-function unit tests this codebase already writes (extending `run-list.test.js`-style patterns, new for harness/analytics body functions). New fragment routes get `server.test.js` coverage: 200 + correct content-type + active-row marking for `/fragments/rail`, 200/404 for `/fragments/harness/:traceId` and `/fragments/detail/:traceId`, and the four shell routes' initial-panel content.
- **Client-side (`app.js`):** follows the exact precedent `flight-recorder.test.js` already set — extract the script source as a string and execute it inside Node's `vm` module against a minimal fake DOM (`querySelector`, `addEventListener`, a fake `fetch`, a fake `history`), asserting on the DOM mutations and `fetch`/`pushState` calls it makes. No new test dependency, no headless browser.
- **Manual e2e + adversarial review:** browser-driven click-through of all four views plus back/forward/reload, then the same adversarial security/correctness pass every other surface in this codebase has been through — this spec introduces new places untrusted data reaches the DOM (fragment responses inserted via `innerHTML`) and a real lifecycle bug class (stale listeners) that didn't exist when every page was independent, both worth a dedicated look.

## 4. Explicitly out of scope for this spec

- **Visual redesign** — colors, spacing, typography, the actual "friendly for developers" polish. Structure and behavior only here; visual work is a separate implementation-time pass (frontend-design skill + user-provided inspiration).
- **A general JSON API** — per §3.2, the one data fragment added is narrowly scoped to feeding `mountDetailPanel`, not a reusable API surface.
- **Mobile/narrow-viewport layout** — not raised during brainstorming; deferred to the visual pass if it comes up there.
- **Search/filter on the run rail** — out of scope; the rail keeps today's `listRuns(db, 50)` recency cap with no new query controls.
- **Live updates beyond the rail** — an open Detail/Harness/Analytics panel does not auto-refresh if the underlying run changes; only the rail polls.
- **Any change to `POST /traces` ingestion** — untouched by this spec.

## 5. Open items resolved during this spec's authoring

- **Flight Recorder's client-rendering precedent** — discovered during research (§2), not previously visible in the brainstorming conversation. Resolved via the data-fragment/markup-fragment hybrid in §3.2, preserving the "no duplicated escaping logic" property the brainstormed approach was chosen for.
- **Stale global event listeners across panel switches** — a failure mode that can't occur in today's one-page-per-load model but is real once panels are swapped in place. Resolved via the `unmount()` closure contract in §3.3.
- **Harness's `?run=` picker** — removed outright rather than kept alongside rail selection, per the approved "Harness follows rail selection" answer; two ways to pick a run would be confusing, not additive.
- **Which page's CSS becomes the shared token system** — `flight-recorder.ts`'s (already the richest, already has the semantic status colors the rail's verdict dots need), not a new one authored from scratch.
