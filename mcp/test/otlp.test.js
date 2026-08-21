import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { sendSpan } from "../dist/otlp.js";

function stubFetch(impl) {
	const original = globalThis.fetch;
	globalThis.fetch = impl;
	return () => {
		globalThis.fetch = original;
	};
}

function okResponse() {
	return { ok: true, text: async () => "" };
}

const BASE_SPAN = {
	traceId: "a".repeat(32),
	spanId: "b".repeat(16),
	name: "test-span",
	startTimeUnixNano: "1000000000",
	endTimeUnixNano: "2000000000",
	attributes: {},
};

describe("sendSpan", () => {
	test("includes X-Public-Key and X-Secret-Key headers when both are set", async () => {
		let capturedHeaders;
		const restore = stubFetch(async (_url, init) => {
			capturedHeaders = init.headers;
			return okResponse();
		});
		try {
			await sendSpan(
				{ url: "http://localhost:4319", publicKey: "pk-test", secretKey: "sk-test", environment: "default", serviceName: "test" },
				BASE_SPAN,
			);
			assert.equal(capturedHeaders["X-Public-Key"], "pk-test");
			assert.equal(capturedHeaders["X-Secret-Key"], "sk-test");
		} finally {
			restore();
		}
	});

	test("omits X-Public-Key and X-Secret-Key headers entirely when both are undefined (local mode)", async () => {
		let capturedHeaders;
		const restore = stubFetch(async (_url, init) => {
			capturedHeaders = init.headers;
			return okResponse();
		});
		try {
			await sendSpan(
				{ url: "http://localhost:4319", environment: "default", serviceName: "test" },
				BASE_SPAN,
			);
			assert.equal("X-Public-Key" in capturedHeaders, false);
			assert.equal("X-Secret-Key" in capturedHeaders, false);
		} finally {
			restore();
		}
	});

	test("still sends Content-Type and User-Agent headers in local mode", async () => {
		let capturedHeaders;
		const restore = stubFetch(async (_url, init) => {
			capturedHeaders = init.headers;
			return okResponse();
		});
		try {
			await sendSpan(
				{ url: "http://localhost:4319", environment: "default", serviceName: "test" },
				BASE_SPAN,
			);
			assert.equal(capturedHeaders["Content-Type"], "application/json");
			assert.equal(capturedHeaders["User-Agent"], "trail-mcp/0.2.0");
		} finally {
			restore();
		}
	});
});
