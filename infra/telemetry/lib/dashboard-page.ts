/**
 * The internal telemetry dashboard — one self-contained HTML document.
 *
 * Same shape as the key-rotation page in `admin.ts`: no framework, no external
 * resource of any kind, a strict CSP, noindex, no-store. It is an internal tool
 * for a handful of people, and its whole security story is the ingest token.
 *
 * The token is held in `sessionStorage` and sent as `x-dailies-token` on every
 * request. It is never put in a URL — a query-string token would land in
 * browser history, in the Referer header, and in every access log on the way.
 *
 * Charts are hand-drawn SVG (see the data-viz notes at DRAW below). Colors,
 * mark specs, and the palette ordering come from the shared data-viz method;
 * every categorical ordering used here was run through its validator in both
 * light and dark mode.
 */

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Dailies telemetry</title>
<style>
:root {
  color-scheme: light dark;
  --plane: #f9f9f7;
  --surface: #fcfcfb;
  --ink: #0b0b0b;
  --ink-2: #52514e;
  --muted: #898781;
  --grid: #e1e0d9;
  --axis: #c3c2b7;
  --border: rgba(11, 11, 11, .10);
  --field: #ffffff;
  --s1: #2a78d6;
  --s2: #eb6834;
  --s3: #1baf7a;
  --s4: #eda100;
  --s5: #e87ba4;
  --other: #898781;
  --lvl-info: #2a78d6;
  --lvl-warn: #eda100;
  --lvl-other: #4a3aa7;
  --lvl-error: #e34948;
  --good: #006300;
  --bad: #d03b3b;
  --wash: rgba(11, 11, 11, .045);
}
@media (prefers-color-scheme: dark) {
  :root {
    --plane: #0d0d0d;
    --surface: #1a1a19;
    --ink: #ffffff;
    --ink-2: #c3c2b7;
    --muted: #898781;
    --grid: #2c2c2a;
    --axis: #383835;
    --border: rgba(255, 255, 255, .10);
    --field: #111110;
    --s1: #3987e5;
    --s2: #d95926;
    --s3: #199e70;
    --s4: #c98500;
    --s5: #d55181;
    --lvl-info: #3987e5;
    --lvl-warn: #c98500;
    --lvl-other: #9085e9;
    --lvl-error: #e66767;
    --good: #0ca30c;
    --bad: #d03b3b;
    --wash: rgba(255, 255, 255, .06);
  }
}
* { box-sizing: border-box; }
html, body { margin: 0; }
body {
  background: var(--plane);
  color: var(--ink);
  font: 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
  -webkit-text-size-adjust: 100%;
}
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
h1 { font-size: 15px; font-weight: 600; margin: 0; letter-spacing: .01em; }
h2 { font-size: 13px; font-weight: 600; margin: 0; }
p { margin: 0; }
button, input, select { font: inherit; color: inherit; }
button { cursor: pointer; }

/* ---------------------------------------------------------------- chrome */
header {
  position: sticky; top: 0; z-index: 20;
  background: var(--plane);
  border-bottom: 1px solid var(--border);
  padding: 10px 16px 0;
}
.topline { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.topline .spacer { flex: 1 1 auto; }
.ghost {
  background: transparent; border: 1px solid var(--border); border-radius: 6px;
  padding: 5px 10px; color: var(--ink-2); font-size: 13px;
}
.ghost:hover { background: var(--wash); color: var(--ink); }
[role=tablist] { display: flex; gap: 2px; margin: 10px 0 0; }
[role=tab] {
  background: transparent; border: 0; border-bottom: 2px solid transparent;
  padding: 8px 12px; color: var(--ink-2); font-size: 13px; font-weight: 500;
}
[role=tab]:hover { color: var(--ink); }
[role=tab][aria-selected=true] { color: var(--ink); border-bottom-color: var(--s1); }
main { padding: 16px; max-width: 1400px; margin: 0 auto; }
[role=tabpanel][hidden] { display: none; }

.filters {
  display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  margin: 0 0 16px;
}
.filters label { display: inline-flex; align-items: center; gap: 6px; color: var(--ink-2); font-size: 13px; }
.filters select, .filters input, .field {
  background: var(--field); border: 1px solid var(--border); border-radius: 6px;
  padding: 5px 8px; font-size: 13px;
}
.note { color: var(--muted); font-size: 12px; }
.partial-note { margin: -4px 0 12px; }
.busy { opacity: .45; transition: opacity .12s ease; }

/* ----------------------------------------------------------------- cards */
/* min() on the track floor: a bare minmax(320px, 1fr) column cannot shrink
   below 320px, so on a 320px screen the 12px page padding pushes the grid
   wider than the viewport and the whole page scrolls sideways. */
.grid { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(min(320px, 100%), 1fr)); }
.card {
  background: var(--surface); border: 1px solid var(--border); border-radius: 10px;
  padding: 14px; position: relative; min-width: 0;
}
.card.wide { grid-column: 1 / -1; }
.card > header { position: static; border: 0; padding: 0; background: none; margin-bottom: 10px; }
.card .sub { color: var(--muted); font-size: 12px; margin-top: 2px; }

.kpis { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(min(200px, 100%), 1fr)); margin-bottom: 12px; }
.kpi .label { color: var(--ink-2); font-size: 12px; }
.kpi .value { font-size: 30px; font-weight: 600; line-height: 1.1; margin-top: 4px; }
.kpi.hero .value { font-size: 52px; }
.kpi .delta { font-size: 12px; color: var(--muted); margin-top: 4px; display: flex; align-items: center; gap: 6px; }
.kpi .delta .up { color: var(--good); }
.kpi .delta .down { color: var(--bad); }
.kpi .spark { margin-top: 8px; height: 26px; }
.spark-plot { width: 100%; height: 26px; }
.spark-plot svg { display: block; overflow: visible; }

/* ---------------------------------------------------------------- charts */
.plot { position: relative; width: 100%; }
.plot svg { display: block; width: 100%; height: auto; overflow: visible; }
.legend { display: flex; flex-wrap: wrap; gap: 4px 14px; margin-top: 10px; }
.legend span { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--ink-2); }
.legend i { display: inline-block; border-radius: 2px; }
.legend i.box { width: 10px; height: 10px; }
.legend i.line { width: 14px; height: 2px; border-radius: 1px; }
.tip {
  position: absolute; pointer-events: none; opacity: 0; transform: translate(-50%, -100%);
  background: var(--surface); border: 1px solid var(--border); border-radius: 8px;
  padding: 8px 10px; font-size: 12px; min-width: 128px; z-index: 10;
  box-shadow: 0 6px 20px rgba(0, 0, 0, .12);
}
.tip .head { color: var(--ink-2); margin-bottom: 5px; }
.tip .row { display: flex; align-items: center; gap: 8px; }
.tip .row b { font-weight: 600; font-variant-numeric: tabular-nums; margin-left: auto; }
.tip .row i { width: 12px; height: 2px; border-radius: 1px; flex: 0 0 auto; }
.tip .row span { color: var(--ink-2); }
details.tbl { margin-top: 10px; }
details.tbl summary { color: var(--muted); font-size: 12px; cursor: pointer; }
details.tbl .scroll { max-height: 280px; overflow: auto; margin-top: 8px; }

/* ---------------------------------------------------------------- tables */
table { border-collapse: collapse; width: 100%; font-size: 12.5px; }
th, td { text-align: left; padding: 6px 10px 6px 0; border-bottom: 1px solid var(--grid); white-space: nowrap; }
th { color: var(--muted); font-weight: 500; position: sticky; top: 0; background: var(--surface); }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
tbody tr.click:hover { background: var(--wash); cursor: pointer; }
tbody tr.on { background: var(--wash); }
.scrollx { overflow-x: auto; }
.empty { color: var(--muted); font-size: 13px; padding: 22px 0; text-align: center; }

.chip {
  display: inline-block; border-radius: 4px; padding: 1px 6px; font-size: 11px;
  border: 1px solid var(--border); color: var(--ink-2);
}
.chip.error, .chip.uncaught, .chip.unhandledRejection { border-color: var(--lvl-error); color: var(--lvl-error); }
.chip.warn { border-color: var(--lvl-warn); color: var(--lvl-warn); }
.chip.info { border-color: var(--lvl-info); color: var(--lvl-info); }

/* ------------------------------------------------------------------ logs */
.logtools { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin: 10px 0; }
.logtools input[type=search] { flex: 1 1 220px; min-width: 0; }
.loglist { max-height: 62vh; overflow: auto; border-top: 1px solid var(--grid); }
.logrow {
  display: grid; grid-template-columns: 88px 68px 1fr; gap: 10px;
  padding: 4px 0; border-bottom: 1px solid var(--grid);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px;
}
.logrow .t { color: var(--muted); font-variant-numeric: tabular-nums; }
.logrow .msg { white-space: pre-wrap; word-break: break-word; }
.logrow.error .msg, .logrow.uncaught .msg, .logrow.unhandledRejection .msg { color: var(--lvl-error); }

/* --------------------------------------------------------------- issues */
.issue { border-bottom: 1px solid var(--grid); padding: 12px 0; }
.issue .top { display: flex; gap: 12px; align-items: baseline; flex-wrap: wrap; }
.issue .count { font-size: 20px; font-weight: 600; font-variant-numeric: tabular-nums; }
.issue .sig { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px; word-break: break-word; flex: 1 1 260px; min-width: 0; }
.issue .meta { color: var(--muted); font-size: 12px; margin-top: 6px; display: flex; gap: 14px; flex-wrap: wrap; }
.issue pre {
  margin: 8px 0 0; padding: 10px; background: var(--wash); border-radius: 6px;
  font-size: 12px; white-space: pre-wrap; word-break: break-word; max-height: 240px; overflow: auto;
}
.issue summary { color: var(--muted); font-size: 12px; cursor: pointer; margin-top: 6px; }

/* ------------------------------------------------------------------ gate */
#gate {
  position: fixed; inset: 0; z-index: 50; display: none;
  background: var(--plane); align-items: center; justify-content: center; padding: 24px;
}
#gate.on { display: flex; }
#gate form { width: 100%; max-width: 22rem; }
#gate h2 { margin-bottom: 4px; }
#gate p.note { margin-bottom: 14px; }
#gate input { width: 100%; margin-bottom: 10px; }
#gate button[type=submit] {
  width: 100%; background: var(--s1); color: #fff; border: 0; border-radius: 6px; padding: 8px;
}
.bad { color: var(--bad); }

@media (max-width: 640px) {
  main { padding: 12px; }
  header { padding: 8px 12px 0; }
  .kpi.hero .value { font-size: 40px; }
  .logrow { grid-template-columns: 68px 1fr; }
  .logrow .lvl { display: none; }
}
</style>
</head>
<body>

<div id="gate" aria-hidden="true">
  <form id="gate-form" autocomplete="off">
    <h2>Dailies telemetry</h2>
    <p class="note">Internal dashboard. Paste the ingest token to continue.</p>
    <input id="gate-token" class="field" type="password" autocomplete="off" spellcheck="false"
           placeholder="Ingest token" required>
    <button type="submit">Open dashboard</button>
    <p id="gate-msg" class="note" role="status" aria-live="polite"></p>
  </form>
</div>

<header>
  <div class="topline">
    <h1>Dailies telemetry</h1>
    <span class="note" id="stamp"></span>
    <span class="spacer"></span>
    <button class="ghost" id="reload" type="button">Refresh</button>
    <button class="ghost" id="signout" type="button">Forget token</button>
  </div>
  <div role="tablist" aria-label="Views">
    <button role="tab" id="tab-overview" aria-controls="panel-overview" aria-selected="true">Overview</button>
    <button role="tab" id="tab-engineering" aria-controls="panel-engineering" aria-selected="false">Engineering</button>
    <button role="tab" id="tab-issues" aria-controls="panel-issues" aria-selected="false">Issues</button>
  </div>
</header>

<main>
  <section role="tabpanel" id="panel-overview" aria-labelledby="tab-overview">
    <div class="filters">
      <label>Range
        <select id="ov-range">
          <option value="7">Last 7 days</option>
          <option value="14" selected>Last 14 days</option>
          <option value="30">Last 30 days</option>
        </select>
      </label>
      <span class="note" id="ov-note"></span>
    </div>
    <div id="ov-body"></div>
  </section>

  <section role="tabpanel" id="panel-engineering" aria-labelledby="tab-engineering" hidden>
    <div class="filters">
      <label>Day <input id="eng-day" class="field" type="date"></label>
      <span class="note" id="eng-note"></span>
    </div>
    <div id="eng-body"></div>
  </section>

  <section role="tabpanel" id="panel-issues" aria-labelledby="tab-issues" hidden>
    <div class="filters">
      <label>Range
        <select id="is-range">
          <option value="7" selected>Last 7 days</option>
          <option value="14">Last 14 days</option>
        </select>
      </label>
      <label>Levels
        <select id="is-level">
          <option value="error" selected>Errors only</option>
          <option value="all">Errors and warnings</option>
        </select>
      </label>
      <span class="note" id="is-note"></span>
    </div>
    <div id="is-body"></div>
  </section>
</main>

<script>
(function () {
  'use strict';

  var KEY = 'dailies-telemetry-token';
  var NS = 'http://www.w3.org/2000/svg';
  var SERIES = ['--s1', '--s2', '--s3', '--s4', '--s5'];
  var OTHER = '--other';
  // Level -> slot, in the stacking order that cleared the CVD and
  // normal-vision gates in both modes: blue, yellow, violet, red.
  var LEVEL_ORDER = ['info', 'warn', 'other', 'error'];
  var LEVEL_VAR = {
    info: '--lvl-info', warn: '--lvl-warn', other: '--lvl-other', error: '--lvl-error'
  };
  var ERROR_LEVELS = { error: 1, uncaught: 1, unhandledRejection: 1 };

  var state = {
    token: null,
    tab: 'overview',
    ovRange: 14,
    isRange: 7,
    isLevel: 'error',
    engDay: null,
    drill: null,
    drillShown: 800
  };
  var cache = new Map();

  /* ------------------------------------------------------------ helpers */

  function $(id) { return document.getElementById(id); }

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function svg(name, attrs) {
    var node = document.createElementNS(NS, name);
    for (var key in attrs) {
      if (Object.prototype.hasOwnProperty.call(attrs, key)) node.setAttribute(key, String(attrs[key]));
    }
    return node;
  }

  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

  function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#888';
  }

  function utcToday() { return new Date().toISOString().slice(0, 10); }

  function addDays(day, delta) {
    return new Date(Date.parse(day + 'T00:00:00Z') + delta * 86400000).toISOString().slice(0, 10);
  }

  function full(n) { return (n === null || n === undefined || isNaN(n)) ? '—' : Number(n).toLocaleString('en-US'); }

  function compact(n) {
    if (n === null || n === undefined || isNaN(n)) return '—';
    var abs = Math.abs(n);
    if (abs >= 1000000) return (n / 1000000).toFixed(abs >= 10000000 ? 0 : 1).replace(/\\.0$/, '') + 'M';
    if (abs >= 1000) return (n / 1000).toFixed(abs >= 10000 ? 0 : 1).replace(/\\.0$/, '') + 'K';
    return String(n);
  }

  function shortDay(day) { return day ? day.slice(5).replace('-', '/') : ''; }

  function clockOf(iso) {
    if (!iso || iso.length < 19) return '';
    return iso.slice(11, 19);
  }

  function levelSlot(level) {
    if (level === 'info') return 'info';
    if (level === 'warn') return 'warn';
    if (ERROR_LEVELS[level]) return 'error';
    return 'other';
  }

  function sumValues(obj) {
    var total = 0;
    for (var key in obj) { if (Object.prototype.hasOwnProperty.call(obj, key)) total += obj[key]; }
    return total;
  }

  function versionRank(v) {
    var parts = String(v).split('.').map(function (p) { return parseInt(p, 10) || 0; });
    return (parts[0] || 0) * 1000000 + (parts[1] || 0) * 1000 + (parts[2] || 0);
  }

  /* ------------------------------------------------------------ transport */

  function AuthError() { this.name = 'AuthError'; }

  function api(params) {
    var query = new URLSearchParams(params).toString();
    return fetch('/api/stats?' + query, { headers: { 'x-dailies-token': state.token } })
      .then(function (res) {
        if (res.status === 401) throw new AuthError();
        if (!res.ok) {
          return res.text().then(function (body) {
            var message = body;
            try { message = JSON.parse(body).error || body; } catch (e) { /* plain text */ }
            throw new Error(res.status + ': ' + message);
          });
        }
        return res.json();
      });
  }

  function cached(params) {
    var key = JSON.stringify(params);
    if (cache.has(key)) return Promise.resolve(cache.get(key));
    return api(params).then(function (data) { cache.set(key, data); return data; });
  }

  /* ---------------------------------------------------------------- gate */

  function openGate(message) {
    var gate = $('gate');
    gate.classList.add('on');
    gate.setAttribute('aria-hidden', 'false');
    $('gate-msg').className = message ? 'note bad' : 'note';
    $('gate-msg').textContent = message || '';
    $('gate-token').focus();
  }

  function closeGate() {
    var gate = $('gate');
    gate.classList.remove('on');
    gate.setAttribute('aria-hidden', 'true');
  }

  function signOut(message) {
    state.token = null;
    cache.clear();
    try { sessionStorage.removeItem(KEY); } catch (e) { /* private mode */ }
    openGate(message);
  }

  $('gate-form').addEventListener('submit', function (event) {
    event.preventDefault();
    var value = $('gate-token').value.trim();
    if (!value) return;
    state.token = value;
    $('gate-msg').className = 'note';
    $('gate-msg').textContent = 'Checking…';
    api({ day: utcToday() }).then(function () {
      try { sessionStorage.setItem(KEY, value); } catch (e) { /* private mode */ }
      $('gate-token').value = '';
      closeGate();
      render();
    }).catch(function (error) {
      state.token = null;
      openGate(error instanceof AuthError ? '401: that token was rejected.' : String(error.message || error));
    });
  });

  $('signout').addEventListener('click', function () { signOut(''); });

  /* -------------------------------------------------------------- DRAW
   * A small SVG chart layer. Shared rules, applied by every chart here:
   *   - one y axis, never two;
   *   - 2px lines, <=24px bars, 4px rounded data-end, 2px surface gap
   *     between stacked segments, 2px surface ring on end dots;
   *   - hairline solid gridlines one step off the surface;
   *   - a legend whenever there are two or more series, plus a data table
   *     under every chart, so no value is reachable only by hovering.
   * Charts redraw on resize because the geometry is in pixels — a squashed
   * viewBox would distort the type.
   */

  var redraws = [];

  function redrawAll() {
    for (var i = 0; i < redraws.length; i += 1) {
      if (document.body.contains(redraws[i].host)) redraws[i].draw();
    }
    redraws = redraws.filter(function (entry) { return document.body.contains(entry.host); });
  }

  var resizeTimer = null;
  window.addEventListener('resize', function () {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(redrawAll, 120);
  });

  // Mark and legend colours are read from the CSS variables when the tab is
  // built and written into the SVG, so a light/dark switch has to rebuild the
  // tab — otherwise the charts keep the other mode's grid and series colours on
  // the new surface. render() reads the memoised response, not the network.
  var darkQuery = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  if (darkQuery) {
    var onScheme = function () { render(); };
    if (darkQuery.addEventListener) darkQuery.addEventListener('change', onScheme);
    else if (darkQuery.addListener) darkQuery.addListener(onScheme);
  }

  /**
   * A chart first draws at whatever width the plot happens to have — which is
   * the wrong one when the card is still being laid out or its tab is hidden.
   * Watching the plot itself redraws at the real width, so the SVG never gets
   * scaled by CSS (that shrinks the type along with the geometry).
   */
  var plotObserver = window.ResizeObserver ? new window.ResizeObserver(function (entries) {
    for (var i = 0; i < entries.length; i += 1) {
      var target = entries[i].target;
      var next = Math.round(entries[i].contentRect.width);
      if (!next || next === target.lastPlotWidth || !target.redraw) continue;
      target.lastPlotWidth = next;
      target.redraw();
    }
  }) : null;

  function watchPlot(host, plot, draw) {
    redraws.push({ host: host, draw: draw });
    if (plotObserver) {
      plot.redraw = draw;
      plot.lastPlotWidth = Math.round(plot.clientWidth);
      plotObserver.observe(plot);
    }
  }

  function niceTicks(max) {
    if (!isFinite(max) || max <= 0) return { top: 1, ticks: [0, 1] };
    var raw = max / 4;
    var mag = Math.pow(10, Math.floor(Math.log(raw) / Math.LN10));
    var norm = raw / mag;
    var step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
    var top = Math.ceil(max / step) * step;
    var ticks = [];
    for (var v = 0; v <= top + step / 2; v += step) ticks.push(Math.round(v * 1000) / 1000);
    return { top: top, ticks: ticks };
  }

  function barPath(x, y, w, h, r, side) {
    var rad = Math.max(0, Math.min(r, w / 2, h));
    if (rad < 1 || (side !== 'top' && side !== 'right')) {
      return 'M' + x + ' ' + y + 'h' + w + 'v' + h + 'h' + (-w) + 'z';
    }
    if (side === 'top') {
      return 'M' + x + ' ' + (y + h) + 'V' + (y + rad) +
        'a' + rad + ' ' + rad + ' 0 0 1 ' + rad + ' ' + (-rad) +
        'h' + (w - 2 * rad) +
        'a' + rad + ' ' + rad + ' 0 0 1 ' + rad + ' ' + rad +
        'V' + (y + h) + 'z';
    }
    return 'M' + x + ' ' + y + 'h' + (w - rad) +
      'a' + rad + ' ' + rad + ' 0 0 1 ' + rad + ' ' + rad +
      'v' + (h - 2 * rad) +
      'a' + rad + ' ' + rad + ' 0 0 1 ' + (-rad) + ' ' + rad +
      'H' + x + 'z';
  }

  function makeTip(plot) {
    var tip = el('div', 'tip');
    plot.appendChild(tip);
    return {
      node: tip,
      show: function (x, y, title, rows) {
        clear(tip);
        var head = el('div', 'head', title);
        tip.appendChild(head);
        for (var i = 0; i < rows.length; i += 1) {
          var row = el('div', 'row');
          if (rows[i].color) {
            var key = el('i');
            key.style.background = rows[i].color;
            row.appendChild(key);
          }
          row.appendChild(el('span', null, rows[i].name));
          row.appendChild(el('b', null, rows[i].value));
          tip.appendChild(row);
        }
        var width = plot.clientWidth;
        tip.style.opacity = '1';
        tip.style.left = Math.max(70, Math.min(width - 70, x)) + 'px';
        tip.style.top = Math.max(30, y - 10) + 'px';
      },
      hide: function () { tip.style.opacity = '0'; }
    };
  }

  function legendFor(series, kind) {
    var box = el('div', 'legend');
    for (var i = 0; i < series.length; i += 1) {
      var item = el('span');
      var swatch = el('i', kind === 'line' ? 'line' : 'box');
      swatch.style.background = series[i].color;
      item.appendChild(swatch);
      item.appendChild(document.createTextNode(series[i].name));
      box.appendChild(item);
    }
    return box;
  }

  function dataTable(labels, series, fmt, firstColumn) {
    var wrap = el('details', 'tbl');
    wrap.appendChild(el('summary', null, 'Data table'));
    var scroll = el('div', 'scroll');
    var table = el('table');
    var head = el('tr');
    head.appendChild(el('th', null, firstColumn || 'Day'));
    for (var s = 0; s < series.length; s += 1) head.appendChild(el('th', 'num', series[s].name));
    var thead = el('thead');
    thead.appendChild(head);
    table.appendChild(thead);
    var body = el('tbody');
    for (var i = 0; i < labels.length; i += 1) {
      var row = el('tr');
      row.appendChild(el('td', null, labels[i]));
      for (var j = 0; j < series.length; j += 1) {
        row.appendChild(el('td', 'num', fmt(series[j].values[i])));
      }
      body.appendChild(row);
    }
    table.appendChild(body);
    scroll.appendChild(table);
    wrap.appendChild(scroll);
    return wrap;
  }

  function hasData(series) {
    for (var i = 0; i < series.length; i += 1) {
      for (var j = 0; j < series[i].values.length; j += 1) {
        if (series[i].values[j] > 0) return true;
      }
    }
    return false;
  }

  /** spec: { type: 'line'|'stack', labels: [], series: [{name,color,values}], empty } */
  function chart(host, spec) {
    clear(host);
    if (!spec.labels.length || !hasData(spec.series)) {
      host.appendChild(el('div', 'empty', spec.empty || 'No data in this range.'));
      return;
    }
    var plot = el('div', 'plot');
    host.appendChild(plot);
    var tip = makeTip(plot);
    if (spec.series.length > 1) host.appendChild(legendFor(spec.series, spec.type === 'line' ? 'line' : 'box'));
    host.appendChild(dataTable(spec.labels, spec.series, full));

    function draw() {
      clear(plot);
      plot.appendChild(tip.node);
      var width = Math.max(280, plot.clientWidth || host.clientWidth || 320);
      var height = spec.height || 212;
      var padL = 46, padR = 16, padT = 12, padB = 26;
      var plotW = width - padL - padR;
      var plotH = height - padT - padB;
      var n = spec.labels.length;
      var surface = cssVar('--surface');

      var maxima = 0;
      var i, j;
      if (spec.type === 'stack') {
        for (i = 0; i < n; i += 1) {
          var col = 0;
          for (j = 0; j < spec.series.length; j += 1) col += spec.series[j].values[i] || 0;
          if (col > maxima) maxima = col;
        }
      } else {
        for (j = 0; j < spec.series.length; j += 1) {
          for (i = 0; i < n; i += 1) {
            if ((spec.series[j].values[i] || 0) > maxima) maxima = spec.series[j].values[i] || 0;
          }
        }
      }
      var scale = niceTicks(maxima);
      var root = svg('svg', { viewBox: '0 0 ' + width + ' ' + height, width: width, height: height,
        role: 'img', 'aria-label': spec.title || 'chart' });

      function yOf(value) { return padT + plotH - (value / scale.top) * plotH; }

      for (i = 0; i < scale.ticks.length; i += 1) {
        var ty = yOf(scale.ticks[i]);
        root.appendChild(svg('line', { x1: padL, x2: width - padR, y1: ty, y2: ty,
          stroke: i === 0 ? cssVar('--axis') : cssVar('--grid'), 'stroke-width': 1 }));
        var label = svg('text', { x: padL - 8, y: ty + 4, 'text-anchor': 'end',
          fill: cssVar('--muted'), 'font-size': 11, 'font-variant-numeric': 'tabular-nums' });
        label.textContent = compact(scale.ticks[i]);
        root.appendChild(label);
      }

      var band = plotW / n;
      var everyX = Math.max(1, Math.ceil(n / (width < 480 ? 5 : 10)));
      // Ticks on a fixed stride, plus the last day — but the last one wins only
      // when it clears its neighbour, otherwise the two labels print on top of
      // each other (a 5-character day label needs ~40px of room).
      var ticksX = [];
      for (i = 0; i < n; i += 1) if (i % everyX === 0) ticksX.push(i);
      if (n > 0 && ticksX[ticksX.length - 1] !== n - 1) {
        if (band * (n - 1 - ticksX[ticksX.length - 1]) < 40) ticksX.pop();
        ticksX.push(n - 1);
      }
      for (var ti = 0; ti < ticksX.length; ti += 1) {
        i = ticksX[ti];
        var tx = padL + band * (i + 0.5);
        var xlab = svg('text', { x: tx, y: height - 8, 'text-anchor': 'middle',
          fill: cssVar('--muted'), 'font-size': 11 });
        xlab.textContent = shortDay(spec.labels[i]);
        root.appendChild(xlab);
      }

      if (spec.type === 'stack') {
        var barW = Math.min(24, band * 0.62);
        for (i = 0; i < n; i += 1) {
          var cx = padL + band * (i + 0.5) - barW / 2;
          var stackAt = [];
          for (j = 0; j < spec.series.length; j += 1) {
            if ((spec.series[j].values[i] || 0) > 0) stackAt.push(j);
          }
          var acc = 0;
          for (var k = 0; k < stackAt.length; k += 1) {
            var value = spec.series[stackAt[k]].values[i];
            var y0 = yOf(acc + value);
            var y1 = yOf(acc);
            // The 2px surface gap sits under every segment except the lowest,
            // which has to stay welded to the baseline.
            var h = Math.max(1, y1 - y0 - (k === 0 ? 0 : 2));
            root.appendChild(svg('path', {
              d: barPath(cx, y0, barW, h, 4, k === stackAt.length - 1 ? 'top' : 'none'),
              fill: spec.series[stackAt[k]].color
            }));
            acc += value;
          }
        }
      } else {
        for (j = 0; j < spec.series.length; j += 1) {
          var points = [];
          for (i = 0; i < n; i += 1) {
            points.push((padL + band * (i + 0.5)) + ',' + yOf(spec.series[j].values[i] || 0));
          }
          root.appendChild(svg('polyline', { points: points.join(' '), fill: 'none',
            stroke: spec.series[j].color, 'stroke-width': 2, 'stroke-linejoin': 'round',
            'stroke-linecap': 'round' }));
          var lastX = padL + band * (n - 0.5);
          var lastY = yOf(spec.series[j].values[n - 1] || 0);
          root.appendChild(svg('circle', { cx: lastX, cy: lastY, r: 4,
            fill: spec.series[j].color, stroke: surface, 'stroke-width': 2 }));
        }
        // Direct end labels, but only where they do not collide; the legend
        // and the tooltip carry the rest.
        var placed = [];
        for (j = 0; j < spec.series.length; j += 1) {
          var vy = yOf(spec.series[j].values[n - 1] || 0);
          var clash = false;
          for (i = 0; i < placed.length; i += 1) { if (Math.abs(placed[i] - vy) < 13) clash = true; }
          if (clash) continue;
          placed.push(vy);
          var endLabel = svg('text', { x: padL + band * (n - 0.5) - 8, y: vy - 9,
            'text-anchor': 'end', fill: cssVar('--ink-2'), 'font-size': 11,
            'font-variant-numeric': 'tabular-nums' });
          endLabel.textContent = compact(spec.series[j].values[n - 1] || 0);
          root.appendChild(endLabel);
        }
      }

      // One hit band per x, full height: the reader aims at a day, never at a mark.
      var hover = svg('g', {});
      var cross = svg('line', { x1: 0, x2: 0, y1: padT, y2: padT + plotH,
        stroke: cssVar('--axis'), 'stroke-width': 1, opacity: 0 });
      root.appendChild(cross);
      for (i = 0; i < n; i += 1) {
        var hit = svg('rect', { x: padL + band * i, y: padT, width: band, height: plotH,
          fill: 'transparent' });
        (function (index, rect) {
          function enter() {
            var rows = [];
            for (var k = 0; k < spec.series.length; k += 1) {
              rows.push({ color: spec.series[k].color, name: spec.series[k].name,
                value: full(spec.series[k].values[index] || 0) });
            }
            var px = padL + band * (index + 0.5);
            cross.setAttribute('x1', px);
            cross.setAttribute('x2', px);
            cross.setAttribute('opacity', spec.type === 'line' ? '1' : '0');
            tip.show(px, padT + 6, spec.labels[index], rows);
          }
          rect.addEventListener('pointerenter', enter);
          rect.addEventListener('pointermove', enter);
          rect.addEventListener('pointerleave', function () {
            cross.setAttribute('opacity', '0');
            tip.hide();
          });
        }(i, hit));
        hover.appendChild(hit);
      }
      root.appendChild(hover);
      plot.appendChild(root);
    }

    draw();
    watchPlot(host, plot, draw);
  }

  /** Horizontal bars for nominal categories: one hue for every bar. */
  function barsChart(host, rows, opts) {
    clear(host);
    if (!rows.length) {
      host.appendChild(el('div', 'empty', (opts && opts.empty) || 'No data for this day.'));
      return;
    }
    var plot = el('div', 'plot');
    host.appendChild(plot);
    // Same contract as chart(): an accessible name on the graphic, and the
    // numbers available as text for anyone the graphic does not serve.
    var valueName = (opts && opts.valueName) || 'Lines';
    host.appendChild(dataTable(
      rows.map(function (row) { return row.label; }),
      [{ name: valueName, values: rows.map(function (row) { return row.value; }) }],
      full,
      (opts && opts.category) || 'Level',
    ));

    function draw() {
      clear(plot);
      var width = Math.max(260, plot.clientWidth || 320);
      var rowH = 26;
      var height = rows.length * rowH + 8;
      var gutter = Math.min(140, Math.max(60, width * 0.28));
      var padR = 52;
      var plotW = width - gutter - padR;
      var max = 0;
      for (var i = 0; i < rows.length; i += 1) { if (rows[i].value > max) max = rows[i].value; }
      if (max <= 0) max = 1;
      var root = svg('svg', { viewBox: '0 0 ' + width + ' ' + height, width: width, height: height,
        role: 'img', 'aria-label': (opts && opts.title) || (valueName + ' by ' + ((opts && opts.category) || 'level')) });
      for (i = 0; i < rows.length; i += 1) {
        var y = i * rowH + 4;
        var barH = Math.min(24, rowH - 8);
        var w = Math.max(1, (rows[i].value / max) * plotW);
        var label = svg('text', { x: gutter - 10, y: y + barH / 2 + 4, 'text-anchor': 'end',
          fill: cssVar('--ink-2'), 'font-size': 12 });
        label.textContent = rows[i].label;
        root.appendChild(label);
        root.appendChild(svg('path', { d: barPath(gutter, y + (rowH - 8 - barH) / 2, w, barH, 4, 'right'),
          fill: rows[i].color || cssVar('--s1') }));
        var value = svg('text', { x: gutter + w + 8, y: y + barH / 2 + 4, fill: cssVar('--ink-2'),
          'font-size': 12, 'font-variant-numeric': 'tabular-nums' });
        value.textContent = full(rows[i].value);
        root.appendChild(value);
      }
      plot.appendChild(root);
    }
    draw();
    watchPlot(host, plot, draw);
  }

  /**
   * Drawn at the width it actually occupies, never stretched: a sparkline
   * scaled by CSS turns its end marker into an oval and its stroke into a
   * different weight than every other line on the page.
   */
  function sparkline(values, color) {
    var wrap = el('div', 'spark-plot');

    function draw() {
      clear(wrap);
      var height = 26, pad = 3;
      var width = Math.max(80, Math.round(wrap.clientWidth) || 120);
      var root = svg('svg', { viewBox: '0 0 ' + width + ' ' + height,
        width: width, height: height, 'aria-hidden': 'true' });
      wrap.appendChild(root);
      var max = 0;
      var i;
      for (i = 0; i < values.length; i += 1) { if (values[i] > max) max = values[i]; }
      if (max <= 0) max = 1;
      if (values.length < 2) return;
      var step = (width - pad * 2) / (values.length - 1);
      var points = [];
      for (i = 0; i < values.length; i += 1) {
        points.push((pad + i * step) + ',' + (height - pad - (values[i] / max) * (height - pad * 2)));
      }
      root.appendChild(svg('polyline', { points: points.join(' '), fill: 'none',
        stroke: cssVar('--muted'), 'stroke-width': 1.5, 'stroke-linejoin': 'round',
        'stroke-linecap': 'round' }));
      var lastY = height - pad - (values[values.length - 1] / max) * (height - pad * 2);
      root.appendChild(svg('circle', { cx: width - pad, cy: lastY, r: 3,
        fill: color || cssVar('--s1'), stroke: cssVar('--surface'), 'stroke-width': 2 }));
    }

    draw();
    watchPlot(wrap, wrap, draw);
    return wrap;
  }

  function card(title, subtitle, wide) {
    var box = el('div', wide ? 'card wide' : 'card');
    var head = el('header');
    head.appendChild(el('h2', null, title));
    if (subtitle) head.appendChild(el('p', 'sub', subtitle));
    box.appendChild(head);
    var body = el('div');
    box.appendChild(body);
    return { card: box, body: body, head: head };
  }

  function kpi(label, value, delta, spark, hero) {
    var box = el('div', hero ? 'card kpi hero' : 'card kpi');
    box.appendChild(el('div', 'label', label));
    box.appendChild(el('div', 'value', value));
    var line = el('div', 'delta');
    if (delta) {
      var arrow = el('span', delta.good ? 'up' : delta.bad ? 'down' : null, delta.text);
      line.appendChild(arrow);
    } else {
      line.appendChild(el('span', null, ''));
    }
    box.appendChild(line);
    if (spark && spark.length > 1) {
      var wrap = el('div', 'spark');
      wrap.appendChild(sparkline(spark));
      box.appendChild(wrap);
    }
    return box;
  }

  /**
   * A partial left-hand day is one still being written. Comparing three
   * hours of today against all of yesterday reads as a collapse every morning
   * and a recovery every evening, so the comparison says what it is and the
   * downward direction carries no colour — only a rise is real news.
   */
  function deltaOf(today, yesterday, upIsGood, partial) {
    if (yesterday === undefined || yesterday === null) return null;
    var against = partial ? ' vs all of yesterday' : ' vs yesterday';
    var diff = today - yesterday;
    if (diff === 0) return { text: 'Level with' + (partial ? ' all of' : '') + ' yesterday' };
    var text = (diff > 0 ? '+' : '−') + full(Math.abs(diff)) + against;
    var rising = diff > 0;
    if (partial) return { text: text, good: rising && upIsGood, bad: rising && !upIsGood };
    return { text: text, good: upIsGood === rising, bad: upIsGood !== rising };
  }

  /* ------------------------------------------------------------ overview */

  function topKeys(days, pick, limit) {
    var totals = {};
    for (var i = 0; i < days.length; i += 1) {
      var map = pick(days[i]);
      for (var key in map) {
        if (Object.prototype.hasOwnProperty.call(map, key)) {
          totals[key] = (totals[key] || 0) + (typeof map[key] === 'number' ? map[key] : map[key].total || 0);
        }
      }
    }
    return Object.keys(totals).sort(function (a, b) { return totals[b] - totals[a]; }).slice(0, limit);
  }

  function seriesFromKeys(days, keys, pick, read) {
    var series = [];
    for (var k = 0; k < keys.length; k += 1) {
      var values = [];
      for (var i = 0; i < days.length; i += 1) {
        var map = pick(days[i]) || {};
        values.push(read(map[keys[k]]));
      }
      series.push({ name: keys[k], color: cssVar(SERIES[k] || OTHER), values: values });
    }
    return series;
  }

  function otherSeries(days, keys, pick, read) {
    var values = [];
    var any = false;
    for (var i = 0; i < days.length; i += 1) {
      var map = pick(days[i]) || {};
      var rest = 0;
      for (var key in map) {
        if (!Object.prototype.hasOwnProperty.call(map, key)) continue;
        if (keys.indexOf(key) >= 0) continue;
        rest += read(map[key]);
      }
      if (rest > 0) any = true;
      values.push(rest);
    }
    return any ? { name: 'Other', color: cssVar(OTHER), values: values } : null;
  }

  function renderOverview(host, data) {
    clear(host);
    var days = data.days;
    var labels = days.map(function (d) { return d.day; });
    var last = days[days.length - 1] || null;
    var prev = days[days.length - 2] || null;

    var kpis = el('div', 'kpis');
    var llmDays = (data.llm && data.llm.days) || [];
    var lastLlm = llmDays[llmDays.length - 1] || { total: 0, requests: 0 };
    var prevLlm = llmDays[llmDays.length - 2] || null;
    // The last day of the range is only "today" when the range runs to today,
    // and only then are these numbers a day in progress.
    var partial = !!(last && data.today && last.day === data.today);
    var when = partial ? ' today so far' : (last ? ' on ' + last.day : '');
    // No LLM record anywhere in the range means these blobs do not exist for
    // it — a different fact from "the proxy served nothing", and not a zero.
    var llmKnown = !!(data.llm && data.llm.present);

    kpis.appendChild(kpi('Active installs' + when, last ? full(last.installs) : '—',
      prev && last ? deltaOf(last.installs, prev.installs, true, partial) : null,
      days.map(function (d) { return d.installs; }), true));
    kpis.appendChild(kpi('Sessions' + when, last ? full(last.sessions) : '—',
      prev && last ? deltaOf(last.sessions, prev.sessions, true, partial) : null,
      days.map(function (d) { return d.sessions; })));
    kpis.appendChild(kpi('Errors' + when, last ? full(last.errors) : '—',
      prev && last ? deltaOf(last.errors, prev.errors, false, partial) : null,
      days.map(function (d) { return d.errors; })));
    kpis.appendChild(kpi('LLM tokens' + when, llmKnown ? compact(lastLlm.total) : '—',
      llmKnown && prevLlm ? deltaOf(lastLlm.total, prevLlm.total, true, partial) : null,
      llmDays.map(function (d) { return d.total; })));
    host.appendChild(kpis);
    if (partial) {
      host.appendChild(el('p', 'note partial-note',
        last.day + ' is still being written. Its numbers are a day so far, not a whole day.'));
    }

    var grid = el('div', 'grid');
    host.appendChild(grid);

    var activity = card('Active installs and sessions', 'Distinct installs and app sessions seen per day.', true);
    grid.appendChild(activity.card);
    chart(activity.body, {
      type: 'line', labels: labels, title: 'Active installs and sessions',
      series: [
        { name: 'Installs', color: cssVar('--s1'), values: days.map(function (d) { return d.installs; }) },
        { name: 'Sessions', color: cssVar('--s2'), values: days.map(function (d) { return d.sessions; }) }
      ]
    });

    var levelKeys = { info: [], warn: [], other: [], error: [] };
    for (var i = 0; i < days.length; i += 1) {
      var acc = { info: 0, warn: 0, other: 0, error: 0 };
      var byLevel = days[i].byLevel || {};
      for (var level in byLevel) {
        if (Object.prototype.hasOwnProperty.call(byLevel, level)) acc[levelSlot(level)] += byLevel[level];
      }
      levelKeys.info.push(acc.info);
      levelKeys.warn.push(acc.warn);
      levelKeys.other.push(acc.other);
      levelKeys.error.push(acc.error);
    }
    var volume = card('Log lines by level', 'Everything shipped by installs with telemetry on.', true);
    grid.appendChild(volume.card);
    chart(volume.body, {
      type: 'stack', labels: labels, title: 'Log lines by level',
      series: LEVEL_ORDER.map(function (slot) {
        return { name: slot === 'other' ? 'Other levels' : slot, color: cssVar(LEVEL_VAR[slot]),
          values: levelKeys[slot] };
      })
    });

    var errorsCard = card('Errors per day', 'error, uncaught and unhandledRejection lines.');
    grid.appendChild(errorsCard.card);
    chart(errorsCard.body, {
      type: 'line', labels: labels, title: 'Errors per day', height: 190,
      series: [{ name: 'Errors', color: cssVar('--lvl-error'),
        values: days.map(function (d) { return d.errors; }) }],
      empty: 'No errors in this range.'
    });

    var versionKeys = topKeys(days, function (d) { return d.appVersions; }, 5);
    versionKeys.sort(function (a, b) { return versionRank(b) - versionRank(a); });
    var latest = versionKeys.length ? versionKeys[0] : null;
    var onLatest = last && latest ? (last.appVersions[latest] || 0) : 0;
    var adoption = card('App version adoption',
      latest ? ('Installs per version, per day. Today ' + onLatest + ' of ' + (last ? last.installs : 0) +
        ' installs are on ' + latest + '.') : 'Installs per version, per day.');
    grid.appendChild(adoption.card);
    var versionSeries = seriesFromKeys(days, versionKeys, function (d) { return d.appVersions; },
      function (v) { return v || 0; });
    var versionOther = otherSeries(days, versionKeys, function (d) { return d.appVersions; },
      function (v) { return v || 0; });
    if (versionOther) versionSeries.push(versionOther);
    chart(adoption.body, { type: 'stack', labels: labels, title: 'App version adoption',
      height: 190, series: versionSeries });

    var modelKeys = topKeys(llmDays, function (d) { return d.byModel; }, 5);
    var llmTotals = (data.llm && data.llm.totals) || { requests: 0, total: 0 };
    var llmCard = card('Managed LLM tokens by model',
      full(llmTotals.requests) + ' requests and ' + full(llmTotals.total) +
      ' tokens in this range.', true);
    grid.appendChild(llmCard.card);
    var modelSeries = seriesFromKeys(llmDays, modelKeys, function (d) { return d.byModel; },
      function (v) { return (v && v.total) || 0; });
    var modelOther = otherSeries(llmDays, modelKeys, function (d) { return d.byModel; },
      function (v) { return (v && v.total) || 0; });
    if (modelOther) modelSeries.push(modelOther);
    chart(llmCard.body, {
      type: 'stack', labels: llmDays.map(function (d) { return d.day; }),
      title: 'LLM tokens by model', series: modelSeries,
      empty: 'No managed-LLM usage recorded in this range.'
    });

    var opCard = card('Operators active', 'Named operators seen in this range.');
    grid.appendChild(opCard.card);
    var operators = {};
    for (i = 0; i < days.length; i += 1) {
      for (var o = 0; o < days[i].operators.length; o += 1) {
        var stat = days[i].operators[o];
        var entry = operators[stat.operator] || { installs: 0, lines: 0, days: 0 };
        entry.installs = Math.max(entry.installs, stat.installs);
        entry.lines += stat.lines;
        entry.days += 1;
        operators[stat.operator] = entry;
      }
    }
    var names = Object.keys(operators).sort(function (a, b) { return operators[b].lines - operators[a].lines; });
    if (!names.length) {
      opCard.body.appendChild(el('div', 'empty', 'No operator names reported in this range.'));
    } else {
      var table = el('table');
      var thead = el('thead');
      var hrow = el('tr');
      ['Operator', 'Installs', 'Days seen', 'Lines'].forEach(function (title, index) {
        hrow.appendChild(el('th', index ? 'num' : null, title));
      });
      thead.appendChild(hrow);
      table.appendChild(thead);
      var tbody = el('tbody');
      names.forEach(function (name) {
        var row = el('tr');
        row.appendChild(el('td', null, name));
        row.appendChild(el('td', 'num', full(operators[name].installs)));
        row.appendChild(el('td', 'num', full(operators[name].days)));
        row.appendChild(el('td', 'num', full(operators[name].lines)));
        tbody.appendChild(row);
      });
      table.appendChild(tbody);
      var scroll = el('div', 'scrollx');
      scroll.appendChild(table);
      opCard.body.appendChild(scroll);
    }

    var truncated = days.filter(function (d) { return d.truncated; }).length;
    var corrupt = data.totals.corrupt;
    var notes = [];
    notes.push(full(data.totals.batches) + ' batches · ' + full(data.totals.installs) + ' installs · ' +
      full(data.totals.lines) + ' lines');
    if (data.totals.dropped) notes.push(full(data.totals.dropped) + ' lines dropped by shippers');
    if (corrupt) notes.push(corrupt + ' unreadable blobs');
    if (truncated) notes.push(truncated + ' day(s) hit the 1000-blob listing cap');
    $('ov-note').textContent = notes.join(' · ');
  }

  /* --------------------------------------------------------- engineering */

  function renderEngineering(host, data) {
    clear(host);
    var day = data.days[0] || null;
    if (!day) {
      host.appendChild(el('div', 'empty', 'No data for this day.'));
      return;
    }

    var strip = el('div', 'kpis');
    strip.appendChild(kpi('Installs', full(day.installs), null, null, false));
    strip.appendChild(kpi('Sessions', full(day.sessions), null, null, false));
    strip.appendChild(kpi('Lines', full(day.lines), null, null, false));
    strip.appendChild(kpi('Errors', full(day.errors), null, null, false));
    host.appendChild(strip);

    var grid = el('div', 'grid');
    host.appendChild(grid);

    var levels = Object.keys(day.byLevel || {}).sort(function (a, b) {
      return day.byLevel[b] - day.byLevel[a];
    });
    var levelCard = card('Lines by level', 'All installs, ' + day.day + '.');
    grid.appendChild(levelCard.card);
    barsChart(levelCard.body, levels.map(function (level) {
      return { label: level, value: day.byLevel[level], color: cssVar(LEVEL_VAR[levelSlot(level)]) };
    }), { empty: 'No lines shipped on this day.', title: 'Lines by level on ' + day.day,
      category: 'Level', valueName: 'Lines' });

    var installsCard = card('Installs', 'Click a row to read that install\\u2019s merged session log.', true);
    grid.appendChild(installsCard.card);
    if (!day.installDetail.length) {
      installsCard.body.appendChild(el('div', 'empty', 'No installs reported on this day.'));
    } else {
      var table = el('table');
      var thead = el('thead');
      var hrow = el('tr');
      [['Install', 0], ['Operator', 0], ['Version', 0], ['OS', 0], ['Sessions', 1], ['Batches', 1],
        ['Lines', 1], ['Errors', 1], ['Dropped', 1], ['Last seen', 0]].forEach(function (col) {
        hrow.appendChild(el('th', col[1] ? 'num' : null, col[0]));
      });
      thead.appendChild(hrow);
      table.appendChild(thead);
      var tbody = el('tbody');
      day.installDetail.forEach(function (install) {
        var row = el('tr', 'click');
        row.tabIndex = 0;
        var idCell = el('td', 'mono', install.installId.slice(0, 12));
        idCell.title = install.installId;
        row.appendChild(idCell);
        row.appendChild(el('td', null, install.operator || '—'));
        row.appendChild(el('td', null, install.appVersions.join(', ') || '—'));
        row.appendChild(el('td', null, install.osVersions.join(', ') || '—'));
        row.appendChild(el('td', 'num', full(install.sessions)));
        row.appendChild(el('td', 'num', full(install.batches)));
        row.appendChild(el('td', 'num', full(install.lines)));
        row.appendChild(el('td', 'num', full(install.errors)));
        row.appendChild(el('td', 'num', full(install.dropped)));
        row.appendChild(el('td', null, clockOf(install.lastSeen) || '—'));
        function open() {
          var rows = tbody.querySelectorAll('tr');
          for (var i = 0; i < rows.length; i += 1) rows[i].classList.remove('on');
          row.classList.add('on');
          loadDrilldown(install.installId);
        }
        row.addEventListener('click', open);
        row.addEventListener('keydown', function (event) {
          if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open(); }
        });
        tbody.appendChild(row);
      });
      table.appendChild(tbody);
      var scroll = el('div', 'scrollx');
      scroll.appendChild(table);
      installsCard.body.appendChild(scroll);
      if (day.installDetailTruncated) {
        installsCard.body.appendChild(el('p', 'note', 'Only the busiest 500 installs are listed.'));
      }
    }

    var drillCard = card('Session log', 'Pick an install above.', true);
    drillCard.card.id = 'drill';
    grid.appendChild(drillCard.card);
    if (state.drill && state.drill.installId) renderDrilldown(drillCard, state.drill);

    var notes = [full(day.batches) + ' batches'];
    if (day.dropped) notes.push(full(day.dropped) + ' lines dropped by shippers');
    if (day.corrupt) notes.push(day.corrupt + ' unreadable blobs');
    if (day.truncated) notes.push('listing hit the 1000-blob cap — this day is under-reported');
    $('eng-note').textContent = notes.join(' · ');
  }

  function loadDrilldown(installId) {
    state.drillShown = 800;
    var box = $('drill');
    if (box) box.classList.add('busy');
    cached({ day: state.engDay, install: installId }).then(function (data) {
      state.drill = data;
      var current = $('drill');
      if (!current) return;
      current.classList.remove('busy');
      var rebuilt = card('Session log', installId, true);
      rebuilt.card.id = 'drill';
      renderDrilldown(rebuilt, data);
      current.parentNode.replaceChild(rebuilt.card, current);
      rebuilt.card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }).catch(onError);
  }

  function renderDrilldown(target, data) {
    clear(target.head);
    target.head.appendChild(el('h2', null, 'Session log'));
    var subtitle = data.installId + ' · ' + data.sessions.length + ' session(s) · ' +
      full(data.lineTotal) + ' lines';
    target.head.appendChild(el('p', 'sub', subtitle));
    clear(target.body);

    if (!data.found) {
      target.body.appendChild(el('div', 'empty', 'No batches for this install on this day.'));
      return;
    }

    var sessionTable = el('table');
    var thead = el('thead');
    var hrow = el('tr');
    [['Session', 0], ['Version', 0], ['OS', 0], ['Batches', 1], ['Lines', 1], ['Dropped', 1],
      ['First', 0], ['Last', 0]].forEach(function (col) {
      hrow.appendChild(el('th', col[1] ? 'num' : null, col[0]));
    });
    thead.appendChild(hrow);
    sessionTable.appendChild(thead);
    var tbody = el('tbody');
    data.sessions.forEach(function (session) {
      var row = el('tr');
      var idCell = el('td', 'mono', session.sessionId.slice(0, 8));
      idCell.title = session.sessionId;
      row.appendChild(idCell);
      row.appendChild(el('td', null, session.appVersion));
      row.appendChild(el('td', null, session.osVersion));
      row.appendChild(el('td', 'num', full(session.batches)));
      row.appendChild(el('td', 'num', full(session.lines)));
      row.appendChild(el('td', 'num', full(session.dropped)));
      row.appendChild(el('td', null, clockOf(session.firstSeen)));
      row.appendChild(el('td', null, clockOf(session.lastSeen)));
      tbody.appendChild(row);
    });
    sessionTable.appendChild(tbody);
    var wrap = el('div', 'scrollx');
    wrap.appendChild(sessionTable);
    target.body.appendChild(wrap);

    var tools = el('div', 'logtools');
    var levelSelect = el('select', 'field');
    var levels = ['all'];
    var seen = {};
    data.lines.forEach(function (line) {
      if (!seen[line.level]) { seen[line.level] = 1; levels.push(line.level); }
    });
    levels.forEach(function (level) {
      var option = el('option', null, level === 'all' ? 'All levels' : level);
      option.value = level;
      levelSelect.appendChild(option);
    });
    var search = el('input', 'field');
    search.type = 'search';
    search.placeholder = 'Search the loaded lines';
    var count = el('span', 'note');
    tools.appendChild(levelSelect);
    tools.appendChild(search);
    tools.appendChild(count);
    target.body.appendChild(tools);

    if (data.truncated) {
      target.body.appendChild(el('p', 'note',
        'Showing the most recent ' + full(data.lines.length) + ' of ' + full(data.lineTotal) + ' lines.'));
    }

    var list = el('div', 'loglist');
    target.body.appendChild(list);

    function paint() {
      clear(list);
      var needle = search.value.trim().toLowerCase();
      var level = levelSelect.value;
      var matched = data.lines.filter(function (line) {
        if (level !== 'all' && line.level !== level) return false;
        if (needle && line.line.toLowerCase().indexOf(needle) < 0) return false;
        return true;
      });
      var shown = matched.slice(0, state.drillShown);
      shown.forEach(function (line) {
        var row = el('div', 'logrow ' + line.level);
        row.appendChild(el('span', 't', clockOf(line.t)));
        row.appendChild(el('span', 'lvl', line.level));
        row.appendChild(el('span', 'msg', line.line));
        list.appendChild(row);
      });
      count.textContent = full(matched.length) + ' matching · showing ' + full(shown.length);
      if (matched.length > shown.length) {
        var more = el('button', 'ghost', 'Show more');
        more.type = 'button';
        more.addEventListener('click', function () { state.drillShown += 800; paint(); });
        list.appendChild(more);
      }
      if (!matched.length) list.appendChild(el('div', 'empty', 'No lines match this filter.'));
    }

    levelSelect.addEventListener('change', function () { state.drillShown = 800; paint(); });
    var typingTimer = null;
    search.addEventListener('input', function () {
      if (typingTimer) clearTimeout(typingTimer);
      typingTimer = setTimeout(function () { state.drillShown = 800; paint(); }, 140);
    });
    paint();
  }

  /* -------------------------------------------------------------- issues */

  function renderIssues(host, data, span) {
    clear(host);
    var days = data.days.map(function (d) { return d.day; });
    var half = Math.floor(days.length / 2);
    var previousDays = days.slice(0, half);
    var currentDays = days.slice(half);

    var rows = [];
    data.signatures.forEach(function (signature) {
      if (state.isLevel === 'error' && !ERROR_LEVELS[signature.level]) return;
      var current = 0, previous = 0;
      currentDays.forEach(function (day) { current += signature.days[day] || 0; });
      previousDays.forEach(function (day) { previous += signature.days[day] || 0; });
      if (current === 0) return;
      rows.push({ signature: signature, current: current, previous: previous });
    });
    rows.sort(function (a, b) { return b.current - a.current; });

    $('is-note').textContent = rows.length
      ? (full(rows.length) + ' signature(s) in the last ' + span + ' days, compared with the ' +
         span + ' days before')
      : '';

    if (!rows.length) {
      host.appendChild(el('div', 'empty',
        state.isLevel === 'error'
          ? 'No error signatures in the last ' + span + ' days.'
          : 'No error or warning signatures in the last ' + span + ' days.'));
      return;
    }

    var box = el('div', 'card wide');
    host.appendChild(box);

    rows.forEach(function (row) {
      var signature = row.signature;
      var issue = el('div', 'issue');
      var top = el('div', 'top');
      top.appendChild(el('span', 'count', full(row.current)));
      var chip = el('span', 'chip ' + signature.level, signature.level);
      top.appendChild(chip);
      top.appendChild(el('span', 'sig', signature.signature));

      var trend = el('span', 'note');
      if (row.previous === 0) {
        trend.textContent = 'new';
        trend.className = 'note bad';
      } else {
        var diff = row.current - row.previous;
        var pct = Math.round((diff / row.previous) * 100);
        trend.textContent = (diff > 0 ? '+' : diff < 0 ? '−' : '±') + Math.abs(pct) + '% vs previous';
        trend.className = diff > 0 ? 'note bad' : 'note';
      }
      top.appendChild(trend);

      var spark = el('div');
      spark.style.width = '110px';
      spark.style.flex = '0 0 auto';
      spark.appendChild(sparkline(days.map(function (day) { return signature.days[day] || 0; }),
        cssVar('--lvl-error')));
      top.appendChild(spark);
      issue.appendChild(top);

      var meta = el('div', 'meta');
      meta.appendChild(el('span', null, signature.installCount + ' install(s)'));
      if (signature.operators.length) {
        meta.appendChild(el('span', null, 'operators: ' + signature.operators.join(', ')));
      }
      meta.appendChild(el('span', null, 'versions: ' + signature.appVersions.join(', ')));
      meta.appendChild(el('span', null, 'first ' + (signature.firstSeen || '—').slice(0, 19).replace('T', ' ')));
      meta.appendChild(el('span', null, 'last ' + (signature.lastSeen || '—').slice(0, 19).replace('T', ' ')));
      if (row.previous) meta.appendChild(el('span', null, 'previous period: ' + full(row.previous)));
      issue.appendChild(meta);

      var details = el('details');
      details.appendChild(el('summary', null, 'Sample line'));
      var pre = el('pre');
      pre.textContent = signature.sample;
      details.appendChild(pre);
      issue.appendChild(details);

      box.appendChild(issue);
    });

    if (data.signatureTotal > data.signatures.length) {
      host.appendChild(el('p', 'note',
        'Showing the top ' + data.signatures.length + ' of ' + full(data.signatureTotal) + ' signatures.'));
    }
  }

  /* --------------------------------------------------------------- shell */

  function onError(error) {
    if (error instanceof AuthError) { signOut('401: the token was rejected. Paste it again.'); return; }
    var host = $(state.tab === 'overview' ? 'ov-body' : state.tab === 'issues' ? 'is-body' : 'eng-body');
    clear(host);
    host.appendChild(el('div', 'empty', 'Could not load. ' + (error.message || error)));
  }

  function busy(on) {
    var host = $(state.tab === 'overview' ? 'ov-body' : state.tab === 'issues' ? 'is-body' : 'eng-body');
    host.classList.toggle('busy', on);
  }

  function render() {
    if (!state.token) { openGate(''); return; }
    busy(true);
    var today = utcToday();
    if (state.tab === 'overview') {
      var span = state.ovRange;
      cached({ from: addDays(today, -(span - 1)), to: today }).then(function (data) {
        busy(false);
        stamp(data.generatedAt);
        renderOverview($('ov-body'), data);
      }).catch(function (error) { busy(false); onError(error); });
    } else if (state.tab === 'engineering') {
      cached({ day: state.engDay }).then(function (data) {
        busy(false);
        stamp(data.generatedAt);
        renderEngineering($('eng-body'), data);
      }).catch(function (error) { busy(false); onError(error); });
    } else {
      var half = state.isRange;
      cached({ from: addDays(today, -(half * 2 - 1)), to: today }).then(function (data) {
        busy(false);
        stamp(data.generatedAt);
        renderIssues($('is-body'), data, half);
      }).catch(function (error) { busy(false); onError(error); });
    }
  }

  function stamp(iso) {
    $('stamp').textContent = iso ? 'as of ' + iso.slice(11, 19) + ' UTC' : '';
  }

  function selectTab(name) {
    state.tab = name;
    ['overview', 'engineering', 'issues'].forEach(function (tab) {
      $('tab-' + tab).setAttribute('aria-selected', String(tab === name));
      $('panel-' + tab).hidden = tab !== name;
    });
    render();
  }

  ['overview', 'engineering', 'issues'].forEach(function (tab) {
    $('tab-' + tab).addEventListener('click', function () { selectTab(tab); });
  });

  $('ov-range').addEventListener('change', function () {
    state.ovRange = Number($('ov-range').value);
    render();
  });
  $('is-range').addEventListener('change', function () {
    state.isRange = Number($('is-range').value);
    render();
  });
  $('is-level').addEventListener('change', function () {
    state.isLevel = $('is-level').value;
    render();
  });
  $('eng-day').addEventListener('change', function () {
    if (!$('eng-day').value) return;
    state.engDay = $('eng-day').value;
    state.drill = null;
    render();
  });
  $('reload').addEventListener('click', function () {
    cache.clear();
    state.drill = null;
    render();
  });

  state.engDay = utcToday();
  $('eng-day').value = state.engDay;
  $('eng-day').max = state.engDay;

  try { state.token = sessionStorage.getItem(KEY); } catch (e) { state.token = null; }
  if (state.token) render(); else openGate('');
}());
</script>
</body>
</html>
`;

/**
 * Static document. It holds no secrets: the token is typed by the reader,
 * lives in sessionStorage, and only ever travels in a request header.
 */
export function dashboardPage(): Response {
  return new Response(PAGE, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-robots-tag": "noindex, nofollow",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      // The page draws its own SVG and loads nothing: no img-src, no font-src,
      // no allowance for anything the page does not do.
      "content-security-policy":
        "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'",
    },
  });
}
