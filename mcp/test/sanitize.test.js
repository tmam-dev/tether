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

	test("redaction of a large input completes quickly (no O(n²) backtracking)", () => {
		// Regression test: the SECRET_PATTERNS regex must not cause catastrophic backtracking
		// on large innocent inputs. This guards against O(n²) behavior that would hang
		// processing of large diffs or payloads.
		const start = Date.now();
		sanitize("x".repeat(300000)); // 300KB of innocent characters
		const elapsed = Date.now() - start;
		assert.ok(elapsed < 2000, `redaction took ${elapsed}ms, expected < 2000ms`);
	});

	test("redacts ordinary secret patterns after regex quantifier bounding", () => {
		// Verify the {0,64} bound does not break detection of ordinary secrets
		assert.equal(sanitize("db_password=hunter2hunter2"), "[REDACTED]");
		assert.equal(sanitize('{"api_key": "abc123def456"}'), '{[REDACTED]}');
		assert.equal(sanitize("X_SECRET_TOKEN_NAME=abc123"), "[REDACTED]");
	});

	test("still leaves negative case (password mention with no value) alone after bounding", () => {
		assert.equal(sanitize("this mentions password but has no value"), "this mentions password but has no value");
	});

	test("redacts key names near the {0,64} bound", () => {
		// A key name with 60 characters (within bound) should redact
		const keyNearBound = "a".repeat(60) + "_password=hunter2hunter2";
		assert.ok(!sanitize(keyNearBound).includes("password"));
		assert.ok(sanitize(keyNearBound).includes("[REDACTED]"));
	});

	test("key names past the {0,64} bound still redact when the keyword aligns", () => {
		// The {0,64} bound limits the prefix/suffix, but the regex still matches by starting
		// the match from a position where the keyword is within range. This is the accepted
		// trade-off: we bound the quantifiers to prevent O(n²) backtracking on malformed input,
		// and accept that some unusual formatting may fail to redact if the keyword prefix
		// exceeds 64 characters with no room for suffix matching.
		const keyWithLongPrefix = "a".repeat(100) + "_password=hunter2hunter2";
		const redacted = sanitize(keyWithLongPrefix);
		assert.ok(!redacted.includes("password"), "still redacts when keyword aligns within bound");
		assert.ok(redacted.includes("[REDACTED]"));
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

	test("skips entries with non-string path or diff, returning only valid entries", () => {
		const entries = [
			{ path: "good1.txt", diff: HEADER + HUNK_A },
			{ path: 123, diff: HEADER + HUNK_A }, // non-string path
			{ path: "bad2.txt", diff: null }, // non-string diff
			{ path: "good3.txt", diff: HEADER + HUNK_B }, // valid
		];
		const out = sanitizeDiffs(entries);
		assert.equal(out.length, 2, "should skip 2 bad entries and keep 2 good ones");
		assert.equal(out[0].path, "good1.txt");
		assert.equal(out[1].path, "good3.txt");
	});

	test("handles an entry with non-string path and non-string diff without throwing", () => {
		const out = sanitizeDiffs([{ path: 123, diff: null }]);
		assert.equal(out.length, 0, "bad entry should be skipped, not thrown");
	});
});
