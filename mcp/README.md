# trail-mcp

An MCP server that lets coding agents — Claude Code, Cursor, Windsurf, or any
MCP-capable client — stream their work into **Trail** as traces.

The agent authenticates with a Trail API key pair and calls five tools; every
call becomes a span with Trail's `gen_ai.*` semantics, so runs appear across
the existing UI with **zero UI changes**:

| What the agent logs        | Where it shows in Trail                          |
| -------------------------- | ------------------------------------------------ |
| `trail_start_run` / `trail_finish_run` | Observations → Tracing (root agent span, full tree) + Analytics → Agents (runs) |
| `trail_log_step` (task / tool)         | Trace tree steps + Agents → Tools leaderboard    |
| `trail_log_llm_call`                   | LLM analytics (tokens, cost) + span I/O panel    |
| `trail_log_exception` / `status: error` | Observations → Exceptions                        |

## Install

```bash
cd mcp
npm install
npm run build
```

## Test

```bash
npm run build
npm test
```

## Configure your coding agent

Generate an API key pair in Trail (**Settings → API Keys**), then register the
server with your client.

**Claude Code**

```bash
claude mcp add trail \
  -e TRAIL_URL=https://trail.buildai.sa/api/sdk/v1 \
  -e TRAIL_PUBLIC_KEY=pk-... \
  -e TRAIL_SECRET_KEY=sk-... \
  -e TRAIL_APP=claude-code \
  -- node /absolute/path/to/mcp/dist/index.js
```

**Cursor / Windsurf** (`.cursor/mcp.json` or the equivalent):

```json
{
  "mcpServers": {
    "trail": {
      "command": "node",
      "args": ["/absolute/path/to/mcp/dist/index.js"],
      "env": {
        "TRAIL_URL": "https://trail.buildai.sa/api/sdk/v1",
        "TRAIL_PUBLIC_KEY": "pk-...",
        "TRAIL_SECRET_KEY": "sk-...",
        "TRAIL_APP": "cursor"
      }
    }
  }
}
```

Environment variables:

| Var                | Required | Meaning                                     |
| ------------------ | -------- | ------------------------------------------- |
| `TRAIL_URL`        | yes      | Trail SDK base URL, ends in `/api/sdk/v1`   |
| `TRAIL_PUBLIC_KEY` | yes      | From Settings → API Keys                    |
| `TRAIL_SECRET_KEY` | yes      | From Settings → API Keys                    |
| `TRAIL_APP`        | no       | Service/agent name in the UI (`coding-agent`) |
| `TRAIL_ENV`        | no       | Environment tag (`default`)                 |
| `TRAIL_JUDGE_PROVIDER` | no   | LLM provider for the goal-attainment judge — only `openai` supported today |
| `TRAIL_JUDGE_API_KEY`  | no   | API key for the judge provider              |
| `TRAIL_JUDGE_MODEL`    | no   | Judge model id, default `gpt-4o-mini`       |
| `TRAIL_JUDGE_BASE_URL` | no   | OpenAI-compatible base URL, default `https://api.openai.com/v1` — also works with Azure OpenAI, OpenRouter, LiteLLM proxies, local vLLM/Ollama, etc. |

## Make the agent actually use it

Add an instruction to your agent's project rules (e.g. `CLAUDE.md` /
`.cursorrules`):

> At the start of every task, call `trail_start_run` with a short task name.
> Log each meaningful action with `trail_log_step` (kind `tool` for commands
> and file edits, `task` for planning/analysis), every model call with
> `trail_log_llm_call`, and failures with `trail_log_exception`. When the task
> completes, call `trail_finish_run` with a one-line summary.

## Notes

- Spans are sent immediately per tool call over HTTPS; the root agent span is
  emitted by `trail_finish_run` with the run's total duration.
- Auth failures surface as tool errors in the agent, so a bad key is visible
  instead of silently dropping traces.
- Run state is in-memory per MCP session; one session can hold multiple
  concurrent runs (each `trail_start_run` returns its own `run_id`).
- Judging runs synchronously when `trail_finish_run` is called, only when
  both `TRAIL_JUDGE_PROVIDER`/`TRAIL_JUDGE_API_KEY` are set AND a `summary`
  was provided; it fails open (a judge problem never blocks or errors the
  run); it bills to whatever `TRAIL_JUDGE_API_KEY` is configured with, not
  Trail's own budget. The judge receives the goal, outcome summary, and the
  run's automatically-recorded step count, error count, and status as
  evidence — sent as a separate, trusted message from the agent-authored
  goal/outcome text.
