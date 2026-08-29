# Tether — Plugin Registry Mechanics

- **Status:** Approved design — all mechanics questions are resolved as of
  2026-08-29. This went through this repo's clarifying-questions →
  approved-design flow; what follows is a committed spec, not a draft
  position. Next step is an implementation plan (see the writing-plans
  skill), not further discussion of the mechanics themselves.
- **Scope:** How third-party plugins get discovered and installed beyond
  today's "you already know the git URL" model — not the plugin execution
  model itself (shipped, see the 2026-08-26 plugin-view-system spec) and
  not the analytics widget dashboard (shipped separately, see the
  2026-08-29 widget-dashboard spec). No `mcp/` involvement — the registry
  is entirely a `server/` concern (CLI + web UI); a coding agent does not
  discover or install plugins through MCP.
- **Fully decided:** the index lives in this repo, keyed by a
  `schemaVersion` (§3); the fetch mechanism is the hybrid, TTL-cached
  refresh (§3); the entry schema is a minimal pointer shape (§3.1); no MCP
  involvement (above); the in-app browse UI is built now, not deferred
  (§5); listing removal is PR-only, no soft-delete (§7).

---

## 1. Why

Tether's plugin system (shipped) lets a developer replace a view slot or
add a widget with third-party code — but only if they already know which
git repo to point `plugin add` at. There is no listing, no search, no way
to discover what exists. For a plugin ecosystem to function as a growth
lever for Tether (the OSS on-ramp to Trail, the paid enterprise sibling —
see this repo's `CLAUDE.md`), discovery has to exist somewhere.

The original plugin-view-system spec explicitly deferred this ("discovery
... happens on GitHub/a docs page, not inside Tether" — §3.2) and named
in-app browsing as a future spec. This is that spec.

## 2. The core design question: who hosts the code?

Two structurally different models came up, and the brainstorm's central
finding is that they trade off very differently:

- **Index-only (favored in the brainstorm):** a plugin author hosts and
  owns their own repo. Tether's repo carries only a small index — one
  entry per plugin (name, repo URL, slug, description, which slot/kind it
  targets) — added via a community pull request. Tether never clones the
  plugin's source into its own repo, never takes on maintaining it. This
  is the Homebrew-tap / VS-Code-marketplace-index pattern, and it's the
  only one that doesn't quietly abandon the "no Tether-run backend, no
  hosted service" pitch that's load-bearing for the whole project (see
  `server/README.md` and the plugin-view-system spec's §1).
- **Vendored/hosted:** Tether's own repo (or team) takes ownership of a
  plugin's actual code — closer to how Homebrew's `homebrew-core` formulas
  work, or how WordPress.org hosts plugin code via SVN. This buys a real
  trust signal (Tether's team reviewed and maintains this specific code)
  but costs ongoing maintenance per plugin adopted — every future API
  change means fixing N vendored plugins, not just N index listings.

**Working position from the brainstorm:** index-only is the default,
general-purpose contribution path. Vendoring is reserved for a small,
deliberately narrow set of cases — specifically integrations that handle
outbound credentials (Slack/webhook/third-party-service connectors), where
"Tether's team reviewed and owns this" is a real trust upgrade worth the
maintenance cost. This was explicitly NOT settled as "vendoring is the
primary path" — the brainstorm confirmed index-only as primary before
being paused.

## 3. Where the index lives and how it's fetched — DECIDED

The index is a file — tentatively `registry/plugins.json` — living in
**this repo**, not a separate registry repo. Community contribution is a
pull request adding one entry; a maintainer reviews and merges it directly
into this repo, so a listing lives (and is visible) alongside the rest of
the project.

**Fetch mechanism: hybrid.** A snapshot of the registry file ships bundled
in the `trailai-tether` npm package for offline/first-run use (so the
feature never hard-depends on network access, consistent with Tether's
"no install beyond Node" pitch), and the CLI/server opportunistically
refreshes it live from a CDN-fronted static URL (e.g. jsdelivr against
this repo) when online — so a merged PR becomes visible without waiting
on the next npm release, while a disconnected user still sees whatever
was bundled at their last install/upgrade.

**Refresh cadence — DECIDED: TTL-cached background refresh.** Any
registry-touching action (opening the browse UI, running `plugin add`)
checks a cached last-fetched timestamp; if it's older than 24h, a live
refetch from the CDN URL kicks off in the background and the currently
cached copy is served for that call. This never blocks on network and
never fetches more than once a day per install — a merged PR is visible
to a given install within a day, without needing an explicit
"refresh" command or paying a network round-trip on every invocation.

## 3.1. Registry entry schema — DECIDED

`registry/plugins.json` is `{ schemaVersion: 1, entries: [...] }`. Each
entry is a minimal pointer, not a rich catalog record:

```json
{
  "name": "Waterfall Timeline",
  "slug": "waterfall-timeline",
  "repo": "https://github.com/example/tether-plugin-waterfall",
  "description": "Renders a run's spans as a waterfall/timeline view.",
  "kind": "view",
  "slot": "detail"
}
```

- `kind` is `"view"` or `"widget"`; `slot` (`"detail"` | `"harness"` |
  `"analytics"`) applies only to `kind: "view"` entries.
- No author, screenshots, version pin, or category fields — those live in
  the plugin's own `tether-plugin.json` and README, not the index. Keeping
  the index this thin keeps a review PR small and keeps the index from
  going stale relative to the plugin's own metadata.
- The top-level `schemaVersion` lets richer fields (icon, category,
  min-Tether-version) be added later as a version bump, without a breaking
  migration for existing tooling that reads the current shape.

## 4. Review process for a registry entry

Two review models were discussed, differing in how much trust the listing
implies:

- **Lightweight (leaned toward):** CI validates the PR's entry — required
  fields present, the linked repo resolves, `tether-plugin.json` is valid
  at that repo's root, `replaces`/`kind` is a legal value. A maintainer
  does a brief sanity look at the linked repo before merging — not a
  security audit. The catalog UI should say "listed," not "reviewed" or
  "verified," so nobody over-trusts an index entry the way they might a
  vendored (§2) integration.
- **Heavyweight (WordPress.org's actual model, raised as a comparison, not
  adopted):** a real human security review of a plugin's *code* before
  first listing. This only makes sense if Tether also hosts that code
  (§2's vendored model) — reviewing code you don't host and can't re-audit
  on every update is a weaker guarantee to make to users, and heavier than
  this project's team size can sustain generally.

## 5. Discovery UX — DECIDED

The in-app "Browse plugins" view is built now, alongside the registry
mechanics themselves, rather than deferred until there's more listing
volume — launching with an empty-feeling marketplace (even with the 3
seed plugins) undercuts the pitch worse than the UI work costs. It
extends the existing per-slot `<select>` picker (and the widget
dashboard's "Add widget" picker) into a small catalog view: list registry
entries not yet installed, with an "Install" button that runs the
existing `plugin add` logic server-side. This is explicitly more scope
than the original plugin-view-system spec deferred ("in-app marketplace
browsing/install UI" was named out of scope there) — this spec is what
picks that back up.

## 6. OSS (Tether) vs. Enterprise (Trail) boundary

Per this repo's standing practice of evaluating every extensibility
decision against the OSS-to-enterprise funnel (Tether is Trail's
go-to-market, not a separate product — see `CLAUDE.md`):

**Stays in Tether (free):** the index mechanism itself, community
contribution via PR, the fetch/discovery UX, and lightweight CI
validation. This is pure adoption fuel — paywalling the mechanism defeats
the point of an OSS ecosystem.

**Belongs in Trail (paid), if/when built:** vendored/"certified"
integrations with an SLA-backed trust guarantee (§2's exception case);
multi-user governance (org-wide allowlists, "which plugins can my team
install"); a private/internal-only registry for a company's own plugins;
cross-team plugin-usage analytics; and a paid marketplace with
billing/payouts if authors ever want to charge — keeping Tether's own
registry free and payments-free avoids taking on regulatory/infra weight
an OSS project shouldn't carry.

## 7. Listing removal — DECIDED

Removal is pure PR mechanism, the same path as adding an entry: a PR
deletes the entry from `registry/plugins.json`, reviewed the same way a
new listing would be — an author request, a maintainer acting on
abandonment, or a maintainer acting on a reported problem, all go through
this one path. There is no `status` field or soft-delete state; the index
only ever reflects what's currently installable, and history of removed
entries lives in this repo's git log, not in the live index. This keeps
the index's runtime shape (§3.1) simple and avoids maintaining a
deprecation lifecycle for something expected to be rare.

## 8. Related work

- `docs/superpowers/specs/2026-08-26-plugin-view-system-design.md` — the
  shipped plugin execution model (manifest, install, iframe trust model)
  this spec builds discovery on top of.
- `docs/superpowers/specs/2026-08-29-analytics-widget-dashboard-design.md`
  — a separate, already-shipped feature from the same brainstorming
  session (the "which plugins should Tether build first" thread), not to
  be confused with this registry-mechanics thread.
