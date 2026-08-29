import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { sanitize } from "../dist/sanitize.js";

describe("sanitize — redaction", () => {
	test("redacts an OpenAI/Anthropic-style sk- key", () => {
		assert.equal(sanitize("key is sk-abcdefghij1234567890"), "key is [REDACTED]");
	});

	test("redacts a GitHub PAT (ghp_...)", () => {
		assert.equal(sanitize("my github token is ghp_abcdefghij1234567890abcd"), "my github token is [REDACTED]");
	});

	test("redacts an AWS access key id (AKIA...)", () => {
		assert.equal(sanitize("id=AKIAABCDEFGHIJKLMNOP"), "id=[REDACTED]");
	});

	test("redacts a Bearer token", () => {
		assert.equal(sanitize("Authorization: Bearer abcxyz1234567890"), "Authorization: [REDACTED]");
	});

	test("redacts a KEY=value pair whose key name contains 'password'", () => {
		assert.equal(sanitize("db_password=hunter2hunter2"), "[REDACTED]");
	});

	test("redacts a JSON-ish \"api_key\": \"value\" pair", () => {
		assert.equal(sanitize('{"api_key": "abc123def456"}'), '{[REDACTED]}');
	});

	test("does not redact ordinary text mentioning 'password' with no value attached", () => {
		assert.equal(sanitize("please enter your password"), "please enter your password");
	});

	test("does not redact an ordinary short numeric id", () => {
		assert.equal(sanitize("build id: 4821"), "build id: 4821");
	});
});

describe("sanitize — truncation", () => {
	test("leaves a string under the byte cap unchanged", () => {
		const s = "a".repeat(100);
		assert.equal(sanitize(s, 16384), s);
	});

	test("truncates a string over the byte cap with a marker naming the original byte count", () => {
		const s = "a".repeat(20000);
		const out = sanitize(s, 16384);
		assert.ok(out.length < s.length);
		assert.ok(out.endsWith("…[truncated, 20000b]"));
	});

	test("a string exactly at the byte cap is not truncated", () => {
		const s = "a".repeat(16384);
		assert.equal(sanitize(s, 16384), s);
	});

	test("truncation is measured in UTF-8 bytes, not JS string length, for multi-byte characters", () => {
		// each "€" is 3 bytes in UTF-8 but 1 UTF-16 code unit in JS string length
		const s = "€".repeat(10000); // 30000 bytes
		const out = sanitize(s, 16384);
		assert.match(out, /…\[truncated, 30000b\]$/);
	});
});

describe("sanitize — structure preservation", () => {
	test("truncates only the offending string leaf, preserving object shape and other keys", () => {
		const big = "x".repeat(20000);
		const out = sanitize({ file: "auth.py", diff: big, lines: 42 });
		assert.equal(out.file, "auth.py");
		assert.equal(out.lines, 42);
		assert.ok(out.diff.endsWith("…[truncated, 20000b]"));
	});

	test("recurses into arrays", () => {
		const out = sanitize(["sk-abcdefghij1234567890", "plain text"]);
		assert.deepEqual(out, ["[REDACTED]", "plain text"]);
	});

	test("passes numbers, booleans, and null through unchanged", () => {
		assert.deepEqual(sanitize({ n: 42, b: true, z: null }), { n: 42, b: true, z: null });
	});

	test("passes a plain object/array with no string leaves through unchanged", () => {
		assert.deepEqual(sanitize({ ok: true, count: 3, tags: [1, 2, 3] }), { ok: true, count: 3, tags: [1, 2, 3] });
	});
});
