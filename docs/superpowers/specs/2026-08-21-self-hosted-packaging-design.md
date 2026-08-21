# Trail — Self-Hosted Packaging Design Spec

- **Status:** Draft — scoping, not yet reviewed/approved
- **Date:** 2026-08-21
- **Scope:** How a developer installs and runs the OSS self-hosted product locally — install mechanism, process model, datastore, auth, and the changes this requires in the shared `mcp/` package. Implements the codebase-split decision from `docs/superpowers/specs/2026-08-21-oss-self-hosted-open-core-design.md` §4. Does not cover the UI itself (`docs/superpowers/specs/2026-08-07-agent-flight-recorder-design.md`, `docs/superpowers/specs/2026-08-21-agent-harness-visualization-design.md`) — this spec defines what those UIs run on top of.

---

## 1. Why this document exists

The open-core boundary spec decided the OSS product is a new, lightweight, standalone app — not a "community mode" flag on the existing Mongo/Express/Next.js enterprise stack — specifically so self-hosting doesn't require standing up infrastructure a single developer doesn't need. This spec makes that concrete: exactly how it installs, where data lives, and what changes the already-existing, already-OSS-published `mcp/` package needs to talk to it.

---

## 2. Deployment target: local-only, single developer

v1 targets one developer on one machine — not a shared team server. This is the smallest possible scope that proves the product; a shared/multi-user deployment mode is explicitly deferred to a later iteration once the local experience validates the UI (per the open-core spec's framing of OSS as a developer-adoption funnel, not a team-infra replacement).

## 3. Install & process model

- **Install: `npx`/npm**, not Docker. `npx <tool-name>` (final product name TBD — see open-core spec §6) starts a local HTTP server (ingestion + UI) and runs in the foreground, the same interaction pattern as `npx prisma studio` — a terminal tab stays open while it runs. Fits the existing Node/TS stack (`mcp/` and `sdk/typescript` are already npm-published), and is the lowest-friction path for the JS/TS-fluent developers most likely to be building agent harnesses.
- **Recommended (not required) nicety:** auto-open the UI in the developer's default browser on start, matching the zero-friction bar the rest of this design sets. A flag to suppress this (for CI/headless use) should exist but isn't the default.
- Docker packaging is explicitly deferred, not rejected — if self-hosters ask for it later, it can wrap the same npm package without changing anything else in this spec.

## 4. Datastore: embedded SQLite, global location

- **SQLite**, embedded in the same process — no separate DB server to install or manage. Chosen over in-memory-only (which would lose run history on process exit, undermining the "flight recorder" pitch of being able to inspect a run after the fact) and over heavier file-based alternatives (DuckDB, LevelDB) which aren't justified unless SQLite's query patterns prove insufficient for the timeline-scrubbing and cross-run aggregation use cases — no evidence of that yet.
- **Location: global**, not project-local — e.g. `~/.trail-flight-recorder/db.sqlite` via an OS-appropriate data-dir resolver (XDG on Linux, `~/Library/Application Support` on macOS, etc.). Every agent run on the machine lands in one place regardless of which repo/project it came from, matching the "one black box, always in the same place" framing decided earlier.
- **This one global file is what makes the harness spec's usage-analytics view (`docs/superpowers/specs/2026-08-21-agent-harness-visualization-design.md` §3.4) buildable without any additional packaging work** — querying "across all runs" is just a SQL query against the one file already described here, not a new capability this spec needs to add.

## 5. Schema requirement carried in from the harness spec

The harness visualization spec requires each run record to carry a manifest snapshot (skills/sub-agents/MCP servers captured at `trail_start_run` time — see that spec §3.1). This spec's job is only to confirm the datastore choice accommodates it: SQLite with a JSON column (or a normalized child table) for the manifest snapshot is sufficient; the original per-run step/tool-call data model from the 2026-08-07 Flight Recorder spec is unaffected. Exact schema (columns, indices) is implementation-plan detail, not decided here.

## 6. Auth: none, bound to localhost

The local server binds to `127.0.0.1` only — never `0.0.0.0` by default — and requires no API keys or login. There is no multi-tenant or org boundary to protect on a single local machine, so key provisioning (as Trail Cloud requires) would be pure friction with nothing to defend. If a later shared-server mode is built, it gets its own auth story then; this section applies to local-only v1 only.

## 7. Required change to `mcp/`

The existing MCP server (`mcp/src/index.ts`) currently calls `requireEnv("TRAIL_URL")`, `requireEnv("TRAIL_PUBLIC_KEY")`, `requireEnv("TRAIL_SECRET_KEY")` — hard requirements sized for Trail Cloud's multi-tenant, API-key-authenticated ingest. For local mode:
- `TRAIL_URL` should default to `http://localhost:<default-port>` when unset, rather than failing closed.
- `TRAIL_PUBLIC_KEY`/`TRAIL_SECRET_KEY` become optional — omitted entirely when talking to a local instance, since §6 establishes there's nothing to authenticate against.

This is a real code change to a package that's already shared with Trail Cloud users (`trailai-mcp` on npm), not new configuration — flagging it here so it lands in the implementation plan explicitly rather than being discovered mid-build. The change must not alter behavior for existing Cloud users who already set all three env vars.

## 8. Port

A fixed, documented default port, overridable via env var. Exact number is an implementation-time decision but should avoid colliding with common OTel collector ports (4317/4318) and common local dev-server ports (3000, 5173, 8080) that a developer running this alongside their own app is likely to already have in use.

---

## 9. Future consideration (v2): MCP Apps as an inline rendering surface

[MCP Apps](https://modelcontextprotocol.io/extensions/apps/overview) is an MCP extension letting a server declare a `ui://` resource that supporting hosts render inline, in a sandboxed iframe, as part of the conversation — with a bidirectional postMessage channel back to the server's tools. Applied here, it would mean `trail_finish_run` (or a dedicated tool) could render a compact run summary or the Flight Recorder timeline directly inside the chat, instead of the developer switching to a browser tab pointed at the local web UI this spec defines.

**Why it's a v2 idea, not part of this spec's v1:** client support is currently GUI hosts only — Claude Desktop, VS Code Copilot, M365 Copilot, Goose, Postman, and similar — not terminal/CLI clients. `mcp/`'s own doc comment targets "coding agents (Claude Code, Cursor, Windsurf, …)," and a meaningful share of that audience runs headless or in a terminal, where there's no iframe to render into. MCP Apps therefore can't replace the local web UI (§3) as the primary delivery surface — CLI/headless users still need it — but it's a real candidate for a **complementary** inline surface once a GUI host is in the loop, sourced from the same local server and datastore this spec already defines (no new backend, just a new `ui://`-declaring view on top of the existing local HTTP server).

Not scoped further here — revisit once v1 (this spec) ships and the local web UI has proven the underlying data model.

## 10. Explicitly out of scope for this spec

- Shared/team-server deployment mode (bind address, auth, upgrade story for multiple concurrent developers) — deferred per §2.
- Docker packaging — deferred per §3, not rejected.
- Exact SQLite schema (tables, columns, indices) — implementation-plan detail.
- The UI itself and its component/layout design — covered by the Flight Recorder and Harness Visualization specs.
- Final product name and default port number — small decisions left for implementation time, not architectural.
- MCP Apps integration (§9) — noted as a future direction, not designed here.

## 11. Open items requiring verification before implementation

- Confirm no existing Trail Cloud MCP users would break under a `TRAIL_URL` default — today `requireEnv` fails loudly if unset, so any change to "default instead of require" must not silently point an existing Cloud integration at `localhost` if `TRAIL_URL` was previously required and always explicitly set. Needs a check of whether any deployed integration currently relies on the fail-closed behavior for validation purposes.
- Confirm an OS-appropriate data-dir resolution approach (e.g. an existing small npm dependency vs. hand-rolled) fits the "no new dependencies" bar noted elsewhere in this codebase's conventions (`docs/superpowers/plans/2026-08-09-flight-recorder-followups.md` states "No new dependencies... in any package touched" as a working norm) — may need discussion if the cleanest solution requires adding one.
