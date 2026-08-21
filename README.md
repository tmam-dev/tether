# Tether

Agent harness observability — self-hosted and open-source.

Tether shows what a coding-agent harness (skills, sub-agents, MCP servers) has
available and what it actually did on a run, so a developer can inspect an
agent's work after the fact instead of losing track of it — hence the name.

## Status

The local server (`npx trailai-tether` — install, SQLite storage, OTLP
ingestion) is built; see [`server/README.md`](server/README.md) and
[`mcp/README.md`](mcp/README.md) for details. The real Flight Recorder UI
(run timeline, goal-attainment verdict, harness anatomy) is still ahead —
today's server only serves a placeholder page confirming it's running.
Private for now — visibility will change once there's something real to
show.

## Relationship to Trail

Tether is a sibling project to [Trail](https://trailai.dev), an AI
observability platform — same team, same underlying instrumentation
(OpenTelemetry `gen_ai.*` semantics, the same MCP server harnesses already
use to report into Trail). Trail is the sales-led enterprise product; Tether
is the free, self-hosted, developer-adoption path, scoped narrowly to agent
harness observability rather than Trail's full guardrails/evaluations/vault
feature set.

## License

Apache-2.0 — see [LICENSE](LICENSE).
