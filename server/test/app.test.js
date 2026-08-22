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
	// `register`, when given, is a getOrCreate(id) callback from the owning loadApp() call's id
	// map. Setting innerHTML on a real element makes any id="..." it contains reachable via
	// document.getElementById; this fake DOM has no real parent/child tree to walk for that, so
	// instead it scans the assigned HTML for an embedded `<script id="...">...</script>` (the
	// router's run-data payload is delivered exactly that way) and registers/populates that id
	// directly, mirroring what a real DOM would do.
	constructor(id, register) {
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
		this._register = register;
	}
	set innerHTML(v) {
		this._innerHTML = v;
		const scriptMatch = v.match(/<script[^>]*\sid="([^"]+)"[^>]*>([\s\S]*?)<\/script>/);
		if (scriptMatch && this._register) {
			this._register(scriptMatch[1]).textContent = scriptMatch[2];
		}
	}
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
		if (!elements[id]) elements[id] = new FakeElement(id, getOrCreate);
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
	getOrCreate("content");
	getOrCreate("rail");
	const windowStub = {
		matchMedia: () => ({ matches: false }),
		requestAnimationFrame: () => 1,
		cancelAnimationFrame: () => {},
		addEventListener: (type, fn) => { (windowListeners[type] ??= []).push(fn); },
		removeEventListener: (type, fn) => { windowListeners[type] = (windowListeners[type] ?? []).filter((f) => f !== fn); },
		history: { pushState: () => {} },
		location: { pathname: "/", href: "" },
		setInterval: () => 0,
		fetch: () => Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve("") }),
		__TETHER_INITIAL__: undefined,
	};
	const sandbox = { document: documentStub, window: windowStub, history: windowStub.history, location: windowStub.location, setInterval: windowStub.setInterval, fetch: windowStub.fetch, console, URL };
	vm.createContext(sandbox);
	vm.runInContext(src, sandbox, { filename: "app.js" });
	// vm contexts are a separate realm: plain objects returned from sandbox code have a
	// different Object.prototype than this file's, which trips assert.deepEqual's cross-realm
	// "same structure but not reference-equal" check. Round-tripping through JSON rebuilds the
	// return value as a plain object of this realm so structural assertions work normally --
	// the router's ShellState values are plain JSON-safe data, so this changes nothing observable.
	const rawParsePathname = sandbox.parsePathname;
	sandbox.parsePathname = (pathname) => {
		const result = rawParsePathname(pathname);
		return result === null ? null : JSON.parse(JSON.stringify(result));
	};
	return { elements, windowListeners, documentListeners, windowStub, sandbox, mountDetailPanel: sandbox.mountDetailPanel };
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

	test("a poisoned verdict of '__proto__' does not crash rendering via the prototype chain, and falls back to 'Not judged'", () => {
		const { elements, mountDetailPanel } = loadApp();
		assert.doesNotThrow(() => mountDetailPanel(makeRunData({ verdict: "__proto__" })));
		assert.match(elements.mission.innerHTML, /goal-title/);
		assert.match(elements.mission.innerHTML, /Not judged/);
	});

	test("a poisoned verdict of 'constructor' does not crash rendering via the prototype chain, and falls back to 'Not judged'", () => {
		const { elements, mountDetailPanel } = loadApp();
		assert.doesNotThrow(() => mountDetailPanel(makeRunData({ verdict: "constructor" })));
		assert.match(elements.mission.innerHTML, /goal-title/);
		assert.match(elements.mission.innerHTML, /Not judged/);
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

describe("router: path parsing and fragment URLs", () => {
	test("parsePathname recognizes all five route shapes and rejects everything else", () => {
		const { sandbox } = loadApp();
		// I2: "/" now resolves to a real state (most-recent-run detail), not null -- returning null
		// here is what used to send a Back navigation to "/" through navigateTo's full-reload
		// fallback instead of fetching client-side.
		assert.deepEqual(sandbox.parsePathname("/"), { view: "detail", traceId: null });
		assert.deepEqual(sandbox.parsePathname("/analytics"), { view: "analytics", traceId: null });
		assert.deepEqual(sandbox.parsePathname("/runs/" + "a".repeat(32)), { view: "detail", traceId: "a".repeat(32) });
		assert.deepEqual(sandbox.parsePathname("/runs/" + "a".repeat(32) + "/harness"), { view: "harness", traceId: "a".repeat(32) });
		assert.equal(sandbox.parsePathname("/something-else"), null);
	});

	test("fragmentUrlFor maps each ShellState to its matching /fragments/* URL", () => {
		const { sandbox } = loadApp();
		assert.equal(sandbox.fragmentUrlFor({ view: "detail", traceId: null }), "/fragments/detail");
		assert.equal(sandbox.fragmentUrlFor({ view: "analytics", traceId: null }), "/fragments/analytics");
		assert.equal(sandbox.fragmentUrlFor({ view: "harness", traceId: "b".repeat(32) }), "/fragments/harness/" + "b".repeat(32));
		assert.equal(sandbox.fragmentUrlFor({ view: "detail", traceId: "c".repeat(32) }), "/fragments/detail/" + "c".repeat(32));
	});
});

describe("router: navigation", () => {
	test("navigating to a recognized path fetches the right fragment and swaps #content", async () => {
		const { elements, windowStub, sandbox } = loadApp();
		windowStub.fetch = (url) => Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve("<p>analytics body</p>") });
		await sandbox.navigateTo("/analytics", true);
		assert.equal(elements.content.innerHTML, "<p>analytics body</p>");
	});

	test("navigating to an unrecognized path falls back to a full navigation instead of fetching", async () => {
		const { windowStub, sandbox } = loadApp();
		let fetched = false;
		windowStub.fetch = () => { fetched = true; return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve("") }); };
		await sandbox.navigateTo("/some/unknown/path", true);
		assert.equal(fetched, false);
		assert.equal(windowStub.location.href, "/some/unknown/path");
	});

	test("a fragment fetch that resolves 404 renders the not-found body directly, not the generic retry block", async () => {
		const { elements, windowStub, sandbox } = loadApp();
		windowStub.fetch = () => Promise.resolve({ ok: false, status: 404, text: () => Promise.resolve('<p class="empty">Run not found.</p>') });
		await sandbox.navigateTo("/runs/" + "d".repeat(32), true);
		assert.match(elements.content.innerHTML, /Run not found/);
		assert.doesNotMatch(elements.content.innerHTML, /Retry/);
	});

	test("a network failure during navigation renders a retry block", async () => {
		const { elements, windowStub, sandbox } = loadApp();
		windowStub.fetch = () => Promise.reject(new Error("network down"));
		await sandbox.navigateTo("/analytics", true);
		assert.match(elements.content.innerHTML, /Retry/);
	});

	test("navigating away from a mounted detail view unmounts it -- its window listeners are gone before the new panel mounts", async () => {
		const { elements, windowListeners, windowStub, sandbox } = loadApp();
		const detailHtml = '<script type="application/json" id="run-data">' + JSON.stringify({ traceId: "e".repeat(32), goal: "g", agent: "a", verdict: "unjudged", score: null, narrative: null, totals: { dur: "1s", cost: null, tokens: null, steps: 0 }, steps: [], coverage: null }) + "</script>";
		windowStub.fetch = (url) => Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(url.includes("/fragments/detail/") ? detailHtml : "<p>analytics body</p>") });

		await sandbox.navigateTo("/runs/" + "e".repeat(32), true);
		// mountDetailPanel's own initControls() ran for real here, registering its two window
		// listeners on the same windowListeners object Task 6's unmount test asserts against.
		assert.equal((windowListeners.mousemove ?? []).length, 1);
		assert.equal((windowListeners.mouseup ?? []).length, 1);

		await sandbox.navigateTo("/analytics", true);
		// navigateTo must have called the stored unmount() before swapping #content -- if it
		// didn't, these listeners would still be registered even though the Detail panel's DOM
		// (and the run-data it was mounted from) no longer exists.
		assert.equal((windowListeners.mousemove ?? []).length, 0);
		assert.equal((windowListeners.mouseup ?? []).length, 0);
		assert.equal(elements.content.innerHTML, "<p>analytics body</p>");
	});

	// I2: Back to "/" (the landing page, and the single most common Back target) must not fall
	// through to navigateTo's full-reload branch. Before the fix, parsePathname("/") returned null,
	// so this exact call would have set windowStub.location.href instead of fetching.
	test("navigating to '/' (e.g. a Back navigation to the landing page) fetches /fragments/detail instead of reloading", async () => {
		const { elements, windowStub, sandbox } = loadApp();
		let fetchedUrl = null;
		windowStub.fetch = (url) => { fetchedUrl = url; return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve("<p>latest run</p>") }); };

		await sandbox.navigateTo("/", false);

		assert.equal(fetchedUrl, "/fragments/detail");
		assert.equal(windowStub.location.href, ""); // unchanged -- a full reload would have set this
		assert.equal(elements.content.innerHTML, "<p>latest run</p>");
	});

	test("navigating to '/' resolves the Harness tab and rail to the server-resolved run's actual traceId", async () => {
		const { windowStub, sandbox } = loadApp();
		const harnessTab = new FakeElement("harnessTab", null);
		let setHref = null;
		harnessTab.setAttribute = (n, v) => { if (n === "href") setHref = v; };
		harnessTab.removeAttribute = () => {};
		harnessTab.classList = { toggle() {}, contains() { return false; }, add() {}, remove() {} };
		sandbox.document.querySelector = (sel) => (sel === '[data-nav="harness"]' ? harnessTab : null);

		const resolvedId = "i".repeat(32);
		const detailHtml = '<script type="application/json" id="run-data">' + JSON.stringify({ traceId: resolvedId, goal: "g", agent: "a", verdict: "unjudged", score: null, narrative: null, totals: { dur: "1s", cost: null, tokens: null, steps: 0 }, steps: [], coverage: null }) + "</script>";
		windowStub.fetch = () => Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(detailHtml) });

		await sandbox.navigateTo("/", false);

		// The client had no way to know resolvedId in advance -- parsePathname("/") only knows
		// traceId: null. This proves navigateTo read the actual resolved traceId back out of the
		// #run-data island the fetched fragment carried, not just target.traceId.
		assert.equal(setHref, "/runs/" + resolvedId + "/harness");
	});

	// I4: two overlapping navigations (e.g. two rail clicks in quick succession) must not let
	// whichever fetch happens to resolve last win the #content swap regardless of click order.
	test("a stale in-flight navigation is ignored once a newer navigation has started and finished", async () => {
		const { elements, windowStub, sandbox } = loadApp();
		const pushed = [];
		windowStub.history.pushState = (_state, _title, url) => pushed.push(url);

		let resolveFirstFetch;
		const firstFetchGate = new Promise((resolve) => { resolveFirstFetch = resolve; });
		let fetchCount = 0;
		windowStub.fetch = () => {
			fetchCount++;
			if (fetchCount === 1) {
				// The FIRST (soon-to-be-stale) navigation's fetch: deliberately held open until we
				// release it below, after the second navigation has already been kicked off.
				return firstFetchGate.then(() => ({ ok: true, status: 200, text: () => Promise.resolve("<p>first (stale)</p>") }));
			}
			return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve("<p>second (winner)</p>") });
		};

		const firstNav = sandbox.navigateTo("/analytics", true);
		const secondNav = sandbox.navigateTo("/runs/" + "k".repeat(32), true);
		resolveFirstFetch();
		await Promise.all([firstNav, secondNav]);

		// Only the second (later-started) navigation's result should have landed -- the first
		// navigation's late-arriving response must not have overwritten it.
		assert.equal(elements.content.innerHTML, "<p>second (winner)</p>");
		assert.deepEqual(pushed, ["/runs/" + "k".repeat(32)]);
	});
});

describe("router: rail polling", () => {
	test("after navigating to a run's Detail view, pollRail fetches /fragments/rail with that run marked active and replaces #rail", async () => {
		const { elements, windowStub, sandbox } = loadApp();
		windowStub.fetch = () => Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve("<p>run body</p>") });
		await sandbox.navigateTo("/runs/" + "l".repeat(32), true);

		let polledUrl = null;
		windowStub.fetch = (url) => { polledUrl = url; return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve("<a>polled rail</a>") }); };
		sandbox.pollRail();
		await new Promise((resolve) => setImmediate(resolve));

		assert.equal(polledUrl, "/fragments/rail?active=" + "l".repeat(32));
		assert.equal(elements.rail.innerHTML, "<a>polled rail</a>");
	});

	test("after navigating to Analytics, pollRail fetches /fragments/rail with no ?active= param", async () => {
		const { elements, windowStub, sandbox } = loadApp();
		windowStub.fetch = () => Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve("<p>analytics body</p>") });
		await sandbox.navigateTo("/analytics", true);

		let polledUrl = null;
		windowStub.fetch = (url) => { polledUrl = url; return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve("<a>polled rail</a>") }); };
		sandbox.pollRail();
		await new Promise((resolve) => setImmediate(resolve));

		assert.equal(polledUrl, "/fragments/rail");
		assert.equal(elements.rail.innerHTML, "<a>polled rail</a>");
	});

	test("a failed poll fetch does not throw and leaves #rail untouched", async () => {
		const { elements, windowStub, sandbox } = loadApp();
		elements.rail.innerHTML = "<a>original rail</a>";
		windowStub.fetch = () => Promise.reject(new Error("network down"));

		assert.doesNotThrow(() => sandbox.pollRail());
		await new Promise((resolve) => setImmediate(resolve));

		assert.equal(elements.rail.innerHTML, "<a>original rail</a>");
	});
});

describe("router: Harness tab sync", () => {
	test("navigateTo updates the Harness tab's href to the newly-selected run", async () => {
		const { windowStub, sandbox } = loadApp();
		const harnessTab = new FakeElement("harnessTab", null);
		let setHref = null;
		harnessTab.setAttribute = (n, v) => { if (n === "href") setHref = v; };
		harnessTab.removeAttribute = () => {};
		harnessTab.classList = { toggle() {}, contains() { return false; }, add() {}, remove() {} };
		sandbox.document.querySelector = (sel) => (sel === '[data-nav="harness"]' ? harnessTab : null);

		windowStub.fetch = (url) => Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve("<p>run body</p>") });
		await sandbox.navigateTo("/runs/" + "f".repeat(32), true);

		assert.equal(setHref, "/runs/" + "f".repeat(32) + "/harness");
	});

	test("navigateTo to /analytics disables the Harness tab", async () => {
		const { windowStub, sandbox } = loadApp();
		const harnessTab = new FakeElement("harnessTab", null);
		let removedHref = false;
		let addedDisabledClass = false;
		let ariaDisabled = null;
		harnessTab.removeAttribute = (n) => { if (n === "href") removedHref = true; };
		harnessTab.setAttribute = (n, v) => { if (n === "aria-disabled") ariaDisabled = v; };
		harnessTab.classList = { toggle() {}, contains() { return false; }, add: (c) => { if (c === "tab-disabled") addedDisabledClass = true; }, remove() {} };
		sandbox.document.querySelector = (sel) => (sel === '[data-nav="harness"]' ? harnessTab : null);

		windowStub.fetch = () => Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve("<p>analytics body</p>") });
		await sandbox.navigateTo("/analytics", true);

		assert.equal(removedHref, true);
		assert.equal(addedDisabledClass, true);
		assert.equal(ariaDisabled, "true");
	});

	test("clicking a disabled Harness tab does not trigger navigation", () => {
		const { sandbox } = loadApp();
		let navigated = false;
		sandbox.navigateTo = () => { navigated = true; return Promise.resolve(); };

		const anchor = {
			getAttribute: (n) => (n === "aria-disabled" ? "true" : null),
			href: "http://localhost/runs/" + "g".repeat(32) + "/harness",
		};
		const targetEl = { closest: () => anchor };
		const event = { target: targetEl, button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, preventDefault: () => {} };

		sandbox.onRailOrTabClick(event);

		assert.equal(navigated, false);
	});

	// Minor 6: the disabled-tab test above only proves navigateTo wasn't called -- that assertion
	// would pass just as well if the stub were never wired up correctly at all. This positive
	// companion proves the stub is actually live by clicking a non-disabled anchor and checking it
	// DOES fire, and with the expected pathname.
	test("clicking a non-disabled anchor does trigger navigation", () => {
		const { sandbox } = loadApp();
		let navigatedTo = null;
		sandbox.navigateTo = (pathname) => { navigatedTo = pathname; return Promise.resolve(); };

		const anchor = {
			getAttribute: () => null,
			href: "http://localhost/runs/" + "g".repeat(32) + "/harness",
		};
		const targetEl = { closest: () => anchor };
		const event = { target: targetEl, button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, preventDefault: () => {} };

		sandbox.onRailOrTabClick(event);

		assert.equal(navigatedTo, "/runs/" + "g".repeat(32) + "/harness");
	});
});
