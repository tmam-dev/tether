# Tether

Agent harness observability — self-hosted and open-source.

Tether shows what a coding-agent harness (skills, sub-agents, MCP servers) has
available and what it actually did on a run, so a developer can inspect an
agent's work after the fact instead of losing track of it — hence the name.

## Status

Pre-implementation. This repo currently holds only licensing scaffolding;
the actual local self-hosted app (install, datastore, UI) hasn't been built
yet. Private for now — visibility will change once there's something real to
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
