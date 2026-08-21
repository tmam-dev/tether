import { test, describe } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { renderFlightRecorderPage } from "../dist/templates/flight-recorder.js";

function makeRunView(overrides = {}) {
	return {
		traceId: "t".repeat(32),
		goal: "do the thing",
		agent: "coding-agent",
		verdict: "met",
		score: 0.9,
		narrative: "Fully shipped and verified.",
		totals: { dur: "10s", cost: 0.05, tokens: 500, steps: 1 },
		steps: [
			{ type: "tool", title: "run tests", status: "ok", start: 0, dur: 5, cost: 0.05, tok: 500, io: [["Input", "pytest -x"], ["Output", "1 passed"]] },
		],
		...overrides,
	};
}

/** Extracts the JSON object text that was injected in place of __RUN_JSON__, using
 * brace/string-aware scanning so it's robust to arbitrary content in string fields
 * (e.g. semicolons, braces) instead of naively searching for a fixed terminator. */
function extractRunJsonText(html) {
	const marker = "const RUN = ";
	const start = html.indexOf(marker) + marker.length;
	assert.ok(start > marker.length - 1, "could not find 'const RUN = ' in rendered page");
	let i = start;
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (; i < html.length; i++) {
		const ch = html[i];
		if (inString) {
			if (escaped) escaped = false;
			else if (ch === "\\") escaped = true;
			else if (ch === '"') inString = false;
			continue;
		}
		if (ch === '"') { inString = true; continue; }
		if (ch === "{" || ch === "[") depth++;
		else if (ch === "}" || ch === "]") {
			depth--;
			if (depth === 0) { i++; break; }
		}
	}
	return html.slice(start, i);
}

/** A minimal fake DOM sufficient to execute the Flight Recorder page's inline <script>
 * (the client-side rendering IIFE) under Node's vm module, so tests can assert on real
 * runtime behavior (e.g. what actually lands in innerHTML) rather than just static HTML. */
class FakeElement {
	constructor(id) {
		this.id = id;
		this._innerHTML = "";
		this.textContent = "";
		this.title = "";
		this.style = { setProperty: () => {} };
		this.classList = { toggle() {}, contains() { return false; }, add() {}, remove() {} };
		this.dataset = {};
		this._attrs = {};
		this.children = [];
	}
	set innerHTML(v) { this._innerHTML = v; }
	get innerHTML() { return this._innerHTML; }
	setAttribute(n, v) { this._attrs[n] = v; }
	getAttribute(n) { return this._attrs[n] ?? null; }
	addEventListener() {}
	appendChild(child) { this.children.push(child); return child; }
	querySelectorAll() { return []; }
	remove() {}
	scrollIntoView() {}
}

function runClientScript(html) {
	const openIdx = html.indexOf("<script>");
	const closeIdx = html.lastIndexOf("</script>");
	assert.notEqual(openIdx, -1);
	assert.notEqual(closeIdx, -1);
	const scriptSrc = html.slice(openIdx + "<script>".length, closeIdx);

	const elements = {};
	function getOrCreate(id) {
		if (!elements[id]) elements[id] = new FakeElement(id);
		return elements[id];
	}
	const documentStub = {
		getElementById: (id) => getOrCreate(id),
		createElement: () => new FakeElement(null),
		addEventListener: () => {},
		documentElement: new FakeElement("html"),
	};
	const windowStub = {
		matchMedia: () => ({ matches: false }),
		requestAnimationFrame: () => 0,
		cancelAnimationFrame: () => {},
		addEventListener: () => {},
	};
	const sandbox = { document: documentStub, window: windowStub, console };
	vm.createContext(sandbox);
	vm.runInContext(scriptSrc, sandbox, { filename: "flight-recorder-inline.js" });
	return elements;
}

describe("renderFlightRecorderPage — XSS via </script> breakout (finding 1)", () => {
	test("a goal containing </script><img ...> cannot terminate the inline script element", () => {
		const run = makeRunView({ goal: '</script><img src=x onerror=alert(1)>' });
		const html = renderFlightRecorderPage(run);

		// Only the template's own real closing </script> tag may appear literally;
		// nothing before it should contain a literal "</script><img" sequence.
		const realCloseIdx = html.lastIndexOf("</script>");
		const before = html.slice(0, realCloseIdx);
		assert.equal(before.includes("</script><img"), false);

		// The whole page must contain exactly one literal "</script>" (the real one).
		const occurrences = html.split("</script>").length - 1;
		assert.equal(occurrences, 1);

		// And the client script still executes cleanly end-to-end (no truncated/corrupted JS).
		assert.doesNotThrow(() => runClientScript(html));
	});
});

describe("renderFlightRecorderPage — special replacement patterns (finding 3)", () => {
	test("a goal containing $& does not corrupt the injected JSON", () => {
		const run = makeRunView({ goal: "weird $& goal" });
		const html = renderFlightRecorderPage(run);
		const parsed = JSON.parse(extractRunJsonText(html));
		assert.equal(parsed.goal, "weird $& goal");
	});

	test("a goal containing $' does not corrupt the injected JSON or splice in the template's own </script> tag", () => {
		const run = makeRunView({ goal: "weird $' goal" });
		const html = renderFlightRecorderPage(run);
		const jsonText = extractRunJsonText(html);
		const parsed = JSON.parse(jsonText);
		assert.equal(parsed.goal, "weird $' goal");
		// $' would splice in everything after the match (including the literal </script> tag)
		// if a string replacer were used; make sure that didn't happen.
		assert.equal(jsonText.includes("</script>"), false);
	});
});

describe("renderFlightRecorderPage — unknown/missing verdict (finding 4)", () => {
	test("an unrecognized verdict string does not throw and the rest of the page still renders", () => {
		const run = makeRunView({ verdict: "totally-bogus-verdict" });
		const html = renderFlightRecorderPage(run);
		let elements;
		assert.doesNotThrow(() => { elements = runClientScript(html); });
		assert.match(elements.mission.innerHTML, /goal-title/);
		assert.match(elements.mission.innerHTML, /do the thing/);
	});

	test("a judged run with a missing score does not render a confident percentage", () => {
		const run = makeRunView({ verdict: "met", score: null });
		const html = renderFlightRecorderPage(run);
		const elements = runClientScript(html);
		assert.equal(elements.mission.innerHTML.includes("pcredit"), false);
		assert.equal(elements.mission.innerHTML.includes("Goal completion"), false);
	});

	test("a normally-judged run with a real score still renders the completion percentage", () => {
		const run = makeRunView({ verdict: "met", score: 0.75 });
		const html = renderFlightRecorderPage(run);
		const elements = runClientScript(html);
		assert.match(elements.mission.innerHTML, /Goal completion/);
		assert.match(elements.mission.innerHTML, /75%/);
	});
});

describe("renderFlightRecorderPage — judge narrative escaping (finding 2)", () => {
	test("narrative containing <script>alert(1)</script> is fully escaped when rendered into the inspector panel", () => {
		const run = makeRunView({ verdict: "met", score: 0.5, narrative: "<script>alert(1)</script>" });
		const html = renderFlightRecorderPage(run);
		const elements = runClientScript(html);
		assert.match(elements.insp.innerHTML, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
		assert.equal(elements.insp.innerHTML.includes("<script>alert(1)</script>"), false);
	});
});
