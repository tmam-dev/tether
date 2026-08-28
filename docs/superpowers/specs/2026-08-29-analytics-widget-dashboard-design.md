# Tether — Analytics Widget Dashboard Design Spec (v1)

- **Status:** Approved — ready for implementation planning
- **Date:** 2026-08-29
- **Scope:** Add a second, smaller plugin shape — a *widget* — that mounts as a bounded-size card in a new composable grid on the Analytics view, alongside (not replacing) today's full-slot plugin system. Multiple widgets from multiple independent plugin authors can be installed and arranged on one dashboard at once. Detail and Harness stay full-slot-replacement only; drag/resize, in-app registry browsing, and any Tether-hosted service are out of scope — see §5.

---

## 1. Why

The shipped plugin system (`docs/superpowers/specs/2026-08-26-plugin-view-system-design.md`) lets one plugin replace one entire slot at a time — a developer picks either the native Analytics view or exactly one installed plugin's view, never both, never several plugins' views together. That caps how much of an ecosystem can visibly coexist: even with many analytics plugins published, a user only ever sees one at a time.

From brainstorming (2026-08-29): the goal is a WordPress-style plugin ecosystem as Tether's growth lever for Trail's OSS-to-enterprise funnel — see `feedback-oss-vs-enterprise-lens` in project memory. WordPress's plugin *volume* comes from plugins being small, stackable widgets on a dashboard, not full-page takeovers. This spec is the mechanism for that on the one slot where "a dashboard composed of several small things" is a natural fit — Analytics. It deliberately stays inside Tether's existing free/OSS scope (mechanism only, single local developer, no multi-user/team features) — governance over which widgets a team may install, and dashboards aggregated across many developers, are enterprise/Trail concerns and are not designed here.

## 2. Where things stand today

Verified directly (2026-08-29):

- **A plugin fully replaces `#content`.** `mountPluginFrame` (`server/src/static/app.ts:397-406`) does `content.innerHTML = ""` then appends exactly one `<iframe class="plugin-frame">`. There is no notion of more than one plugin visible at once, on Analytics or any slot.
- **The manifest has no `kind` field.** `PluginManifest` (`server/src/plugins.ts:24-34`) requires `replaces: "detail" | "harness" | "analytics"` on every plugin, unconditionally. `isValidManifest` rejects anything missing it. There is no way today for a manifest to say "I'm not a full-slot view."
- **The per-slot picker is a single `<select>`, one per slot, exclusive.** `PLUGIN_PICKER_IDS` (`app.ts:382-386`) maps each of the three slots to one `<select>` element; choosing an option there fully swaps `#content` (native or the one chosen plugin) via `onPluginPickerChange` (`app.ts:408-417`). Nothing here composes multiple selections.
- **No mutable, non-trace server-side state exists except `dev-overrides.json`.** `readDevOverrides`/`setDevOverride` (`server/src/plugins.ts:152-189`) is the only precedent for the server persisting anything outside the SQLite trace store, and it's dev-tooling-only (which dev server URL overrides a slug), never read by the shipped UI's normal render path.
- **`UsageView` (`server/src/analytics.ts:21-25`) is exactly what a widget would fetch** — `GET /api/v1/analytics` (`server/src/server.ts:377-382`) already returns it, unchanged by anything in this spec.
- **The Analytics fragment/native view is server-rendered HTML** via `/fragments/analytics`, not itself a widget or a plugin — this spec adds a grid *after* it, not a refactor of it (§3.4).

## 3. Target design

### 3.1 What a widget is

A widget is a plugin manifest with `"kind": "widget"` — a new, second shape alongside today's implicit `"kind": "panel"` (every already-installed plugin, silently defaulted for backward compatibility — see §3.2). Distribution and installation are unchanged: a git repo with `tether-plugin.json`, `npx trailai-tether plugin add <git-url>`, cloned into `<data-dir>/plugins/<slug>/` exactly as today. Only the manifest shape and the mount target differ.

For this pass a widget always targets the Analytics dashboard — there is no `replaces` field on a widget manifest, and no other slot accepts widgets. Extending widgets to Detail/Harness is an explicit non-goal (§5), not an oversight: those slots represent one coherent thing (one run, one manifest), where "several small unrelated cards" is a worse fit than it is for a dashboard.

### 3.2 Manifest changes

```json
{
  "name": "Cost Trend",
  "slug": "cost-trend-widget",
  "version": "1.0.0",
  "author": "someone",
  "description": "7-day rolling cost trend line",
  "entry": "dist/index.html",
  "kind": "widget",
  "size": "medium",
  "tetherApiVersion": 1
}
```

- `kind: "panel" | "widget"`, optional, defaults to `"panel"` — every manifest written before this spec has no `kind` field at all, and must keep installing and rendering exactly as it does today. `isValidManifest` (`plugins.ts`) is extended to accept a missing `kind` as `"panel"`, and to require `replaces` only when `kind === "panel"`.
- `size: "small" | "medium" | "large"`, required when `kind === "widget"`, absent/ignored for `"panel"`. Declares the widget's footprint in the grid (§3.4) — 1, 2, and 4 grid cells respectively. No pixel-level sizing; this is the full extent of a widget author's layout control in v1.
- `replaces` is omitted (and ignored if present) for `kind: "widget"` — a widget's target is implicitly always the Analytics dashboard.
- No change to `tetherApiVersion` gating — a version-mismatched widget is skipped from the "Add widget" picker (§3.5) exactly as a mismatched panel plugin is skipped from its slot's picker today.

### 3.3 Execution model

Unchanged from the shipped panel-plugin model (`2026-08-26` spec §3.4), reused as-is: each widget is its own `<iframe sandbox="allow-scripts allow-same-origin" src="/plugins/:slug/:entry">`, same-origin, no new isolation story. A widget fetches `GET /api/v1/analytics` itself, the same endpoint and shape a full Analytics panel plugin already uses — no new read API. Unmounting a widget is removing its `<iframe>` from the DOM, same as today.

The one behavioral difference from a panel plugin: several widget iframes exist in the DOM simultaneously, each independently fetching and rendering. This is a real, accepted resource cost (N widgets = N iframes, N independent fetches) — acceptable for the small, curated widget counts this is designed for; not something this spec optimizes (e.g. no shared-fetch/caching layer across widgets).

### 3.4 Dashboard composition

The Analytics view's `#content` gains a second region, appended after the existing native section (native stays exactly as it renders today — no refactor of `/fragments/analytics`): a widget grid, a CSS grid auto-flowing installed widgets by their `size` class (small/medium/large → 1/2/4 cells), wide enough to wrap responsively. Each widget card is its iframe plus a small header bar (widget name from its manifest, a remove control). With zero widgets installed, the grid area is simply absent — the native view alone is what renders today, unchanged.

An "Add widget" control sits above the grid: a `<select>` (matching the existing per-slot picker's UI pattern) listing every installed, version-compatible `kind: "widget"` plugin not currently on the dashboard. Choosing one appends it to the grid and to the persisted list (§3.5); there is no manual repositioning or resizing in this pass (drag/resize is §5).

### 3.5 Persistence

A new file, `<data-dir>/plugins/analytics-dashboard.json`, holding an ordered array of slugs currently on the dashboard — the first genuinely mutable, non-dev-tooling server-side state this codebase has, worth naming plainly rather than folding quietly into an existing module. Two new endpoints:

| Route | Behavior |
|---|---|
| `GET /api/v1/dashboard/analytics` | Returns `{ slugs: string[] }` — the persisted list, filtered to slugs that are still installed and version-compatible (a since-removed or now-incompatible plugin is silently dropped from what's returned, matching `plugins.ts`'s existing "missing manifest = skip, never throw" convention — not surfaced as an error to the client). |
| `PUT /api/v1/dashboard/analytics` | Body `{ slugs: string[] }`, replaces the persisted list wholesale (simplest possible contract — the client always sends the full current order, not a diff). Validates each slug with `isPlainSlug` before writing, same guard `plugins.ts` already applies everywhere else a slug reaches the filesystem. |

On page load, the client fetches the persisted list, mounts each surviving widget in order, and only then is the "Add widget" picker populated (installed-but-not-yet-added = installed widgets minus the persisted list). Adding or removing a widget updates the in-memory order and `PUT`s the full list back.

### 3.6 Testing

- **Manifest validation:** `kind: "widget"` accepted without `replaces`; `size` required and validated against the three allowed values for widgets; a manifest with no `kind` field at all (every pre-existing plugin) still validates as `"panel"` and still requires `replaces` — a direct regression check against the shipped behavior.
- **Dashboard persistence endpoints:** `GET` before any `PUT` returns `{ slugs: [] }`; a `PUT` → `GET` round-trip; a slug present in the persisted file but no longer installed (or now version-incompatible) is dropped from `GET`'s response, not errored; a `PUT` containing a malformed slug (path traversal, `__proto__`, etc.) is rejected the same way `plugins.ts`'s existing slug guards reject one elsewhere.
- **Manual e2e:** install two fixture widget plugins, add both via the picker, reload the page, confirm both render in the same order; remove one, reload, confirm only the remaining one renders.

## 4. Data flow summary

```
tether-plugin.json (kind: "widget", size)
        │
        ▼
plugin add <git-url>  ──────────────▶  <data-dir>/plugins/<slug>/
                                                │
                                                ▼
                                    "Add widget" picker (§3.4)
                                                │
                                                ▼
                          PUT /api/v1/dashboard/analytics  { slugs }
                                                │
                                                ▼
                        <data-dir>/plugins/analytics-dashboard.json
                                                │
                    (on load) GET /api/v1/dashboard/analytics
                                                │
                                                ▼
                              widget grid: N × <iframe src="/plugins/:slug/:entry">
                                                │
                                                ▼
                                  each: fetch /api/v1/analytics
```

## 5. Explicitly out of scope for this pass

- **Drag-to-reposition / resize** — the size-class grid auto-flows; no persisted x/y/w/h coordinates, no drag interaction. A natural v3 addition once the mechanism proves adoption.
- **Widgets on Detail or Harness** — this spec is Analytics-only, per §3.1's reasoning; extending widgets to the other two slots is a separate future decision, not assumed here.
- **Refactoring the native Analytics view into widgets itself** — the native section stays exactly as it renders today, untouched code, always present even with zero widgets installed.
- **Multiple instances of the same widget** — a widget slug can appear at most once on the dashboard in this pass; no per-instance configuration or duplication.
- **Any team/multi-user dashboard state** — the persisted file is local to one machine's data dir, matching Tether's single-developer/self-hosted scope. Shared team dashboards, org-wide widget policy/allowlists, and cross-machine aggregate widget data are Trail/enterprise concerns (per `feedback-oss-vs-enterprise-lens` in project memory) and are not designed here.
- **A shared-fetch/caching layer across widgets** — each widget fetches `/api/v1/analytics` independently; no batching or de-duplication.
- **Any change to the registry/discovery brainstorm** (where a curated plugin list lives, how it's fetched) — that thread is separate and still open; this spec only adds the widget *mechanism*, not a catalog to browse widgets from.

## 6. Open items resolved during this spec's authoring

- **Additive vs. slot-wide replacement** — resolved additive: native Analytics view stays fixed, widgets append below it (§3.4), rather than refactoring the native view into widget-shaped units, per brainstorming discussion 2026-08-29.
- **Which slots get widgets** — resolved Analytics-only for this pass (§3.1); Detail/Harness keep full-slot-replacement plugins exclusively.
- **Grid model** — resolved fixed size-class auto-flow (small/medium/large) over free-form drag-and-drop (§3.4), to keep this pass's build small while still proving the core "several plugins compose on one screen" mechanism; drag/resize deferred (§5).
- **Where the dashboard's widget list persists** — resolved server-side JSON file (§3.5), consistent across browsers/tabs on the same machine, over browser `localStorage`, which would reset per-browser.
- **Backward compatibility of the manifest schema** — resolved via an optional `kind` field defaulting to `"panel"` (§3.2), so every plugin installed under the 2026-08-26 spec keeps working unmodified; no migration step, no version bump to `tetherApiVersion`.
