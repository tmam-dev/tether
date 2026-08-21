import { test, describe } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const APP_JS_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "static", "app.js");

function makeRunData(overrides = {}) {
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
		coverage: null,
		...overrides,
	};
}

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
		this._listeners = {};
	}
	set innerHTML(v) { this._innerHTML = v; }
	get innerHTML() { return this._innerHTML; }
	setAttribute(n, v) { this._attrs[n] = v; }
	getAttribute(n) { return this._attrs[n] ?? null; }
	addEventListener(type, fn) { (this._listeners[type] ??= []).push(fn); }
	removeEventListener() {}
	appendChild(child) { this.children.push(child); return child; }
	querySelectorAll() { return []; }
	querySelector() { return null; }
	remove() {}
	scrollIntoView() {}
	getBoundingClientRect() { return { left: 0, width: 100 }; }
}

/** Loads app.js fresh into an isolated vm context with a minimal fake DOM, returning
 * `{ elements, windowStub, mountDetailPanel }` so a test can call mountDetailPanel(runData)
 * directly and assert on what actually landed in the fake elements' innerHTML. */
function loadApp() {
	const src = readFileSync(APP_JS_PATH, "utf-8");
	const elements = {};
	function getOrCreate(id) {
		if (!elements[id]) elements[id] = new FakeElement(id);
		return elements[id];
	}
	const windowListeners = {};
	const documentListeners = {};
	const documentStub = {
		getElementById: (id) => getOrCreate(id),
		createElement: () => new FakeElement(null),
		addEventListener: (type, fn) => { (documentListeners[type] ??= []).push(fn); },
		removeEventListener: (type, fn) => { documentListeners[type] = (documentListeners[type] ?? []).filter((f) => f !== fn); },
		documentElement: new FakeElement("html"),
		querySelectorAll: () => [],
		querySelector: () => null,
	};
	const windowStub = {
		matchMedia: () => ({ matches: false }),
		requestAnimationFrame: () => 1,
		cancelAnimationFrame: () => {},
		addEventListener: (type, fn) => { (windowListeners[type] ??= []).push(fn); },
		removeEventListener: (type, fn) => { windowListeners[type] = (windowListeners[type] ?? []).filter((f) => f !== fn); },
		history: { pushState: () => {} },
		location: { pathname: "/" },
		setInterval: () => 0,
		fetch: () => Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve("") }),
		__TETHER_INITIAL__: undefined,
	};
	const sandbox = { document: documentStub, window: windowStub, history: windowStub.history, location: windowStub.location, setInterval: windowStub.setInterval, fetch: windowStub.fetch, console };
	vm.createContext(sandbox);
	vm.runInContext(src, sandbox, { filename: "app.js" });
	return { elements, windowListeners, documentListeners, mountDetailPanel: sandbox.mountDetailPanel };
}

describe("mountDetailPanel", () => {
	test("renders the goal into the mission panel", () => {
		const { elements, mountDetailPanel } = loadApp();
		mountDetailPanel(makeRunData({ goal: "fix the bug" }));
		assert.match(elements.mission.innerHTML, /fix the bug/);
	});

	test("an unrecognized verdict does not throw and still renders", () => {
		const { elements, mountDetailPanel } = loadApp();
		assert.doesNotThrow(() => mountDetailPanel(makeRunData({ verdict: "totally-bogus" })));
		assert.match(elements.mission.innerHTML, /goal-title/);
	});

	test("a judged run with a missing score does not render a completion percentage", () => {
		const { elements, mountDetailPanel } = loadApp();
		mountDetailPanel(makeRunData({ verdict: "met", score: null }));
		assert.equal(elements.mission.innerHTML.includes("Goal completion"), false);
	});

	test("a judged run with a real score renders the completion percentage", () => {
		const { elements, mountDetailPanel } = loadApp();
		mountDetailPanel(makeRunData({ verdict: "met", score: 0.75 }));
		assert.match(elements.mission.innerHTML, /Goal completion/);
		assert.match(elements.mission.innerHTML, /75%/);
	});

	test("judge narrative containing a script tag is escaped in the inspector panel", () => {
		const { elements, mountDetailPanel } = loadApp();
		mountDetailPanel(makeRunData({ verdict: "met", score: 0.5, narrative: "<script>alert(1)</script>" }));
		assert.match(elements.insp.innerHTML, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
		assert.equal(elements.insp.innerHTML.includes("<script>alert(1)</script>"), false);
	});

	test("unmount removes the window mousemove/mouseup and document keydown listeners it added", () => {
		const { windowListeners, documentListeners, mountDetailPanel } = loadApp();
		const unmount = mountDetailPanel(makeRunData());
		assert.equal((windowListeners.mousemove ?? []).length, 1);
		assert.equal((windowListeners.mouseup ?? []).length, 1);
		assert.equal((documentListeners.keydown ?? []).length, 1);
		unmount();
		assert.equal((windowListeners.mousemove ?? []).length, 0);
		assert.equal((windowListeners.mouseup ?? []).length, 0);
		assert.equal((documentListeners.keydown ?? []).length, 0);
	});
});
