import type { RunView } from "../runs.js";
import type { CoverageView } from "../coverage.js";

type RunData = RunView & { coverage: CoverageView | null };

function $<T extends HTMLElement = HTMLElement>(id: string): T {
	const el = document.getElementById(id);
	if (!el) throw new Error(`missing #${id}`);
	return el as T;
}

// ---------- Icons (static, shared across every mount) ----------
const I: Record<string, string> = {
	reason: '<path d="M12 3a6 6 0 0 0-4 10.5V16h8v-2.5A6 6 0 0 0 12 3Z"/><path d="M9.5 19h5M10 21.5h4"/>',
	read: '<path d="M4 5.5A1.5 1.5 0 0 1 5.5 4H11v15H5.5A1.5 1.5 0 0 1 4 17.5Z"/><path d="M20 5.5A1.5 1.5 0 0 0 18.5 4H13v15h5.5a1.5 1.5 0 0 0 1.5-1.5Z"/>',
	edit: '<path d="M4 20h4L18.5 9.5a2 2 0 0 0 0-2.8l-1.2-1.2a2 2 0 0 0-2.8 0L4 16Z"/><path d="M13.5 6.5l4 4"/>',
	run: '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M7.5 9.5l3 2.5-3 2.5M12.5 15h4"/>',
	tool: '<path d="M14.5 6.5a3.5 3.5 0 0 0-4.8 4.2l-5 5a1.6 1.6 0 0 0 2.3 2.3l5-5a3.5 3.5 0 0 0 4.2-4.8l-2.1 2.1-1.9-.2-.2-1.9Z"/>',
	llm: '<circle cx="12" cy="12" r="2.2"/><path d="M12 4v2M12 18v2M4 12h2M18 12h2M6.3 6.3l1.5 1.5M16.2 16.2l1.5 1.5M17.7 6.3l-1.5 1.5M7.8 16.2l-1.5 1.5"/>',
	search: '<circle cx="11" cy="11" r="6"/><path d="M20 20l-4.3-4.3"/>',
};
const SVG_LOOP = '<path d="M4 9a7 7 0 0 1 12-4l2 2M20 15a7 7 0 0 1-12 4l-2-2"/><path d="M18 3v4h-4M6 21v-4h4"/>';
function icon(t: string): string {
	return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' + (I[t] || I.tool) + '</svg>';
}
function svg(p: string, sw?: number): string {
	return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="' + (sw || 1.7) + '" stroke-linecap="round" stroke-linejoin="round">' + p + '</svg>';
}

const TYPE_COLOR: Record<string, [string, string]> = {
	reason: ["#8A85F2", "rgba(138,133,242,0.14)"], read: ["#5C93C4", "rgba(92,147,196,0.14)"],
	edit: ["#19b0c0", "rgba(25,176,192,0.15)"], run: ["#C98A5E", "rgba(201,138,94,0.15)"],
	tool: ["#C77DBB", "rgba(199,125,187,0.14)"], llm: ["#5FA8D3", "rgba(95,168,211,0.14)"],
	search: ["#6FA96B", "rgba(111,169,107,0.14)"],
};
const VERDICT: Record<string, { label: string; color: string; wash: string; line: string; glyph: string }> = {
	met: { label: "Goal met", color: "var(--met)", wash: "var(--met-wash)", line: "rgba(47,162,74,0.35)", glyph: '<circle cx="12" cy="12" r="9"/><path d="M8 12.3l2.6 2.6L16 9.2"/>' },
	partial: { label: "Partial", color: "var(--partial)", wash: "var(--partial-wash)", line: "rgba(192,136,16,0.35)", glyph: '<circle cx="12" cy="12" r="9"/><path d="M12 7.5v5M12 15.7v.1"/>' },
	failed: { label: "Goal missed", color: "var(--failed)", wash: "var(--failed-wash)", line: "rgba(220,74,56,0.35)", glyph: '<circle cx="12" cy="12" r="9"/><path d="M9 9l6 6M15 9l-6 6"/>' },
	unjudged: { label: "Not judged", color: "var(--ink-3)", wash: "var(--panel-2)", line: "var(--line)", glyph: '<circle cx="12" cy="12" r="9"/><path d="M8 12h8"/>' },
};

/**
 * Mounts the Detail (Flight Recorder) panel into the skeleton renderDetailFragment already put in
 * #content, using `runData`. Relocated as-is from the page's old per-load inline <script> -- same
 * rendering/escaping logic, now callable once per navigation instead of once per page load.
 * Returns an unmount function the router must call before swapping #content to a different panel,
 * so this panel's window/document-level listeners (drag-to-scrub, spacebar) and any in-flight
 * requestAnimationFrame loop can't keep running against a panel that's no longer on screen.
 */
function mountDetailPanel(runData: RunData): () => void {
	let playT = 0, playing = false, speed = 1, raf: number | null = null, lastTs: number | null = null, pinnedStep: number | null = null, dragging = false;

	const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
	function runDur(r: RunData): number { return r.steps.reduce((m, s) => Math.max(m, s.start + s.dur), 0); }
	function fmtT(s: number): string { s = Math.max(0, Math.round(s)); return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0"); }
	function fmtCost(c: number | null): string { return c == null ? "" : "$" + c.toFixed(c < 1 ? 3 : 2); }
	function fmtTok(t: number | null): string { return t == null ? "" : (t >= 1000 ? (t / 1000).toFixed(1).replace(/\.0$/, "") + "k" : String(t)); }
	function escapeHtml(s: string): string { return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" } as Record<string, string>)[c]); }

	function ring(pct: number, color: string): string {
		const r = 18, C = 2 * Math.PI * r, on = (pct / 100) * C;
		return '<svg width="46" height="46" viewBox="0 0 46 46">'
			+ '<circle cx="23" cy="23" r="' + r + '" fill="none" stroke="var(--line)" stroke-width="5"/>'
			+ '<circle cx="23" cy="23" r="' + r + '" fill="none" stroke="' + color + '" stroke-width="5" stroke-linecap="round" stroke-dasharray="' + on.toFixed(1) + " " + C.toFixed(1) + '"/>'
			+ '<text class="pc-num" x="23" y="23" text-anchor="middle" dominant-baseline="central" transform="rotate(90 23 23)">' + pct + "</text></svg>";
	}

	function gm(k: string, v: string): string { return '<div class="gm"><span class="k">' + k + '</span><span class="v">' + v + "</span></div>"; }

	function renderMission(): void {
		const r = runData, v = VERDICT[r.verdict] || VERDICT.unjudged;
		const m = $("mission");
		m.style.setProperty("--vc", v.color); m.style.setProperty("--vc-wash", v.wash); m.style.setProperty("--vc-line", v.line);
		m.innerHTML =
			"<div>"
			+ '<div class="goal-eyebrow"><span>Goal</span> · <span class="agent-pill">@' + escapeHtml(r.agent) + "</span></div>"
			+ '<h1 class="goal-title">' + escapeHtml(r.goal) + "</h1>"
			+ '<div class="goal-meta">' + gm("Duration", r.totals.dur) + gm("Total cost", fmtCost(r.totals.cost) || "—") + gm("Steps", String(r.totals.steps)) + gm("Tokens", fmtTok(r.totals.tokens) || "—") + "</div>"
			+ "</div>"
			+ '<div class="verdict">'
			+ '<div class="verdict-badge"><svg class="glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' + v.glyph + "</svg>"
			+ '<div class="vt"><span class="lab">Verdict</span><span class="val">' + v.label + "</span></div></div>"
			+ (r.verdict !== "unjudged" && r.score != null ? '<div class="pcredit">' + ring(Math.round(r.score * 100), v.color)
				+ '<div class="pc-side"><div class="conf-row"><span>Goal completion</span><span>' + Math.round(r.score * 100) + "%</span></div></div></div>" : "")
			+ "</div>";
	}

	function renderStrip(): void {
		const r = runData, total = runDur(r), strip = $("strip");
		strip.querySelectorAll(".seg").forEach((n) => n.remove());
		r.steps.forEach((s, i) => {
			const seg = document.createElement("div");
			seg.className = "seg" + (s.status === "err" ? " err" : "");
			const left = total ? (s.start / total) * 100 : 0, w = total ? Math.max((s.dur / total) * 100, 1.2) : 100;
			seg.style.left = left + "%"; seg.style.width = w + "%"; seg.style.background = s.status === "err" ? "var(--failed-wash)" : TYPE_COLOR[s.type][1];
			seg.dataset.i = String(i); seg.title = s.title;
			seg.addEventListener("click", (e) => { e.stopPropagation(); seekTo(s.start + s.dur * 0.5); pinStep(i); });
			strip.appendChild(seg);
		});
		const area = $<SVGElement & HTMLElement>("costArea");
		const W = 1000, H = 100;
		area.setAttribute("viewBox", "0 0 " + W + " " + H);
		const totalCost = r.steps.reduce((a, s) => a + (s.cost || 0), 0);
		if (totalCost > 0 && total > 0) {
			let cum = 0;
			const pts: [number, number][] = [[0, H]];
			r.steps.forEach((s) => { cum += s.cost || 0; const x = ((s.start + s.dur) / total) * W; const y = H - (cum / totalCost) * H * 0.9; pts.push([x, y]); });
			pts.push([W, pts[pts.length - 1][1]]); pts.push([W, H]);
			const d = "M" + pts.map((p) => p[0].toFixed(1) + "," + p[1].toFixed(1)).join(" L");
			area.innerHTML = '<path d="' + d + ' Z" fill="var(--accent-wash)"/><path d="M0,' + H + " L" + pts.slice(1, -2).map((p) => p[0].toFixed(1) + "," + p[1].toFixed(1)).join(" L") + '" fill="none" stroke="var(--accent)" stroke-width="1.5" opacity="0.5"/>';
		} else {
			area.innerHTML = "";
		}
		$("axisEnd").textContent = "t = " + Math.round(total) + "s";
		$("clockTot").textContent = fmtT(total);
		renderSignals();
	}

	function renderSignals(): void {
		const r = runData, total = runDur(r), lane = $("signals");
		lane.querySelectorAll(".sig-m").forEach((n) => n.remove());
		if (!total) return;
		r.steps.forEach((s, i) => {
			if (!s.sig) return;
			s.sig.forEach((sg) => {
				const at = ((s.start + s.dur * 0.5) / total) * 100;
				const m = document.createElement("div");
				m.className = "sig-m"; m.style.left = at + "%";
				m.style.background = "var(--stuck)"; m.style.color = "#fff"; m.style.borderColor = "var(--stuck)";
				m.innerHTML = svg(SVG_LOOP, 1.9); m.title = "Retry loop ×" + sg.count + " — step " + (i + 1);
				m.addEventListener("click", () => { pinStep(i); seekTo(s.start + 0.3); });
				lane.appendChild(m);
			});
		});
	}

	function sBadges(s: RunData["steps"][number]): string {
		if (!s.sig) return "";
		return s.sig.map((sg) => '<span class="sbadge retry">' + svg(SVG_LOOP, 2) + "&times;" + sg.count + "</span>").join("");
	}

	function renderSteps(): void {
		const r = runData, el = $("steps");
		$("stepCount").textContent = r.steps.length + " step" + (r.steps.length === 1 ? "" : "s");
		if (!r.steps.length) { el.innerHTML = '<div class="insp-empty" style="padding:14px">No steps logged for this run.</div>'; return; }
		el.innerHTML = r.steps.map((s, i) => {
			const [c, w] = TYPE_COLOR[s.type];
			const stat = s.status === "err" ? '<span class="stat-chip stat-err">error</span>' : "";
			const metaBits = ["t+" + fmtT(s.start), s.dur + "s" + (fmtCost(s.cost) ? " · " + fmtCost(s.cost) : "")];
			return '<div class="step" data-i="' + i + '" role="button" tabindex="0" aria-selected="false" style="--tc:' + c + ";--tc-wash:" + w + '">'
				+ '<div class="rail"><div class="tick">' + icon(s.type) + "</div></div>"
				+ '<div class="body"><div class="st-title">' + escapeHtml(s.title) + " " + stat + sBadges(s) + "</div></div>"
				+ '<div class="meta">' + metaBits.join("<br>") + "</div></div>";
		}).join("");
		el.querySelectorAll<HTMLElement>(".step").forEach((node) => {
			const i = Number(node.dataset.i);
			node.addEventListener("click", () => { pinStep(i); seekTo(runData.steps[i].start + 0.3); });
			node.addEventListener("keydown", (e: KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pinStep(i); seekTo(runData.steps[i].start + 0.3); } });
		});
	}

	function currentStepIndex(): number {
		let idx = -1;
		runData.steps.forEach((s, i) => { if (playT >= s.start) idx = i; });
		return idx;
	}

	function renderInspector(): void {
		if (pinnedStep != null && runData.steps[pinnedStep]) renderStepIO(runData.steps[pinnedStep], pinnedStep);
		else renderVerdict(runData);
	}

	function renderVerdict(r: RunData): void {
		$("inspTitle").textContent = "Verdict";
		const insp = $("insp");
		if (r.verdict === "unjudged") {
			insp.innerHTML = '<div class="insp-section"><div class="insp-empty">No verdict — no goal-attainment judge was configured for this run (set TRAIL_JUDGE_PROVIDER/TRAIL_JUDGE_API_KEY to enable one).</div></div>';
			return;
		}
		const v = VERDICT[r.verdict] || VERDICT.unjudged;
		insp.style.setProperty("--vc", v.color);
		insp.innerHTML = '<div class="insp-section"><h3>LLM judge</h3><div class="judge-quote">' + escapeHtml(r.narrative || "") + "</div></div>";
	}

	function coverageList(entries: NonNullable<RunData["coverage"]>["entries"], emptyMsg: string): string {
		if (!entries.length) return '<div class="insp-empty">' + emptyMsg + "</div>";
		return entries.map((e) => {
			const used = e.usedCount > 0;
			const status = used ? "✓ used (" + e.usedCount + " step" + (e.usedCount === 1 ? "" : "s") + ")" : "— not used";
			return '<div class="cov-row"><span>' + escapeHtml(e.name) + '</span><span class="cov-status' + (used ? " cov-used" : "") + '">' + status + "</span></div>";
		}).join("");
	}

	function renderCoverage(): void {
		const cov = runData.coverage, el = $("coverage");
		if (!cov || !cov.entries.length) {
			el.innerHTML = '<div class="insp-empty">No skills, sub-agents, or MCP servers were registered for this run — nothing to show coverage for.</div>';
			return;
		}
		if (!cov.tracked) {
			el.innerHTML = '<div class="insp-empty">Coverage not tracked for this run — no step reported which skill, sub-agent, or MCP server it came from.</div>';
			return;
		}
		const skills = cov.entries.filter((e) => e.type === "skill");
		const subAgents = cov.entries.filter((e) => e.type === "sub_agent");
		const mcpServers = cov.entries.filter((e) => e.type === "mcp_server");
		el.innerHTML =
			'<div class="insp-section"><h3>Skills</h3>' + coverageList(skills, "No skills registered for this run.") + "</div>"
			+ '<div class="insp-section"><h3>Sub-agents</h3>' + coverageList(subAgents, "No sub-agents registered for this run.") + "</div>"
			+ '<div class="insp-section"><h3>MCP servers</h3>' + coverageList(mcpServers, "No MCP servers registered for this run.") + "</div>";
	}

	function renderStepIO(s: RunData["steps"][number], i: number): void {
		$("inspTitle").textContent = s.title + " · step " + (i + 1);
		const insp = $("insp");
		let inner = '<div class="pin-note"><span>&#9670; pinned to step ' + (i + 1) + '</span><button id="unpin">back to verdict</button></div>';
		if (s.sig) inner += s.sig.map((sg) => '<div class="io-sig"><span style="color:var(--stuck);display:grid;place-items:center">' + svg(SVG_LOOP, 1.9) + '</span><div><span class="st" style="color:var(--stuck)">Retry loop &times;' + sg.count + '</span><div style="color:var(--ink-2);margin-top:2px">' + escapeHtml(sg.detail) + "</div></div></div>").join("");
		if (s.io && s.io.length) inner += s.io.map((p) => '<div class="io-kind">' + escapeHtml(p[0]) + '</div><div class="io-block">' + escapeHtml(p[1]) + "</div>").join("");
		else inner += '<div class="insp-empty">No input/output recorded for this step.</div>';
		insp.innerHTML = inner;
		const un = document.getElementById("unpin");
		if (un) un.addEventListener("click", () => pinStep(null));
	}

	function updatePlayhead(): void {
		const r = runData, total = runDur(r), pct = total ? Math.min(100, (playT / total) * 100) : 0;
		$("playhead").style.left = pct + "%"; $("clockNow").textContent = fmtT(playT);
		$("strip").setAttribute("aria-valuenow", String(Math.round(pct)));
		let cost = 0, tok = 0, steps = 0;
		r.steps.forEach((s) => {
			if (playT >= s.start + s.dur) { cost += s.cost || 0; tok += s.tok || 0; steps++; }
			else if (playT >= s.start && s.dur > 0) { const f = (playT - s.start) / s.dur; cost += (s.cost || 0) * f; tok += Math.round((s.tok || 0) * f); }
		});
		$("accCost").textContent = fmtCost(cost) || "$0.00"; $("accSteps").textContent = steps + "/" + r.steps.length; $("accTok").textContent = fmtTok(tok) || "0";
		const ci = currentStepIndex();
		$("strip").querySelectorAll<HTMLElement>(".seg").forEach((seg) => {
			const i = Number(seg.dataset.i), s = r.steps[i];
			seg.classList.toggle("played", playT >= s.start); seg.classList.toggle("current", i === ci);
		});
		$("steps").querySelectorAll<HTMLElement>(".step").forEach((node) => {
			const i = Number(node.dataset.i);
			node.setAttribute("data-current", i === ci ? "true" : "false");
			node.setAttribute("aria-selected", pinnedStep === i ? "true" : "false");
		});
		if (pinnedStep == null && ci >= 0 && playing) {
			const node = $("steps").querySelector('.step[data-i="' + ci + '"]');
			if (node) node.scrollIntoView({ block: "nearest", behavior: reduceMotion ? "auto" : "smooth" });
		}
	}
	function seekTo(t: number): void { const total = runDur(runData); playT = Math.max(0, Math.min(total, t)); updatePlayhead(); }
	function pinStep(i: number | null): void { pinnedStep = i; renderInspector(); updatePlayhead(); }

	function tick(ts: number): void {
		if (!playing) return;
		if (lastTs == null) lastTs = ts;
		const dt = (ts - lastTs) / 1000; lastTs = ts; playT += dt * speed;
		const total = runDur(runData);
		if (playT >= total) { playT = total; setPlaying(false); updatePlayhead(); return; }
		updatePlayhead(); raf = requestAnimationFrame(tick);
	}
	function setPlaying(p: boolean): void {
		playing = p; lastTs = null;
		$("playIcon").innerHTML = p ? '<path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z"/>' : '<path d="M8 5v14l11-7z"/>';
		$("playBtn").setAttribute("aria-label", p ? "Pause replay" : "Play replay");
		if (p) { if (playT >= runDur(runData)) playT = 0; pinStep(null); raf = requestAnimationFrame(tick); }
		else if (raf != null) cancelAnimationFrame(raf);
	}

	function onWindowMouseMove(e: MouseEvent): void { if (dragging) seekFromEvent(e); }
	function onWindowMouseUp(): void { dragging = false; }
	function onDocumentKeydown(e: KeyboardEvent): void {
		const target = e.target as HTMLElement | null;
		if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
		if (e.key === " ") { e.preventDefault(); setPlaying(!playing); }
	}
	function seekFromEvent(e: MouseEvent | TouchEvent): void {
		const strip = $("strip");
		const rect = strip.getBoundingClientRect();
		const clientX = "touches" in e && e.touches.length ? e.touches[0].clientX : (e as MouseEvent).clientX;
		const x = (clientX - rect.left) / rect.width;
		seekTo(x * runDur(runData));
	}

	function initControls(): void {
		$("playBtn").addEventListener("click", () => setPlaying(!playing));
		$("speeds").querySelectorAll("button").forEach((b) => b.addEventListener("click", () => {
			speed = Number(b.dataset.sp);
			$("speeds").querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
		}));
		const strip = $("strip");
		strip.addEventListener("mousedown", (e: MouseEvent) => {
			if ((e.target as HTMLElement).classList.contains("seg")) return;
			dragging = true; setPlaying(false); seekFromEvent(e);
		});
		window.addEventListener("mousemove", onWindowMouseMove);
		window.addEventListener("mouseup", onWindowMouseUp);
		strip.addEventListener("keydown", (e: KeyboardEvent) => {
			const total = runDur(runData);
			if (e.key === "ArrowRight") { seekTo(playT + total * 0.02); e.preventDefault(); }
			if (e.key === "ArrowLeft") { seekTo(playT - total * 0.02); e.preventDefault(); }
		});
		document.addEventListener("keydown", onDocumentKeydown);
	}

	renderMission(); renderStrip(); renderSteps(); renderInspector(); renderCoverage(); updatePlayhead(); initControls();

	return function unmount(): void {
		if (raf != null) cancelAnimationFrame(raf);
		window.removeEventListener("mousemove", onWindowMouseMove);
		window.removeEventListener("mouseup", onWindowMouseUp);
		document.removeEventListener("keydown", onDocumentKeydown);
	};
}
