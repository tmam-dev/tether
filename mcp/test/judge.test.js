import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { judgeGoalAttainment } from "../dist/judge.js";

const CFG = { provider: "openai", apiKey: "test-key" };

function stubFetch(impl) {
	const original = globalThis.fetch;
	globalThis.fetch = impl;
	return () => {
		globalThis.fetch = original;
	};
}

function okResponse(content) {
	return {
		ok: true,
		json: async () => ({ choices: [{ message: { content } }] }),
	};
}

describe("judgeGoalAttainment", () => {
	test("returns null immediately for an unsupported provider, without calling fetch", async () => {
		let called = false;
		const restore = stubFetch(async () => {
			called = true;
			return okResponse(JSON.stringify({ verdict: "met", score: 1, narrative: "ok" }));
		});
		try {
			const verdict = await judgeGoalAttainment("goal", "outcome", "evidence", {
				provider: "anthropic",
				apiKey: "test-key",
			});
			assert.equal(verdict, null);
			assert.equal(called, false);
		} finally {
			restore();
		}
	});

	test("parses a valid verdict on the happy path", async () => {
		const restore = stubFetch(async () =>
			okResponse(JSON.stringify({ verdict: "partial", score: 0.5, narrative: "half done" })),
		);
		try {
			const verdict = await judgeGoalAttainment("goal", "outcome", "evidence", CFG);
			assert.deepEqual(verdict, { verdict: "partial", score: 0.5, narrative: "half done" });
		} finally {
			restore();
		}
	});

	test("sends goal and outcome (not evidence) in the user message, delimiter-tagged", async () => {
		let sentBody;
		const restore = stubFetch(async (_url, init) => {
			sentBody = JSON.parse(init.body);
			return okResponse(JSON.stringify({ verdict: "met", score: 1, narrative: "ok" }));
		});
		try {
			await judgeGoalAttainment("Ship the feature", "Shipped it", "Steps: 4, errors: 0", CFG);
			const userMessage = sentBody.messages.find((m) => m.role === "user").content;
			assert.equal(userMessage, "<goal>Ship the feature</goal>\n<outcome>Shipped it</outcome>");
		} finally {
			restore();
		}
	});

	test("sends evidence in its own system message, separate from goal/outcome", async () => {
		let sentBody;
		const restore = stubFetch(async (_url, init) => {
			sentBody = JSON.parse(init.body);
			return okResponse(JSON.stringify({ verdict: "met", score: 1, narrative: "ok" }));
		});
		try {
			await judgeGoalAttainment("Ship the feature", "Shipped it", "Steps: 4, errors: 0", CFG);
			const systemMessages = sentBody.messages.filter((m) => m.role === "system");
			assert.equal(systemMessages.length, 2);
			assert.equal(systemMessages[1].content, "<evidence>Steps: 4, errors: 0</evidence>");
		} finally {
			restore();
		}
	});

	test("instructs the judge to treat goal/outcome as untrusted claims and weigh the evidence", async () => {
		let sentBody;
		const restore = stubFetch(async (_url, init) => {
			sentBody = JSON.parse(init.body);
			return okResponse(JSON.stringify({ verdict: "met", score: 1, narrative: "ok" }));
		});
		try {
			await judgeGoalAttainment("goal", "outcome", "evidence", CFG);
			const systemMessage = sentBody.messages.find((m) => m.role === "system").content;
			assert.match(systemMessage, /untrusted claims/);
			assert.match(systemMessage, /evidence/);
		} finally {
			restore();
		}
	});

	test("fails open when the HTTP response is not ok", async () => {
		const restore = stubFetch(async () => ({ ok: false, json: async () => ({}) }));
		try {
			const verdict = await judgeGoalAttainment("goal", "outcome", "evidence", CFG);
			assert.equal(verdict, null);
		} finally {
			restore();
		}
	});

	test("fails open when the response has no message content", async () => {
		const restore = stubFetch(async () => okResponse(undefined));
		try {
			const verdict = await judgeGoalAttainment("goal", "outcome", "evidence", CFG);
			assert.equal(verdict, null);
		} finally {
			restore();
		}
	});

	test("fails open when the message content is not valid JSON", async () => {
		const restore = stubFetch(async () => okResponse("not json"));
		try {
			const verdict = await judgeGoalAttainment("goal", "outcome", "evidence", CFG);
			assert.equal(verdict, null);
		} finally {
			restore();
		}
	});

	test("fails open when the parsed JSON has the wrong shape", async () => {
		const restore = stubFetch(async () =>
			okResponse(JSON.stringify({ verdict: "maybe", score: "high", narrative: 42 })),
		);
		try {
			const verdict = await judgeGoalAttainment("goal", "outcome", "evidence", CFG);
			assert.equal(verdict, null);
		} finally {
			restore();
		}
	});

	test("fails open when fetch throws", async () => {
		const restore = stubFetch(async () => {
			throw new Error("network down");
		});
		try {
			const verdict = await judgeGoalAttainment("goal", "outcome", "evidence", CFG);
			assert.equal(verdict, null);
		} finally {
			restore();
		}
	});
});
