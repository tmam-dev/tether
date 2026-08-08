#!/usr/bin/env node
/**
 * Trail MCP server — lets coding agents (Claude Code, Cursor, Windsurf, …)
 * stream their work into Trail as traces.
 *
 * The agent authenticates with a Trail API key pair (env vars) and calls
 * these tools; each call becomes a span with Trail's gen_ai.* semantics, so
 * runs appear in Observations → Tracing (full tree), errors in Exceptions,
 * and agent/tool rollups in Analytics → Agents — no UI changes required.
 *
 * Tools:
 *   trail_start_run      begin a run (returns run_id)
 *   trail_log_step       record a task or tool step
 *   trail_log_llm_call   record an LLM call with prompt/completion + usage
 *   trail_log_exception  record a failure (shows in Exceptions)
 *   trail_finish_run     close the run (emits the root agent span)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { TrailConfig, hexId, nowNanos, sendSpan } from "./otlp.js";
import { judgeGoalAttainment, JudgeConfig, Verdict } from "./judge.js";

// ---------------------------------------------------------------- config
function requireEnv(name: string): string {
	const v = process.env[name];
	if (!v) {
		console.error(`trail-mcp: missing required env var ${name}`);
		process.exit(1);
	}
	return v;
}

const cfg: TrailConfig = {
	url: requireEnv("TRAIL_URL"),
	publicKey: requireEnv("TRAIL_PUBLIC_KEY"),
	secretKey: requireEnv("TRAIL_SECRET_KEY"),
	environment: process.env.TRAIL_ENV ?? "default",
	serviceName: process.env.TRAIL_APP ?? "coding-agent",
};

const judgeCfg: JudgeConfig | undefined =
	process.env.TRAIL_JUDGE_PROVIDER && process.env.TRAIL_JUDGE_API_KEY
		? {
				provider: process.env.TRAIL_JUDGE_PROVIDER,
				apiKey: process.env.TRAIL_JUDGE_API_KEY,
				model: process.env.TRAIL_JUDGE_MODEL,
				baseUrl: process.env.TRAIL_JUDGE_BASE_URL,
			}
		: undefined;

// ---------------------------------------------------------------- run state
interface Run {
	traceId: string;
	rootSpanId: string;
	name: string;
	agent: string;
	startNanos: string;
	steps: number;
	errors: number;
}

const runs = new Map<string, Run>();

function getRun(runId: string): Run {
	const run = runs.get(runId);
	if (!run) throw new Error(`Unknown run_id "${runId}" — call trail_start_run first.`);
	return run;
}

const ok = (text: string) => ({ content: [{ type: "text" as const, text }] });

// ---------------------------------------------------------------- server
const server = new McpServer({ name: "trail", version: "0.1.0" });

server.registerTool(
	"trail_start_run",
	{
		title: "Start a Trail run",
		description:
			"Begin a traced run in Trail. Returns a run_id to pass to the other trail_* tools. " +
			"Call once at the start of a coding task.",
		inputSchema: {
			name: z.string().describe("Short name of the task, e.g. 'fix flaky auth test'"),
			agent: z.string().optional().describe("Agent name shown in analytics (default: coding-agent)"),
		},
	},
	async ({ name, agent }) => {
		const runId = hexId(8);
		runs.set(runId, {
			traceId: hexId(16),
			rootSpanId: hexId(8),
			name,
			agent: agent ?? cfg.serviceName,
			startNanos: nowNanos(),
			steps: 0,
			errors: 0,
		});
		return ok(`run started: run_id=${runId}. Log steps with trail_log_step / trail_log_llm_call, finish with trail_finish_run.`);
	},
);

server.registerTool(
	"trail_log_step",
	{
		title: "Log a step",
		description:
			"Record one unit of work in the run — a task (planning, editing, running tests) or a tool call " +
			"(shell command, file read, search). Appears in the trace tree and Agent analytics.",
		inputSchema: {
			run_id: z.string(),
			name: z.string().describe("Step name, e.g. 'run pytest' or 'edit auth.py'"),
			kind: z.enum(["task", "tool"]).describe("task = reasoning/work unit, tool = external action"),
			input: z.string().optional().describe("What went in (command, arguments, file path…)"),
			output: z.string().optional().describe("What came out (truncated result, diff summary…)"),
			status: z.enum(["ok", "error"]).default("ok"),
			error_message: z.string().optional(),
			duration_ms: z.number().optional().describe("How long the step took (defaults to instant)"),
		},
	},
	async ({ run_id, name, kind, input, output, status, error_message, duration_ms }) => {
		const run = getRun(run_id);
		const end = nowNanos();
		const start = duration_ms
			? (BigInt(end) - BigInt(Math.round(duration_ms)) * 1_000_000n).toString()
			: end;
		const isError = status === "error";
		run.steps += 1;
		if (isError) run.errors += 1;

		await sendSpan(cfg, {
			traceId: run.traceId,
			spanId: hexId(8),
			parentSpanId: run.rootSpanId,
			name,
			startTimeUnixNano: start,
			endTimeUnixNano: end,
			attributes: {
				"gen_ai.operation.name": kind === "tool" ? "execute_tool" : "execute_task",
				"gen_ai.system": "trail-mcp",
				"gen_ai.agent.name": run.agent,
				...(kind === "tool" ? { "gen_ai.tool.name": name } : {}),
			},
			events: [
				...(input ? [{ name: "gen_ai.content.prompt", attributes: { "gen_ai.prompt": input } }] : []),
				...(output ? [{ name: "gen_ai.content.completion", attributes: { "gen_ai.completion": output } }] : []),
			],
			...(isError ? { error: { message: error_message ?? "step failed" } } : {}),
		});
		return ok(`step logged (${kind}${isError ? ", error" : ""})`);
	},
);

server.registerTool(
	"trail_log_llm_call",
	{
		title: "Log an LLM call",
		description:
			"Record an LLM request made during the run, with prompt, completion, model, token usage and cost. " +
			"Feeds LLM analytics (tokens, cost) and the trace I/O panel.",
		inputSchema: {
			run_id: z.string(),
			model: z.string().describe("Model id, e.g. 'claude-sonnet-4-5' or 'gpt-4o-mini'"),
			prompt: z.string().optional(),
			completion: z.string().optional(),
			input_tokens: z.number().optional(),
			output_tokens: z.number().optional(),
			cost_usd: z.number().optional(),
			duration_ms: z.number().optional(),
			status: z.enum(["ok", "error"]).default("ok"),
			error_message: z.string().optional(),
		},
	},
	async ({ run_id, model, prompt, completion, input_tokens, output_tokens, cost_usd, duration_ms, status, error_message }) => {
		const run = getRun(run_id);
		const end = nowNanos();
		const start = duration_ms
			? (BigInt(end) - BigInt(Math.round(duration_ms)) * 1_000_000n).toString()
			: end;
		const isError = status === "error";
		run.steps += 1;
		if (isError) run.errors += 1;
		const total =
			input_tokens !== undefined || output_tokens !== undefined
				? (input_tokens ?? 0) + (output_tokens ?? 0)
				: undefined;

		await sendSpan(cfg, {
			traceId: run.traceId,
			spanId: hexId(8),
			parentSpanId: run.rootSpanId,
			name: `chat ${model}`,
			startTimeUnixNano: start,
			endTimeUnixNano: end,
			attributes: {
				"gen_ai.operation.name": "chat",
				"gen_ai.system": "trail-mcp",
				"gen_ai.agent.name": run.agent,
				"gen_ai.request.model": model,
				"gen_ai.usage.input_tokens": input_tokens,
				"gen_ai.usage.output_tokens": output_tokens,
				"gen_ai.usage.total_tokens": total,
				"gen_ai.usage.cost": cost_usd,
			},
			events: [
				...(prompt ? [{ name: "gen_ai.content.prompt", attributes: { "gen_ai.prompt": prompt } }] : []),
				...(completion ? [{ name: "gen_ai.content.completion", attributes: { "gen_ai.completion": completion } }] : []),
			],
			...(isError ? { error: { message: error_message ?? "llm call failed" } } : {}),
		});
		return ok(`llm call logged (${model}${isError ? ", error" : ""})`);
	},
);

server.registerTool(
	"trail_log_exception",
	{
		title: "Log an exception",
		description:
			"Record a failure in the run — build break, test failure, unhandled error. " +
			"Shows under Observations → Exceptions with the message and type.",
		inputSchema: {
			run_id: z.string(),
			message: z.string(),
			type: z.string().optional().describe("e.g. 'BuildError', 'TestFailure'"),
			name: z.string().optional().describe("Span name (default 'exception')"),
		},
	},
	async ({ run_id, message, type, name }) => {
		const run = getRun(run_id);
		run.steps += 1;
		run.errors += 1;
		const end = nowNanos();
		await sendSpan(cfg, {
			traceId: run.traceId,
			spanId: hexId(8),
			parentSpanId: run.rootSpanId,
			name: name ?? "exception",
			startTimeUnixNano: end,
			endTimeUnixNano: end,
			attributes: {
				"gen_ai.operation.name": "execute_task",
				"gen_ai.system": "trail-mcp",
				"gen_ai.agent.name": run.agent,
			},
			error: { message, type },
		});
		return ok("exception logged");
	},
);

server.registerTool(
	"trail_finish_run",
	{
		title: "Finish the run",
		description:
			"Close the run and emit the root agent span with total duration. Call once when the task is done.",
		inputSchema: {
			run_id: z.string(),
			status: z.enum(["ok", "error"]).default("ok"),
			summary: z.string().optional().describe("One-line outcome, shown as the run's output"),
		},
	},
	async ({ run_id, status, summary }) => {
		const run = getRun(run_id);
		let verdict: Verdict | null = null;
		if (judgeCfg && summary && run.name) {
			try {
				const evidence = `Steps: ${run.steps}, errors: ${run.errors}`;
				verdict = await judgeGoalAttainment(run.name, summary, evidence, judgeCfg);
			} catch {
				verdict = null; // fail open — a judge exception must never block the run from finishing
			}
		}
		await sendSpan(cfg, {
			traceId: run.traceId,
			spanId: run.rootSpanId,
			name: run.name,
			startTimeUnixNano: run.startNanos,
			endTimeUnixNano: nowNanos(),
			attributes: {
				"gen_ai.operation.name": "agent",
				"gen_ai.system": "trail-mcp",
				"gen_ai.agent.name": run.agent,
				"gen_ai.agent.goal": run.name,
				...(verdict
					? {
							"gen_ai.agent.verdict": verdict.verdict,
							"gen_ai.agent.verdict_score": verdict.score,
							"gen_ai.agent.verdict_narrative": verdict.narrative,
						}
					: {}),
			},
			events: summary
				? [{ name: "gen_ai.content.completion", attributes: { "gen_ai.completion": summary } }]
				: [],
			...(status === "error" ? { error: { message: summary ?? "run failed" } } : {}),
		});
		runs.delete(run_id);
		return ok(`run finished: ${run.steps} steps, ${run.errors} errors — view it in Observations → Tracing`);
	},
);

// ---------------------------------------------------------------- start
const transport = new StdioServerTransport();
await server.connect(transport);
console.error("trail-mcp ready (stdio)");
