/**
 * Goal-attainment judge for Trail's MCP server. Fetch-based, no new
 * dependencies — mirrors otlp.ts's use of the global fetch instead of a
 * provider SDK. Fails open on every error path: returns null, never throws
 * past its own boundary, so a judge outage can never block trail_finish_run.
 */

export interface JudgeConfig {
	provider: string;
	apiKey: string;
	model?: string;
	baseUrl?: string;
}

export interface Verdict {
	verdict: "met" | "partial" | "failed";
	score: number;
	narrative: string;
}

const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_MODEL = "gpt-4o-mini";

const SYSTEM_PROMPT = `You judge whether a coding agent's run achieved its stated goal.
Given the goal and a one-line outcome summary written by the agent itself, return STRICT JSON only, no other text:
{"verdict": "met" | "partial" | "failed", "score": <float 0.0-1.0, 1.0 = fully met>, "narrative": "<one sentence explaining the verdict>"}`;

function parseVerdict(raw: string): Verdict | null {
	try {
		const parsed = JSON.parse(raw);
		if (
			(parsed.verdict === "met" || parsed.verdict === "partial" || parsed.verdict === "failed") &&
			typeof parsed.score === "number" &&
			typeof parsed.narrative === "string"
		) {
			return { verdict: parsed.verdict, score: parsed.score, narrative: parsed.narrative };
		}
		return null;
	} catch {
		return null;
	}
}

async function judgeOpenAi(goal: string, outcome: string, cfg: JudgeConfig): Promise<Verdict | null> {
	const base = (cfg.baseUrl ?? DEFAULT_OPENAI_BASE_URL).replace(/\/$/, "");
	const res = await fetch(`${base}/chat/completions`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"Authorization": `Bearer ${cfg.apiKey}`,
		},
		body: JSON.stringify({
			model: cfg.model ?? DEFAULT_MODEL,
			response_format: { type: "json_object" },
			messages: [
				{ role: "system", content: SYSTEM_PROMPT },
				{ role: "user", content: `Goal: ${goal}\nOutcome: ${outcome}` },
			],
		}),
		signal: AbortSignal.timeout(15_000),
	});

	if (!res.ok) return null;
	const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
	const content = data.choices?.[0]?.message?.content;
	if (!content) return null;
	return parseVerdict(content);
}

export async function judgeGoalAttainment(
	goal: string,
	outcome: string,
	cfg: JudgeConfig,
): Promise<Verdict | null> {
	try {
		if (cfg.provider !== "openai") return null;
		return await judgeOpenAi(goal, outcome, cfg);
	} catch {
		return null;
	}
}
