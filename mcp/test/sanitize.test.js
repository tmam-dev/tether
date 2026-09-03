import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { sanitize, sanitizeDiffs } from "../dist/sanitize.js";

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

	test("truncation at a mid-character boundary does not produce U+FFFD replacement characters", () => {
		// 16384 is not a multiple of 3 (each "€" is 3 UTF-8 bytes), so slicing at 16384
		// would normally split a character in half, producing U+FFFD. This test verifies
		// that such replacement characters are stripped from the output.
		const s = "€".repeat(10000); // 30000 bytes
		const out = sanitize(s, 16384);
		assert.doesNotMatch(out, /�/, "output must not contain U+FFFD replacement character");
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

const HUNK_A = "@@ -1,3 +1,3 @@\n-old line\n+new line\n context\n";
const HUNK_B = "@@ -10,2 +10,3 @@\n context\n+added line\n";
const HEADER = "--- a/auth.py\n+++ b/auth.py\n";

describe("sanitizeDiffs", () => {
	test("keeps a small diff whole and reports no omission", () => {
		const [e] = sanitizeDiffs([{ path: "auth.py", diff: HEADER + HUNK_A + HUNK_B }]);
		assert.equal(e.path, "auth.py");
		assert.equal(e.hunksShown, 2);
		assert.equal(e.hunksTotal, 2);
		assert.equal(e.bytesOmitted, 0);
		assert.equal(e.partialHunk, false);
		assert.ok(e.diff.includes("--- a/auth.py"));
		assert.ok(e.diff.includes("+added line"));
	});

	test("redacts secrets inside a hunk body", () => {
		const [e] = sanitizeDiffs([{ path: ".env", diff: HEADER + "@@ -1 +1 @@\n+api_key=\"abc123def456\"\n" }]);
		assert.ok(!e.diff.includes("abc123def456"), "secret must not survive");
		assert.ok(e.diff.includes("[REDACTED]"));
	});

	test("redacts secrets in the file header too", () => {
		const [e] = sanitizeDiffs([{ path: "x", diff: "--- a/sk-abcdefghij1234567890\n+++ b/x\n" + HUNK_A }]);
		assert.ok(!e.diff.includes("sk-abcdefghij1234567890"));
	});

	test("drops whole hunks past the entry budget and never emits a partial one", () => {
		const big = "@@ -1,1 +1,1 @@\n+" + "x".repeat(300 * 1024) + "\n";
		const [e] = sanitizeDiffs([{ path: "big.txt", diff: HEADER + HUNK_A + big + HUNK_B }]);
		assert.equal(e.hunksTotal, 3);
		assert.ok(e.hunksShown < 3, "the oversized hunk must not all fit");
		assert.ok(e.bytesOmitted > 0);
		assert.equal(e.partialHunk, false, "whole hunks fit, so nothing is cut mid-hunk");
	});

	test("falls back to a partial hunk only when one hunk alone exceeds the entry budget", () => {
		const huge = "@@ -1,1 +1,1 @@\n+" + "y".repeat(300 * 1024) + "\n";
		const [e] = sanitizeDiffs([{ path: "huge.txt", diff: HEADER + huge }]);
		assert.equal(e.partialHunk, true);
		assert.equal(e.hunksShown, 1);
		assert.ok(e.bytesOmitted > 0);
	});

	test("exhausts the per-step budget across entries, keeping later headers with hunksShown 0", () => {
		const heavy = HEADER + "@@ -1,1 +1,1 @@\n+" + "z".repeat(250 * 1024) + "\n";
		const entries = [1, 2, 3, 4, 5, 6].map((n) => ({ path: `f${n}.txt`, diff: heavy }));
		const out = sanitizeDiffs(entries);
		assert.equal(out.length, 6, "every changed file still appears");
		const last = out[out.length - 1];
		assert.equal(last.hunksShown, 0, "step budget exhausted");
		assert.ok(last.diff.includes("--- a/auth.py"), "header survives so the file is still identifiable");
		assert.ok(last.bytesOmitted > 0);
	});

	test("byte-truncates a string with no @@ hunk instead of exempting it as a header", () => {
		const [e] = sanitizeDiffs([{ path: "notadiff.txt", diff: "q".repeat(400 * 1024) }]);
		assert.equal(e.hunksTotal, 0);
		assert.ok(Buffer.byteLength(e.diff, "utf8") < 300 * 1024, "must not bypass the budget");
		assert.ok(e.bytesOmitted > 0);
	});

	test("handles an empty diff without throwing", () => {
		const [e] = sanitizeDiffs([{ path: "empty", diff: "" }]);
		assert.equal(e.hunksTotal, 0);
		assert.equal(e.diff, "");
		assert.equal(e.bytesOmitted, 0);
	});

	test("returns an empty array for an empty entry list", () => {
		assert.deepEqual(sanitizeDiffs([]), []);
	});
});
