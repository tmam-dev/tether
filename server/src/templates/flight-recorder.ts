import type { RunView } from "../runs.js";
import type { CoverageView } from "../coverage.js";

/**
 * Adapted from trail's design/agent-observability-prototypes:flight-recorder.html
 * (843 lines, read in full). Every feature real Tether data can't support has
 * been removed, not hidden -- see this file's originating plan task for the
 * complete list and the interdependency reasons behind each cut.
 */
const TEMPLATE = `<title>Tether — Flight Recorder</title>
<style>
  :root {
    --bg: #F7F6F2; --panel: #FFFFFF; --panel-2: #FBFAF7; --line: #E6E3DB; --line-strong: #D6D2C7;
    --ink: #1B1F24; --ink-2: #565C64; --ink-3: #8A8F97;
    --accent: #0FA6B4; --accent-ink: #0B7C87; --accent-wash: rgba(15,166,180,0.10);
    --met: #2FA24A; --partial: #C08810; --failed: #DC4A38; --stuck: #E0761A;
    --met-wash: rgba(47,162,74,0.12); --partial-wash: rgba(192,136,16,0.12); --failed-wash: rgba(220,74,56,0.12);
    --stuck-wash: rgba(224,118,26,0.15);
    --shadow: 0 1px 2px rgba(20,24,28,0.05), 0 8px 24px rgba(20,24,28,0.06);
    --radius: 12px;
    --mono: ui-monospace, "SF Mono", "JetBrains Mono", "Cascadia Code", "Roboto Mono", monospace;
    --sans: -apple-system, "SF Pro Text", system-ui, "Segoe UI", Roboto, sans-serif;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0E1116; --panel: #161B22; --panel-2: #1A2029; --line: #262D38; --line-strong: #333C49;
      --ink: #E8ECF1; --ink-2: #A3ACB8; --ink-3: #6C7683;
      --accent: #19C6D8; --accent-ink: #57DCEA; --accent-wash: rgba(25,198,216,0.12);
      --met: #3FB950; --partial: #D9A21B; --failed: #F0533F; --stuck: #F0871E;
      --met-wash: rgba(63,185,80,0.15); --partial-wash: rgba(217,162,27,0.15); --failed-wash: rgba(240,83,63,0.15);
      --stuck-wash: rgba(240,135,30,0.16);
      --shadow: 0 1px 2px rgba(0,0,0,0.4), 0 12px 32px rgba(0,0,0,0.4);
    }
  }
  :root[data-theme="light"] {
    --bg: #F7F6F2; --panel: #FFFFFF; --panel-2: #FBFAF7; --line: #E6E3DB; --line-strong: #D6D2C7;
    --ink: #1B1F24; --ink-2: #565C64; --ink-3: #8A8F97;
    --accent: #0FA6B4; --accent-ink: #0B7C87; --accent-wash: rgba(15,166,180,0.10);
    --met: #2FA24A; --partial: #C08810; --failed: #DC4A38; --stuck: #E0761A;
    --met-wash: rgba(47,162,74,0.12); --partial-wash: rgba(192,136,16,0.12); --failed-wash: rgba(220,74,56,0.12);
    --stuck-wash: rgba(224,118,26,0.15);
    --shadow: 0 1px 2px rgba(20,24,28,0.05), 0 8px 24px rgba(20,24,28,0.06);
  }
  :root[data-theme="dark"] {
    --bg: #0E1116; --panel: #161B22; --panel-2: #1A2029; --line: #262D38; --line-strong: #333C49;
    --ink: #E8ECF1; --ink-2: #A3ACB8; --ink-3: #6C7683;
    --accent: #19C6D8; --accent-ink: #57DCEA; --accent-wash: rgba(25,198,216,0.12);
    --met: #3FB950; --partial: #D9A21B; --failed: #F0533F; --stuck: #F0871E;
    --met-wash: rgba(63,185,80,0.15); --partial-wash: rgba(217,162,27,0.15); --failed-wash: rgba(240,83,63,0.15);
    --stuck-wash: rgba(240,135,30,0.16);
    --shadow: 0 1px 2px rgba(0,0,0,0.4), 0 12px 32px rgba(0,0,0,0.4);
  }

  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--ink); font-family: var(--sans); font-size: 14px; line-height: 1.5; -webkit-font-smoothing: antialiased; }
  .wrap { max-width: 1280px; margin: 0 auto; padding: 20px clamp(14px, 3vw, 28px) 64px; }

  .topbar { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; margin-bottom: 18px; }
  .brand { display: flex; align-items: center; gap: 10px; margin-right: auto; }
  .brand-mark { width: 26px; height: 26px; }
  .brand-name { font-weight: 640; letter-spacing: -0.01em; font-size: 15px; }
  .brand-sub { font-family: var(--mono); font-size: 11px; color: var(--ink-3); letter-spacing: 0.04em; text-transform: uppercase; }
  .backlink { font-size: 12.5px; color: var(--ink-2); text-decoration: none; display: flex; align-items: center; gap: 5px; padding: 6px 12px; border-radius: 999px; border: 1px solid var(--line); background: var(--panel); }
  .backlink:hover { color: var(--ink); border-color: var(--line-strong); }
  .iconbtn { width: 34px; height: 34px; border-radius: 9px; border: 1px solid var(--line); background: var(--panel); color: var(--ink-2); cursor: pointer; display: grid; place-items: center; transition: background .15s, color .15s; }
  .iconbtn:hover { color: var(--ink); background: var(--panel-2); }

  .mission { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); box-shadow: var(--shadow); padding: 18px 20px; display: grid; grid-template-columns: 1fr auto; gap: 24px; align-items: start; margin-bottom: 14px; }
  .goal-eyebrow { font-family: var(--mono); font-size: 11px; letter-spacing: 0.09em; text-transform: uppercase; color: var(--ink-3); display: flex; align-items: center; gap: 8px; margin-bottom: 7px; }
  .goal-eyebrow .agent-pill { color: var(--accent-ink); }
  .goal-title { font-size: clamp(18px, 2.4vw, 23px); font-weight: 620; letter-spacing: -0.015em; margin: 0; text-wrap: balance; line-height: 1.25; }
  .goal-meta { display: flex; gap: 16px; flex-wrap: wrap; margin-top: 12px; }
  .gm { display: flex; flex-direction: column; gap: 1px; }
  .gm .k { font-family: var(--mono); font-size: 10px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--ink-3); }
  .gm .v { font-family: var(--mono); font-size: 14px; font-weight: 600; color: var(--ink); font-variant-numeric: tabular-nums; }

  .verdict { min-width: 210px; display: flex; flex-direction: column; gap: 12px; }
  .verdict-badge { display: flex; align-items: center; gap: 10px; padding: 12px 14px; border-radius: 11px; border: 1px solid var(--vc-line); background: var(--vc-wash); }
  .verdict-badge .glyph { width: 30px; height: 30px; flex: none; color: var(--vc); }
  .verdict-badge .vt { display: flex; flex-direction: column; line-height: 1.15; }
  .verdict-badge .vt .lab { font-family: var(--mono); font-size: 10px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--ink-3); }
  .verdict-badge .vt .val { font-size: 18px; font-weight: 680; color: var(--vc); letter-spacing: -0.01em; }

  .pcredit { display: flex; align-items: center; gap: 12px; }
  .pcredit svg { transform: rotate(-90deg); flex: none; }
  .pc-num { font-family: var(--mono); font-size: 16px; font-weight: 680; fill: var(--vc); }
  .pcredit .pc-side { display: flex; flex-direction: column; gap: 6px; flex: 1; }
  .conf-row { display: flex; justify-content: space-between; font-family: var(--mono); font-size: 10px; letter-spacing: 0.04em; text-transform: uppercase; color: var(--ink-3); }

  .trail-card { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); box-shadow: var(--shadow); padding: 14px 16px 12px; margin-bottom: 14px; }
  .transport { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; flex-wrap: wrap; }
  .play-btn { width: 40px; height: 40px; border-radius: 50%; border: 0; cursor: pointer; flex: none; background: var(--accent); color: #05171A; display: grid; place-items: center; box-shadow: 0 4px 14px var(--accent-wash); transition: transform .12s; }
  :root[data-theme="light"] .play-btn { color: #fff; }
  .play-btn:hover { transform: scale(1.05); } .play-btn:active { transform: scale(0.96); }
  .clock { font-family: var(--mono); font-size: 13px; font-variant-numeric: tabular-nums; color: var(--ink); min-width: 92px; letter-spacing: 0.02em; }
  .clock .sep { color: var(--ink-3); }
  .live-accrue { display: flex; gap: 14px; margin-left: auto; flex-wrap: wrap; }
  .accrue { display: flex; flex-direction: column; align-items: flex-end; }
  .accrue .k { font-family: var(--mono); font-size: 9.5px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--ink-3); }
  .accrue .v { font-family: var(--mono); font-size: 14px; font-weight: 620; color: var(--ink); font-variant-numeric: tabular-nums; }
  .speeds { display: flex; gap: 3px; background: var(--panel-2); border: 1px solid var(--line); border-radius: 8px; padding: 3px; }
  .speeds button { font: inherit; font-family: var(--mono); font-size: 11px; border: 0; background: transparent; color: var(--ink-3); padding: 3px 8px; border-radius: 6px; cursor: pointer; }
  .speeds button[aria-pressed="true"] { background: var(--accent-wash); color: var(--accent-ink); }

  .strip-shell { position: relative; }
  .strip { position: relative; height: 44px; border-radius: 8px; background: var(--panel-2); border: 1px solid var(--line); overflow: hidden; cursor: pointer; }
  .seg { position: absolute; top: 0; bottom: 0; border-right: 1px solid var(--panel); opacity: 0.55; transition: opacity .2s; }
  .seg.played { opacity: 1; }
  .seg.err { background-image: repeating-linear-gradient(45deg, transparent, transparent 4px, rgba(0,0,0,0.10) 4px, rgba(0,0,0,0.10) 8px); }
  .seg.current { box-shadow: inset 0 0 0 2px var(--accent); opacity: 1; }
  .cost-area { position: absolute; left: 0; right: 0; bottom: 0; height: 100%; pointer-events: none; }
  .playhead { position: absolute; top: -3px; bottom: -3px; width: 2px; background: var(--accent); box-shadow: 0 0 10px var(--accent); pointer-events: none; z-index: 3; }
  .playhead::before { content:""; position: absolute; top: -1px; left: -4px; width: 10px; height: 10px; border-radius: 50%; background: var(--accent); box-shadow: 0 0 8px var(--accent); }

  /* signals lane (retry only) */
  .signals { position: relative; height: 26px; margin-top: 5px; border-radius: 7px; background: var(--panel-2); border: 1px solid var(--line); }
  .sig-cap { position: absolute; left: 8px; top: 50%; transform: translateY(-50%); font-family: var(--mono); font-size: 9px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--ink-3); pointer-events: none; z-index: 2; }
  .sig-m { position: absolute; top: 50%; transform: translate(-50%,-50%); width: 15px; height: 15px; border-radius: 5px; display: grid; place-items: center; cursor: pointer; border: 1px solid var(--panel); transition: transform .1s; z-index: 3; }
  .sig-m:hover { transform: translate(-50%,-50%) scale(1.3); }
  .sig-m svg { width: 9px; height: 9px; }
  .axis { display: flex; justify-content: space-between; font-family: var(--mono); font-size: 10px; color: var(--ink-3); margin-top: 6px; font-variant-numeric: tabular-nums; }

  .split { display: grid; grid-template-columns: 1.15fr 0.85fr; gap: 14px; align-items: start; }
  .panel { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); box-shadow: var(--shadow); }
  .panel-head { display: flex; align-items: center; gap: 10px; padding: 13px 16px; border-bottom: 1px solid var(--line); }
  .panel-head h2 { margin: 0; font-size: 13px; font-weight: 600; letter-spacing: -0.005em; }
  .panel-head .count { font-family: var(--mono); font-size: 11px; color: var(--ink-3); margin-left: auto; font-variant-numeric: tabular-nums; }

  .steps { padding: 6px 8px 10px; max-height: 640px; overflow-y: auto; }
  .step { display: grid; grid-template-columns: 30px 1fr auto; gap: 10px; align-items: start; padding: 10px 10px; border-radius: 10px; cursor: pointer; position: relative; transition: background .13s; }
  .step:hover { background: var(--panel-2); }
  .step[aria-selected="true"] { background: var(--accent-wash); }
  .step[data-current="true"]::before { content:""; position: absolute; left: 2px; top: 12px; bottom: 12px; width: 3px; border-radius: 2px; background: var(--accent); }
  .step .rail { display: grid; place-items: center; }
  .step .tick { width: 30px; height: 30px; border-radius: 9px; display: grid; place-items: center; background: var(--tc-wash); color: var(--tc); border: 1px solid transparent; }
  .step .tick svg { width: 16px; height: 16px; }
  .step .body .st-title { font-size: 13.5px; font-weight: 560; letter-spacing: -0.005em; display: flex; align-items: center; gap: 7px; flex-wrap: wrap; }
  .step .body .st-title code { font-family: var(--mono); font-size: 11.5px; background: var(--panel-2); border: 1px solid var(--line); border-radius: 5px; padding: 0.5px 5px; color: var(--ink); }
  .step .meta { text-align: right; font-family: var(--mono); font-size: 11px; color: var(--ink-3); font-variant-numeric: tabular-nums; white-space: nowrap; line-height: 1.5; }
  .stat-chip { font-family: var(--mono); font-size: 10px; letter-spacing: 0.04em; text-transform: uppercase; padding: 1px 6px; border-radius: 5px; font-weight: 600; }
  .stat-ok { color: var(--met); background: var(--met-wash); }
  .stat-err { color: var(--failed); background: var(--failed-wash); }

  /* step signal badges (retry only) */
  .sbadge { display: inline-flex; align-items: center; gap: 4px; font-family: var(--mono); font-size: 10px; font-weight: 600; padding: 1px 6px 1px 4px; border-radius: 5px; letter-spacing: 0.02em; }
  .sbadge svg { width: 11px; height: 11px; }
  .sbadge.retry { color: var(--stuck); background: var(--stuck-wash); }

  .insp { padding: 14px 16px; }
  .insp-section + .insp-section { margin-top: 16px; padding-top: 16px; border-top: 1px solid var(--line); }
  .insp h3 { font-family: var(--mono); font-size: 11px; letter-spacing: 0.07em; text-transform: uppercase; color: var(--ink-3); margin: 0 0 9px; }
  .judge-quote { font-size: 14px; line-height: 1.55; color: var(--ink); }
  .judge-quote b { color: var(--vc); font-weight: 640; }

  .io-kind { font-family: var(--mono); font-size: 10px; letter-spacing: 0.05em; text-transform: uppercase; color: var(--ink-3); margin-bottom: 4px; }
  .io-block { background: var(--panel-2); border: 1px solid var(--line); border-radius: 9px; padding: 10px 12px; font-family: var(--mono); font-size: 12px; line-height: 1.55; white-space: pre-wrap; word-break: break-word; overflow-x: auto; }
  .io-block + .io-kind { margin-top: 12px; }
  .io-sig { display: flex; align-items: flex-start; gap: 9px; border-radius: 9px; padding: 10px 12px; font-size: 12.5px; margin-bottom: 12px; background: var(--panel-2); border: 1px solid var(--line); }
  .io-sig svg { width: 17px; height: 17px; flex: none; margin-top: 1px; }
  .io-sig .st { font-weight: 600; }
  .insp-empty { color: var(--ink-3); font-size: 13px; }
  .cov-row { display: flex; justify-content: space-between; align-items: center; padding: 4px 0; font-size: 13px; }
  .cov-status { color: var(--ink-3); font-family: var(--mono); font-size: 11.5px; }
  .cov-status.cov-used { color: var(--met); }
  .pin-note { display: flex; align-items: center; gap: 6px; font-family: var(--mono); font-size: 10.5px; color: var(--accent-ink); margin-bottom: 10px; }
  .pin-note button { font: inherit; color: var(--ink-3); background: transparent; border: 0; cursor: pointer; text-decoration: underline; margin-left: auto; }

  .foot { margin-top: 22px; text-align: center; font-family: var(--mono); font-size: 11px; color: var(--ink-3); letter-spacing: 0.03em; }
  .foot a { color: var(--accent-ink); text-decoration: none; }
  .foot a:hover { text-decoration: underline; }

  @media (max-width: 880px) {
    .mission { grid-template-columns: 1fr; }
    .verdict { min-width: 0; }
    .split { grid-template-columns: 1fr; }
    .steps { max-height: none; }
  }
  @media (prefers-reduced-motion: reduce) { * { transition: none !important; } .play-btn { display: none; } }
</style>

<div class="wrap">
  <div class="topbar">
    <div class="brand">
      <svg class="brand-mark" viewBox="0 0 32 32" fill="none" aria-hidden="true">
        <circle cx="16" cy="16" r="15" stroke="var(--accent)" stroke-width="1.5" opacity="0.35"/>
        <path d="M6 22 C11 22 11 10 16 10 C21 10 21 20 26 20" stroke="var(--accent)" stroke-width="2.2" stroke-linecap="round"/>
        <circle cx="6" cy="22" r="2.6" fill="var(--accent)"/><circle cx="26" cy="20" r="2.6" fill="var(--accent)"/>
      </svg>
      <div><div class="brand-name">Tether</div><div class="brand-sub">Flight Recorder</div></div>
    </div>
    <a class="backlink" href="/">&larr; All runs</a>
    <a class="backlink" href="/harness">Harness</a>
    <button class="iconbtn" id="themeBtn" title="Toggle theme" aria-label="Toggle light/dark theme">
      <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="4.5"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4"/></svg>
    </button>
  </div>

  <section class="mission" id="mission"></section>

  <section class="trail-card">
    <div class="transport">
      <button class="play-btn" id="playBtn" aria-label="Play replay">
        <svg id="playIcon" viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
      </button>
      <div class="clock"><span id="clockNow">0:00</span><span class="sep"> / </span><span id="clockTot">0:00</span></div>
      <div class="speeds" id="speeds" role="group" aria-label="Playback speed">
        <button data-sp="1" aria-pressed="true">1&times;</button>
        <button data-sp="2" aria-pressed="false">2&times;</button>
        <button data-sp="4" aria-pressed="false">4&times;</button>
      </div>
      <div class="live-accrue">
        <div class="accrue"><span class="k">Cost so far</span><span class="v" id="accCost">$0.00</span></div>
        <div class="accrue"><span class="k">Steps</span><span class="v" id="accSteps">0</span></div>
        <div class="accrue"><span class="k">Tokens</span><span class="v" id="accTok">0</span></div>
      </div>
    </div>
    <div class="strip-shell">
      <div class="strip" id="strip" role="slider" aria-label="Scrub run timeline" tabindex="0" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">
        <svg class="cost-area" id="costArea" preserveAspectRatio="none" aria-hidden="true"></svg>
        <div class="playhead" id="playhead" style="left:0%"></div>
      </div>
      <div class="signals" id="signals"><span class="sig-cap">retries</span></div>
      <div class="axis"><span>t = 0s</span><span id="axisEnd">end</span></div>
    </div>
  </section>

  <section class="split">
    <div class="panel">
      <div class="panel-head">
        <h2>Steps</h2>
        <span class="count" id="stepCount"></span>
      </div>
      <div class="steps" id="steps"></div>
    </div>
    <div class="panel">
      <div class="panel-head"><h2 id="inspTitle">Verdict</h2></div>
      <div class="insp" id="insp"></div>
    </div>
  </section>

  <section class="panel">
    <div class="panel-head"><h2>Coverage</h2></div>
    <div class="insp" id="coverage"></div>
  </section>

  <div class="foot"><a href="/">&larr; back to all runs</a></div>
</div>

<script>
(function () {
  "use strict";

  const I = {
    reason: '<path d="M12 3a6 6 0 0 0-4 10.5V16h8v-2.5A6 6 0 0 0 12 3Z"/><path d="M9.5 19h5M10 21.5h4"/>',
    read:   '<path d="M4 5.5A1.5 1.5 0 0 1 5.5 4H11v15H5.5A1.5 1.5 0 0 1 4 17.5Z"/><path d="M20 5.5A1.5 1.5 0 0 0 18.5 4H13v15h5.5a1.5 1.5 0 0 0 1.5-1.5Z"/>',
    edit:   '<path d="M4 20h4L18.5 9.5a2 2 0 0 0 0-2.8l-1.2-1.2a2 2 0 0 0-2.8 0L4 16Z"/><path d="M13.5 6.5l4 4"/>',
    run:    '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M7.5 9.5l3 2.5-3 2.5M12.5 15h4"/>',
    tool:   '<path d="M14.5 6.5a3.5 3.5 0 0 0-4.8 4.2l-5 5a1.6 1.6 0 0 0 2.3 2.3l5-5a3.5 3.5 0 0 0 4.2-4.8l-2.1 2.1-1.9-.2-.2-1.9Z"/>',
    llm:    '<circle cx="12" cy="12" r="2.2"/><path d="M12 4v2M12 18v2M4 12h2M18 12h2M6.3 6.3l1.5 1.5M16.2 16.2l1.5 1.5M17.7 6.3l-1.5 1.5M7.8 16.2l-1.5 1.5"/>',
    search: '<circle cx="11" cy="11" r="6"/><path d="M20 20l-4.3-4.3"/>'
  };
  const SVG_LOOP = '<path d="M4 9a7 7 0 0 1 12-4l2 2M20 15a7 7 0 0 1-12 4l-2-2"/><path d="M18 3v4h-4M6 21v-4h4"/>';
  function icon(t) { return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' + (I[t] || I.tool) + '</svg>'; }
  function svg(p, sw) { return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="'+(sw||1.7)+'" stroke-linecap="round" stroke-linejoin="round">'+p+'</svg>'; }

  const TYPE_COLOR = {
    reason: ['#8A85F2', 'rgba(138,133,242,0.14)'], read: ['#5C93C4', 'rgba(92,147,196,0.14)'],
    edit: ['#19b0c0', 'rgba(25,176,192,0.15)'], run: ['#C98A5E', 'rgba(201,138,94,0.15)'],
    tool: ['#C77DBB', 'rgba(199,125,187,0.14)'], llm: ['#5FA8D3', 'rgba(95,168,211,0.14)'],
    search: ['#6FA96B', 'rgba(111,169,107,0.14)']
  };
  const VERDICT = {
    met:      { label:'Goal met',    color:'var(--met)',     wash:'var(--met-wash)',     line:'rgba(47,162,74,0.35)',  glyph:'<circle cx="12" cy="12" r="9"/><path d="M8 12.3l2.6 2.6L16 9.2"/>' },
    partial:  { label:'Partial',     color:'var(--partial)', wash:'var(--partial-wash)', line:'rgba(192,136,16,0.35)', glyph:'<circle cx="12" cy="12" r="9"/><path d="M12 7.5v5M12 15.7v.1"/>' },
    failed:   { label:'Goal missed', color:'var(--failed)',  wash:'var(--failed-wash)',  line:'rgba(220,74,56,0.35)',  glyph:'<circle cx="12" cy="12" r="9"/><path d="M9 9l6 6M15 9l-6 6"/>' },
    unjudged: { label:'Not judged',  color:'var(--ink-3)',   wash:'var(--panel-2)',      line:'var(--line)',           glyph:'<circle cx="12" cy="12" r="9"/><path d="M8 12h8"/>' }
  };

  // ---------- The run (injected by the server for this request) ----------
  const RUN = __RUN_JSON__;

  // ---------- State ----------
  let playT=0, playing=false, speed=1, raf=null, lastTs=null, pinnedStep=null;

  const $ = (id) => document.getElementById(id);
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  function runDur(r){ return r.steps.reduce((m,s)=>Math.max(m,s.start+s.dur),0); }
  function fmtT(s){ s=Math.max(0,Math.round(s)); return Math.floor(s/60)+':'+String(s%60).padStart(2,'0'); }
  function fmtCost(c){ return c==null ? '' : '$'+c.toFixed(c<1?3:2); }
  function fmtTok(t){ return t==null ? '' : (t>=1000 ? (t/1000).toFixed(1).replace(/\.0$/,'')+'k' : String(t)); }
  function escapeHtml(s){ return s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

  function ring(pct, color) {
    const r=18, C=2*Math.PI*r, on=pct/100*C;
    return '<svg width="46" height="46" viewBox="0 0 46 46">'
      + '<circle cx="23" cy="23" r="'+r+'" fill="none" stroke="var(--line)" stroke-width="5"/>'
      + '<circle cx="23" cy="23" r="'+r+'" fill="none" stroke="'+color+'" stroke-width="5" stroke-linecap="round" stroke-dasharray="'+on.toFixed(1)+' '+C.toFixed(1)+'"/>'
      + '<text class="pc-num" x="23" y="23" text-anchor="middle" dominant-baseline="central" transform="rotate(90 23 23)">'+pct+'</text></svg>';
  }

  function renderMission() {
    const r = RUN, v = VERDICT[r.verdict] || VERDICT.unjudged;
    const m = $('mission');
    m.style.setProperty('--vc', v.color); m.style.setProperty('--vc-wash', v.wash); m.style.setProperty('--vc-line', v.line);
    m.innerHTML =
      '<div>'
        + '<div class="goal-eyebrow"><span>Goal</span> · <span class="agent-pill">@'+escapeHtml(r.agent)+'</span></div>'
        + '<h1 class="goal-title">'+escapeHtml(r.goal)+'</h1>'
        + '<div class="goal-meta">'+gm('Duration',r.totals.dur)+gm('Total cost',fmtCost(r.totals.cost)||'—')+gm('Steps',String(r.totals.steps))+gm('Tokens',fmtTok(r.totals.tokens)||'—')+'</div>'
      + '</div>'
      + '<div class="verdict">'
        + '<div class="verdict-badge"><svg class="glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">'+v.glyph+'</svg>'
          + '<div class="vt"><span class="lab">Verdict</span><span class="val">'+v.label+'</span></div></div>'
        + (r.verdict!=='unjudged' && r.score!=null ? '<div class="pcredit">'+ring(Math.round(r.score*100), v.color)
            + '<div class="pc-side"><div class="conf-row"><span>Goal completion</span><span>'+Math.round(r.score*100)+'%</span></div></div></div>' : '')
      + '</div>';
  }
  function gm(k,v){ return '<div class="gm"><span class="k">'+k+'</span><span class="v">'+v+'</span></div>'; }

  function renderStrip() {
    const r = RUN, total = runDur(r), strip = $('strip');
    strip.querySelectorAll('.seg').forEach(n=>n.remove());
    r.steps.forEach((s,i) => {
      const seg = document.createElement('div');
      seg.className = 'seg'+(s.status==='err'?' err':''); const left=total? (s.start/total)*100 : 0, w=total? Math.max((s.dur/total)*100,1.2) : 100;
      seg.style.left=left+'%'; seg.style.width=w+'%'; seg.style.background = s.status==='err'?'var(--failed-wash)':TYPE_COLOR[s.type][1];
      seg.dataset.i=i; seg.title=s.title;
      seg.addEventListener('click',(e)=>{ e.stopPropagation(); seekTo(s.start+s.dur*0.5); pinStep(i); });
      strip.appendChild(seg);
    });
    const area = $('costArea'); const W=1000,H=100; area.setAttribute('viewBox','0 0 '+W+' '+H);
    const totalCost = r.steps.reduce((a,s)=>a+(s.cost||0),0);
    if (totalCost > 0 && total > 0) {
      let cum=0; const pts=[[0,H]];
      r.steps.forEach(s=>{ cum+=(s.cost||0); const x=((s.start+s.dur)/total)*W; const y=H-(cum/totalCost)*H*0.9; pts.push([x,y]); });
      pts.push([W,pts[pts.length-1][1]]); pts.push([W,H]);
      const d='M'+pts.map(p=>p[0].toFixed(1)+','+p[1].toFixed(1)).join(' L');
      area.innerHTML = '<path d="'+d+' Z" fill="var(--accent-wash)"/><path d="M0,'+H+' L'+pts.slice(1,-2).map(p=>p[0].toFixed(1)+','+p[1].toFixed(1)).join(' L')+'" fill="none" stroke="var(--accent)" stroke-width="1.5" opacity="0.5"/>';
    } else {
      area.innerHTML = '';
    }
    $('axisEnd').textContent='t = '+Math.round(total)+'s'; $('clockTot').textContent=fmtT(total);
    renderSignals();
  }

  function renderSignals() {
    const r = RUN, total = runDur(r), lane = $('signals');
    lane.querySelectorAll('.sig-m').forEach(n=>n.remove());
    if (!total) return;
    r.steps.forEach((s,i) => {
      if (!s.sig) return;
      s.sig.forEach(sg => {
        const at = ((s.start+s.dur*0.5)/total)*100;
        const m = document.createElement('div'); m.className='sig-m'; m.style.left=at+'%';
        m.style.background='var(--stuck)'; m.style.color='#fff'; m.style.borderColor='var(--stuck)';
        m.innerHTML = svg(SVG_LOOP,1.9); m.title = 'Retry loop ×'+sg.count+' — step '+(i+1);
        m.addEventListener('click', ()=>{ pinStep(i); seekTo(s.start+0.3); });
        lane.appendChild(m);
      });
    });
  }

  function sBadges(s) {
    if (!s.sig) return '';
    return s.sig.map(sg => '<span class="sbadge retry">'+svg(SVG_LOOP,2)+'&times;'+sg.count+'</span>').join('');
  }

  function renderSteps() {
    const r = RUN; const el = $('steps');
    $('stepCount').textContent = r.steps.length+' step'+(r.steps.length===1?'':'s');
    if (!r.steps.length) { el.innerHTML = '<div class="insp-empty" style="padding:14px">No steps logged for this run.</div>'; return; }
    el.innerHTML = r.steps.map((s,i) => {
      const [c,w] = TYPE_COLOR[s.type];
      const stat = s.status==='err' ? '<span class="stat-chip stat-err">error</span>' : '';
      const metaBits = [ 't+'+fmtT(s.start), s.dur+'s'+(fmtCost(s.cost)?(' · '+fmtCost(s.cost)):'') ];
      return '<div class="step" data-i="'+i+'" role="button" tabindex="0" aria-selected="false" style="--tc:'+c+';--tc-wash:'+w+'">'
        + '<div class="rail"><div class="tick">'+icon(s.type)+'</div></div>'
        + '<div class="body"><div class="st-title">'+escapeHtml(s.title)+' '+stat+sBadges(s)+'</div></div>'
        + '<div class="meta">'+metaBits.join('<br>')+'</div></div>';
    }).join('');
    el.querySelectorAll('.step').forEach(node => {
      const i=+node.dataset.i;
      node.addEventListener('click', ()=>{ pinStep(i); seekTo(RUN.steps[i].start+0.3); });
      node.addEventListener('keydown',(e)=>{ if(e.key==='Enter'||e.key===' '){ e.preventDefault(); pinStep(i); seekTo(RUN.steps[i].start+0.3); } });
    });
  }

  function currentStepIndex(){ const r=RUN; let idx=-1; r.steps.forEach((s,i)=>{ if(playT>=s.start) idx=i; }); return idx; }

  function renderInspector() {
    const r = RUN;
    if (pinnedStep!=null && r.steps[pinnedStep]) renderStepIO(r.steps[pinnedStep], pinnedStep);
    else renderVerdict(r);
  }

  function renderVerdict(r) {
    $('inspTitle').textContent = 'Verdict';
    const insp = $('insp');
    if (r.verdict==='unjudged') {
      insp.innerHTML = '<div class="insp-section"><div class="insp-empty">No verdict — no goal-attainment judge was configured for this run (set TRAIL_JUDGE_PROVIDER/TRAIL_JUDGE_API_KEY to enable one).</div></div>';
      return;
    }
    const v = VERDICT[r.verdict] || VERDICT.unjudged;
    insp.style.setProperty('--vc', v.color);
    insp.innerHTML = '<div class="insp-section"><h3>LLM judge</h3><div class="judge-quote">'+escapeHtml(r.narrative||'')+'</div></div>';
  }

  function coverageList(entries, emptyMsg) {
    if (!entries.length) return '<div class="insp-empty">'+emptyMsg+'</div>';
    return entries.map(function(e) {
      const used = e.usedCount > 0;
      const status = used ? '✓ used ('+e.usedCount+' step'+(e.usedCount===1?'':'s')+')' : '— not used';
      return '<div class="cov-row"><span>'+escapeHtml(e.name)+'</span><span class="cov-status'+(used?' cov-used':'')+'">'+status+'</span></div>';
    }).join('');
  }

  function renderCoverage() {
    const cov = RUN.coverage;
    const el = $('coverage');
    if (!cov || !cov.entries.length) {
      el.innerHTML = '<div class="insp-empty">No skills, sub-agents, or MCP servers were registered for this run — nothing to show coverage for.</div>';
      return;
    }
    if (!cov.tracked) {
      el.innerHTML = '<div class="insp-empty">Coverage not tracked for this run — no step reported which skill, sub-agent, or MCP server it came from.</div>';
      return;
    }
    const skills = cov.entries.filter(function(e){ return e.type==='skill'; });
    const subAgents = cov.entries.filter(function(e){ return e.type==='sub_agent'; });
    const mcpServers = cov.entries.filter(function(e){ return e.type==='mcp_server'; });
    el.innerHTML =
      '<div class="insp-section"><h3>Skills</h3>'+coverageList(skills, 'No skills registered for this run.')+'</div>'
      + '<div class="insp-section"><h3>Sub-agents</h3>'+coverageList(subAgents, 'No sub-agents registered for this run.')+'</div>'
      + '<div class="insp-section"><h3>MCP servers</h3>'+coverageList(mcpServers, 'No MCP servers registered for this run.')+'</div>';
  }

  function renderStepIO(s, i) {
    $('inspTitle').textContent = (s.title)+' · step '+(i+1);
    const insp = $('insp');
    let inner = '<div class="pin-note"><span>&#9670; pinned to step '+(i+1)+'</span><button id="unpin">back to verdict</button></div>';
    if (s.sig) inner += s.sig.map(sg => '<div class="io-sig"><span style="color:var(--stuck);display:grid;place-items:center">'+svg(SVG_LOOP,1.9)+'</span><div><span class="st" style="color:var(--stuck)">Retry loop &times;'+sg.count+'</span><div style="color:var(--ink-2);margin-top:2px">'+escapeHtml(sg.detail)+'</div></div></div>').join('');
    if (s.io && s.io.length) inner += s.io.map(p=>'<div class="io-kind">'+escapeHtml(p[0])+'</div><div class="io-block">'+escapeHtml(p[1])+'</div>').join('');
    else inner += '<div class="insp-empty">No input/output recorded for this step.</div>';
    insp.innerHTML = inner;
    const un=$('unpin'); if (un) un.addEventListener('click', ()=>pinStep(null));
  }

  function updatePlayhead() {
    const r=RUN, total=runDur(r); const pct=total? Math.min(100,(playT/total)*100) : 0;
    $('playhead').style.left=pct+'%'; $('clockNow').textContent=fmtT(playT);
    $('strip').setAttribute('aria-valuenow', Math.round(pct));
    let cost=0,tok=0,steps=0;
    r.steps.forEach(s=>{ if(playT>=s.start+s.dur){ cost+=(s.cost||0); tok+=(s.tok||0); steps++; } else if(playT>=s.start && s.dur>0){ const f=(playT-s.start)/s.dur; cost+=(s.cost||0)*f; tok+=Math.round((s.tok||0)*f); } });
    $('accCost').textContent=fmtCost(cost)||'$0.00'; $('accSteps').textContent=steps+'/'+r.steps.length; $('accTok').textContent=fmtTok(tok)||'0';
    const ci=currentStepIndex();
    $('strip').querySelectorAll('.seg').forEach(seg=>{ const i=+seg.dataset.i, s=r.steps[i]; seg.classList.toggle('played',playT>=s.start); seg.classList.toggle('current',i===ci); });
    $('steps').querySelectorAll('.step').forEach(node=>{ const i=+node.dataset.i; node.setAttribute('data-current', i===ci?'true':'false'); node.setAttribute('aria-selected',(pinnedStep===i)?'true':'false'); });
    if (pinnedStep==null && ci>=0 && playing) { const node=$('steps').querySelector('.step[data-i="'+ci+'"]'); if(node) node.scrollIntoView({block:'nearest', behavior:reduceMotion?'auto':'smooth'}); }
  }
  function seekTo(t){ const total=runDur(RUN); playT=Math.max(0,Math.min(total,t)); updatePlayhead(); }
  function pinStep(i){ pinnedStep=i; renderInspector(); updatePlayhead(); }

  function tick(ts) {
    if (!playing) return;
    if (lastTs==null) lastTs=ts;
    const dt=(ts-lastTs)/1000; lastTs=ts; playT+=dt*speed;
    const total=runDur(RUN);
    if (playT>=total){ playT=total; setPlaying(false); updatePlayhead(); return; }
    updatePlayhead(); raf=requestAnimationFrame(tick);
  }
  function setPlaying(p) {
    playing=p; lastTs=null;
    $('playIcon').innerHTML = p ? '<path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z"/>' : '<path d="M8 5v14l11-7z"/>';
    $('playBtn').setAttribute('aria-label', p?'Pause replay':'Play replay');
    if (p) { if(playT>=runDur(RUN)) playT=0; pinStep(null); raf=requestAnimationFrame(tick); }
    else if (raf) cancelAnimationFrame(raf);
  }

  function initControls() {
    $('playBtn').addEventListener('click', ()=>setPlaying(!playing));
    $('speeds').querySelectorAll('button').forEach(b=>b.addEventListener('click',()=>{ speed=+b.dataset.sp; $('speeds').querySelectorAll('button').forEach(x=>x.setAttribute('aria-pressed',x===b)); }));
    const strip=$('strip');
    function seekFromEvent(e){ const rect=strip.getBoundingClientRect(); const x=((e.touches?e.touches[0].clientX:e.clientX)-rect.left)/rect.width; seekTo(x*runDur(RUN)); }
    let dragging=false;
    strip.addEventListener('mousedown',(e)=>{ if(e.target.classList.contains('seg')) return; dragging=true; setPlaying(false); seekFromEvent(e); });
    window.addEventListener('mousemove',(e)=>{ if(dragging) seekFromEvent(e); });
    window.addEventListener('mouseup',()=>dragging=false);
    strip.addEventListener('keydown',(e)=>{ const total=runDur(RUN); if(e.key==='ArrowRight'){ seekTo(playT+total*0.02); e.preventDefault(); } if(e.key==='ArrowLeft'){ seekTo(playT-total*0.02); e.preventDefault(); } });
    $('themeBtn').addEventListener('click', ()=>{ const root=document.documentElement; const isDark=(root.getAttribute('data-theme')||(window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'))==='dark'; root.setAttribute('data-theme', isDark?'light':'dark'); });
    document.addEventListener('keydown',(e)=>{ if(e.target.tagName==='INPUT'||e.target.tagName==='TEXTAREA') return; if(e.key===' '){ e.preventDefault(); setPlaying(!playing); } });
  }

  renderMission(); renderStrip(); renderSteps(); renderInspector(); renderCoverage(); updatePlayhead(); initControls();
})();
</script>
`;

export function renderFlightRecorderPage(run: RunView, coverage: CoverageView | null): string {
	// Escape `<` so a field like `</script><img src=x onerror=...>` can't break out of the
	// inline <script> block, and escape the JS line-terminator characters (valid in JSON
	// strings, illegal inside a JS string literal in older engines). Use a function replacer
	// (not a string one) so a goal containing "$&" / "$'" etc. can't trigger String.replace's
	// special replacement-pattern handling and corrupt the surrounding template.
	const json = JSON.stringify({ ...run, coverage })
		.replace(/</g, "\\u003c")
		.replace(/\u2028/g, "\\u2028")
		.replace(/\u2029/g, "\\u2029");
	return TEMPLATE.replace("__RUN_JSON__", () => json);
}
