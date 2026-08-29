/**
 * Trail MCP server core: the McpServer factory, per-run state, and the pure
 * span-building functions the 5 registered tools use. Kept separate from
 * index.ts (the process entrypoint) so this file can be imported by tests
 * without triggering index.ts's stdio transport connection.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { TrailConfig, SpanInput, hexId, nowNanos, sendSpan } from "./otlp.js";
import { buildHarnessManifest, HarnessManifest } from "./manifest.js";
import { judgeGoalAttainment, JudgeConfig, Verdict } from "./judge.js";

export interface Run {
	traceId: string;
	rootSpanId: string;
	name: string;
	agent: string;
	startNanos: string;
	steps: number;
	errors: number;
	manifest: HarnessManifest;
}

const ok = (text: string) => ({ content: [{ type: "text" as const, text }] });

// Accept common synonyms ("success"/"failed"/…) so a model that guesses at
// the value instead of reading the enum still lands on "ok" | "error".
const STATUS_ALIASES: Record<string, "ok" | "error"> = {
	ok: "ok",
	success: "ok",
	succeeded: "ok",
	pass: "ok",
	passed: "ok",
	error: "error",
	fail: "error",
	failed: "error",
	failure: "error",
};

const statusSchema = z
	.preprocess(
		(v) => (typeof v === "string" ? (STATUS_ALIASES[v.toLowerCase()] ?? v) : v),
		z.enum(["ok", "error"]),
	)
	.default("ok")
	.describe("Outcome: 'ok' or 'error' ('success'/'failed'/'failure'/'pass' etc. are also accepted)");

export function buildStepSpan(
	run: Pick<Run, "traceId" | "rootSpanId" | "agent">,
	spanId: string,
	start: string,
	end: string,
	args: {
		name: string;
		kind: "task" | "tool";
		input?: string;
		output?: string;
		status: "ok" | "error";
		error_message?: string;
		source_type?: "skill" | "sub_agent" | "mcp_server";
		source_name?: string;
	},
): SpanInput {
	const isError = args.status === "error";
	return {
		traceId: run.traceId,
		spanId,
		parentSpanId: run.rootSpanId,
		name: args.name,
		startTimeUnixNano: start,
		endTimeUnixNano: end,
		attributes: {
			"gen_ai.operation.name": args.kind === "tool" ? "execute_tool" : "execute_task",
			"gen_ai.system": "trail-mcp",
			"gen_ai.agent.name": run.agent,
			...(args.kind === "tool" ? { "gen_ai.tool.name": args.name } : {}),
			...(args.source_type && args.source_name ? { "gen_ai.harness.source_type": args.source_type, "gen_ai.harness.source_name": args.source_name } : {}),
		},
		events: [
			...(args.input ? [{ name: "gen_ai.content.prompt", attributes: { "gen_ai.prompt": args.input } }] : []),
			...(args.output ? [{ name: "gen_ai.content.completion", attributes: { "gen_ai.completion": args.output } }] : []),
		],
		...(isError ? { error: { message: args.error_message ?? "step failed" } } : {}),
	};
}

export function buildLlmCallSpan(
	run: Pick<Run, "traceId" | "rootSpanId" | "agent">,
	spanId: string,
	start: string,
	end: string,
	args: {
		model: string;
		prompt?: string;
		completion?: string;
		input_tokens?: number;
		output_tokens?: number;
		cost_usd?: number;
		status: "ok" | "error";
		error_message?: string;
	},
): SpanInput {
	const isError = args.status === "error";
	const total =
		args.input_tokens !== undefined || args.output_tokens !== undefined
			? (args.input_tokens ?? 0) + (args.output_tokens ?? 0)
			: undefined;
	return {
		traceId: run.traceId,
		spanId,
		parentSpanId: run.rootSpanId,
		name: `chat ${args.model}`,
		startTimeUnixNano: start,
		endTimeUnixNano: end,
		attributes: {
			"gen_ai.operation.name": "chat",
			"gen_ai.system": "trail-mcp",
			"gen_ai.agent.name": run.agent,
			"gen_ai.request.model": args.model,
			"gen_ai.usage.input_tokens": args.input_tokens,
			"gen_ai.usage.output_tokens": args.output_tokens,
			"gen_ai.usage.total_tokens": total,
			"gen_ai.usage.cost": args.cost_usd,
		},
		events: [
			...(args.prompt ? [{ name: "gen_ai.content.prompt", attributes: { "gen_ai.prompt": args.prompt } }] : []),
			...(args.completion ? [{ name: "gen_ai.content.completion", attributes: { "gen_ai.completion": args.completion } }] : []),
		],
		...(isError ? { error: { message: args.error_message ?? "llm call failed" } } : {}),
	};
}

export function buildExceptionSpan(
	run: Pick<Run, "traceId" | "rootSpanId" | "agent">,
	spanId: string,
	end: string,
	args: { message: string; type?: string; name?: string },
): SpanInput {
	return {
		traceId: run.traceId,
		spanId,
		parentSpanId: run.rootSpanId,
		name: args.name ?? "exception",
		startTimeUnixNano: end,
		endTimeUnixNano: end,
		attributes: {
			"gen_ai.operation.name": "execute_task",
			"gen_ai.system": "trail-mcp",
			"gen_ai.agent.name": run.agent,
		},
		error: { message: args.message, type: args.type },
	};
}

export function buildTrailServer(cfg: TrailConfig, judgeCfg: JudgeConfig | undefined): McpServer {
	const runs = new Map<string, Run>();

	function getRun(runId: string): Run {
		const run = runs.get(runId);
		if (!run) throw new Error(`Unknown run_id "${runId}" — call trail_start_run first.`);
		return run;
	}

	const server = new McpServer({ name: "trail", version: "0.2.0" });

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
			const rootDir = process.env.TRAIL_PROJECT_ROOT ?? process.cwd();
			runs.set(runId, {
				traceId: hexId(16),
				rootSpanId: hexId(8),
				name,
				agent: agent ?? cfg.serviceName,
				startNanos: nowNanos(),
				steps: 0,
				errors: 0,
				manifest: buildHarnessManifest(rootDir),
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
				status: statusSchema,
				error_message: z.string().optional(),
				duration_ms: z.number().optional().describe("How long the step took (defaults to instant)"),
				source_type: z.enum(["skill", "sub_agent", "mcp_server"]).optional()
					.describe("If this step came from a registered skill, sub-agent, or MCP server, which kind"),
				source_name: z.string().optional()
					.describe("Name of the skill/sub-agent/MCP server, matching an entry from this run's harness manifest"),
			},
		},
		async ({ run_id, name, kind, input, output, status, error_message, duration_ms, source_type, source_name }) => {
			const run = getRun(run_id);
			const end = nowNanos();
			const start = duration_ms
				? (BigInt(end) - BigInt(Math.round(duration_ms)) * 1_000_000n).toString()
				: end;
			const isError = status === "error";
			run.steps += 1;
			if (isError) run.errors += 1;
			await sendSpan(cfg, buildStepSpan(run, hexId(8), start, end, { name, kind, input, output, status, error_message, source_type, source_name }));
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
				status: statusSchema,
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
			await sendSpan(cfg, buildLlmCallSpan(run, hexId(8), start, end, { model, prompt, completion, input_tokens, output_tokens, cost_usd, status, error_message }));
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
			await sendSpan(cfg, buildExceptionSpan(run, hexId(8), end, { message, type, name }));
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
				status: statusSchema,
				summary: z.string().optional().describe("One-line outcome, shown as the run's output"),
			},
		},
		async ({ run_id, status, summary }) => {
			const run = getRun(run_id);
			let verdict: Verdict | null = null;
			if (judgeCfg && summary && run.name) {
				const evidence = `Steps: ${run.steps}, errors: ${run.errors}`;
				const outcomeWithStatus = `${summary}\nAgent-reported status: ${status}`;
				verdict = await judgeGoalAttainment(run.name, outcomeWithStatus, evidence, judgeCfg);
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
					"gen_ai.agent.harness_manifest": JSON.stringify(run.manifest),
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

	return server;
}
