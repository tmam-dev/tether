import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { renderShell, renderNotFoundPanel } from "../dist/templates/shell.js";

describe("renderNotFoundPanel", () => {
	test("returns a plain not-found message", () => {
		assert.match(renderNotFoundPanel(), /Run not found/);
	});
});

describe("renderShell", () => {
	test("escapes the title", () => {
		const html = renderShell({ view: "detail", traceId: "a".repeat(32) }, "<script>alert(1)</script>", "", "");
		assert.doesNotMatch(html, /<title><script>/);
		assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
	});

	test("embeds the rail and panel HTML verbatim inside their mount points", () => {
		const html = renderShell({ view: "analytics" }, "Tether", "RAIL_MARKER", "PANEL_MARKER");
		assert.match(html, /<div id="rail">RAIL_MARKER<\/div>/);
		assert.match(html, /<main id="content">PANEL_MARKER<\/main>/);
	});

	test("Harness tab is disabled when no traceId is selected", () => {
		const html = renderShell({ view: "analytics" }, "Tether", "", "");
		assert.match(html, /tab-disabled/);
		assert.doesNotMatch(html, /href="\/runs\/[^"]+\/harness"/);
	});

	test("Harness tab links to the selected run's harness page and is marked active on the harness view", () => {
		const html = renderShell({ view: "harness", traceId: "b".repeat(32) }, "Tether", "", "");
		assert.match(html, new RegExp(`href="/runs/${"b".repeat(32)}/harness"[^>]*class="tab tab-active"|class="tab tab-active"[^>]*href="/runs/${"b".repeat(32)}/harness"`));
	});

	test("Harness tab is always an <a data-nav=\"harness\"> element, never a <span>, even when disabled", () => {
		const html = renderShell({ view: "analytics" }, "Tether", "", "");
		assert.match(html, /<a class="tab tab-disabled"/);
		assert.doesNotMatch(html, /<span class="tab tab-disabled"/);
	});

	test("Analytics tab is marked active on the analytics view", () => {
		const html = renderShell({ view: "analytics" }, "Tether", "", "");
		assert.match(html, /href="\/analytics" data-nav="analytics" class="tab tab-active"|class="tab tab-active" href="\/analytics"/);
	});

	test("bootstraps window.__TETHER_INITIAL__ with the view and traceId (null when absent)", () => {
		const withRun = renderShell({ view: "detail", traceId: "c".repeat(32) }, "Tether", "", "");
		assert.match(withRun, new RegExp(`__TETHER_INITIAL__ = \\{"view":"detail","traceId":"${"c".repeat(32)}"\\}`));
		const noRun = renderShell({ view: "analytics" }, "Tether", "", "");
		assert.match(noRun, /__TETHER_INITIAL__ = \{"view":"analytics","traceId":null\}/);
	});

	test("loads the client router", () => {
		assert.match(renderShell({ view: "analytics" }, "Tether", "", ""), /<script src="\/app\.js" defer><\/script>/);
	});
});
