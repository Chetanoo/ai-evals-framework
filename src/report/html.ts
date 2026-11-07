import type { LoadedRun } from '../run.js';
import type { RunSummary } from '../metrics.js';
import { summaryRows } from './text.js';

// A single self-contained HTML file: no build step, no external requests. The data is embedded as
// JSON and rendered in the browser (every string goes in with textContent, never innerHTML).

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
// JSON inside <script>: "</script>" in an answer must not end the block.
const embed = (data: unknown) => JSON.stringify(data).replace(/</g, '\\u003c');

export function htmlReport(run: LoadedRun, summary: RunSummary): string {
  const m = run.manifest;
  const frontier = new Set(summary.frontier);
  const data = {
    meta: {
      experiment: m.experiment,
      description: m.description ?? '',
      dataset: m.dataset.name,
      scored: summary.items.scored,
      total: summary.items.total,
      repeats: m.repeats,
      status: m.status,
      startedAt: m.startedAt,
      spentUsd: m.spentUsd,
      primary: summary.primary,
    },
    variants: summary.variants.map((s) => ({
      id: s.info.id,
      model: s.info.model,
      prompt: s.info.prompt,
      context: s.info.context ?? 'none',
      acc: s.answerable.accuracy,
      correct: s.answerable.correct,
      n: s.answerable.n,
      perAnswerUsd: s.cost.perAnswerUsd,
      p50: Number.isNaN(s.latency.p50) ? null : s.latency.p50,
      p95: Number.isNaN(s.latency.p95) ? null : s.latency.p95,
      frontier: frontier.has(s.info.id),
    })),
    items: run.dataset.items.map((i) => ({
      id: i.id,
      input: i.input,
      reference: i.reference,
      answerable: i.answerable,
      tags: i.tags,
      exclude: i.exclude ?? null,
    })),
    // "variant\u0000item" → one entry per repeat
    cells: buildCells(run),
  };

  const rows = summaryRows(summary);
  const cols = rows.length ? Object.keys(rows[0]!) : [];
  const summaryTable = `<table class="data"><thead><tr>${cols.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>${rows
    .map((r) => `<tr>${cols.map((c, i) => `<td${i ? ' class="num"' : ''}>${esc(String((r as Record<string, unknown>)[c] ?? ''))}</td>`).join('')}</tr>`)
    .join('')}</tbody></table>`;

  const sig = [...summary.pairs].sort((a, b) => a.p - b.p);
  const pairsTable = sig.length
    ? `<table class="data"><thead><tr><th>A</th><th>B</th><th>only A right</th><th>only B right</th><th>p (exact McNemar)</th></tr></thead><tbody>${sig
        .map(
          (p) =>
            `<tr${p.p < 0.05 ? ' class="sig"' : ''}><td>${esc(p.a)}</td><td>${esc(p.b)}</td><td class="num">${p.onlyA.length}</td><td class="num">${p.onlyB.length}</td><td class="num">${p.p < 0.001 ? '&lt;0.001' : p.p.toFixed(3)}${p.p < 0.05 ? ' · significant' : ''}</td></tr>`,
        )
        .join('')}</tbody></table>`
    : '<p class="muted">One variant: nothing to compare.</p>';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(m.experiment)} · eval report</title>
<style>${CSS}</style>
</head>
<body>
<main>
  <header>
    <h1>${esc(m.experiment)}</h1>
    <p class="lede" id="lede"></p>
    <p class="muted" id="meta"></p>
  </header>

  <section>
    <h2>Accuracy vs cost</h2>
    <p class="muted">Each dot is a variant: accuracy on answerable items with its 95% interval, against the average cost of one answer. Blue dots are on the Pareto frontier: no other variant is both cheaper and more accurate.</p>
    <div class="legend" aria-hidden="true">
      <span><i class="key dot frontier"></i>On the frontier</span>
      <span><i class="key dot dominated"></i>Dominated</span>
      <span><i class="key whisker"></i>95% interval</span>
    </div>
    <div class="chart" id="scatter"></div>
  </section>

  <section>
    <h2>Latency per answer</h2>
    <p class="muted">Bar = median (p50), tick = p95. Cached answers keep the latency of their original call.</p>
    <div class="chart" id="latency"></div>
  </section>

  <section>
    <h2>Summary</h2>
    <div class="scroll">${summaryTable}</div>
    <p class="muted">* = on the accuracy/cost Pareto frontier. "no answer" = errors, empty, truncated or skipped.</p>
  </section>

  <section>
    <h2>Paired comparisons</h2>
    <p class="muted">Exact McNemar test on the same answerable items: "only A right" counts items A got right and B didn't.</p>
    <div class="scroll">${pairsTable}</div>
  </section>

  <section>
    <h2>Every answer</h2>
    <div class="filters">
      <label>Show <select id="f-show">
        <option value="all">All items</option>
        <option value="misses">Items any variant missed</option>
        <option value="split">Items where variants disagree</option>
      </select></label>
      <label>Tag <select id="f-tag"><option value="">Any</option></select></label>
      <label class="grow">Search <input id="f-q" type="search" placeholder="Item id or question text"></label>
    </div>
    <p class="muted" id="grid-count"></p>
    <div class="scroll grid-wrap"><table class="grid" id="grid"></table></div>
  </section>
</main>

<div class="tooltip" id="tip" role="status" hidden></div>
<dialog id="detail"><form method="dialog"><button class="close" aria-label="Close">✕</button></form><div id="detail-body"></div></dialog>

<script id="data" type="application/json">${embed(data)}</script>
<script>${JS}</script>
</body>
</html>
`;
}

function buildCells(run: LoadedRun) {
  const primary = run.manifest.primary;
  const scoreBy = new Map(run.scores.filter((s) => s.scorer === primary).map((s) => [`${s.variant}\0${s.item}\0${s.repeat}`, s]));
  const cells: Record<string, { repeat: number; label: string; pass: boolean | null; reason: string; answer: string; status: string; latencyMs: number; costUsd: number | null }[]> = {};
  for (const r of [...run.results].sort((a, b) => a.repeat - b.repeat)) {
    const s = scoreBy.get(`${r.variant}\0${r.item}\0${r.repeat}`);
    const label = r.status === 'ok' || r.status === 'truncated' ? (s?.label ?? (s?.pass === true ? 'pass' : s?.pass === false ? 'fail' : 'n/a')) : r.status;
    (cells[`${r.variant}\u0000${r.item}`] ??= []).push({
      repeat: r.repeat,
      label: r.status === 'truncated' && s?.label ? `${s.label} (truncated)` : label,
      pass: s?.pass ?? null,
      reason: s?.reason ?? r.error ?? '',
      answer: r.answer ?? '',
      status: r.status,
      latencyMs: r.latencyMs,
      costUsd: r.costUsd,
    });
  }
  return cells;
}

const CSS = `
:root {
  color-scheme: light;
  --page: #f9f9f7; --surface: #fcfcfb; --ink: #0b0b0b; --ink-2: #52514e; --muted: #898781;
  --grid: #e1e0d9; --axis: #c3c2b7; --border: rgba(11,11,11,0.10);
  --accent: #2a78d6; --accent-wash: rgba(42,120,214,0.10); --dominated: #898781;
  --good: #0ca30c; --warning: #fab219; --serious: #ec835a; --critical: #d03b3b;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    color-scheme: dark;
    --page: #0d0d0d; --surface: #1a1a19; --ink: #f0efec; --ink-2: #c3c2b7; --muted: #898781;
    --grid: #2c2c2a; --axis: #383835; --border: rgba(255,255,255,0.10);
    --accent: #3987e5; --accent-wash: rgba(57,135,229,0.14); --dominated: #898781;
  }
}
:root[data-theme="dark"] {
  color-scheme: dark;
  --page: #0d0d0d; --surface: #1a1a19; --ink: #f0efec; --ink-2: #c3c2b7; --muted: #898781;
  --grid: #2c2c2a; --axis: #383835; --border: rgba(255,255,255,0.10);
  --accent: #3987e5; --accent-wash: rgba(57,135,229,0.14); --dominated: #898781;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--page); color: var(--ink); font: 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 1100px; margin: 0 auto; padding: 24px 16px 64px; }
h1 { font-size: 24px; margin: 0 0 4px; font-weight: 600; }
h2 { font-size: 16px; margin: 0 0 4px; font-weight: 600; }
.lede { margin: 0 0 4px; color: var(--ink-2); }
.muted { color: var(--muted); margin: 0 0 12px; font-size: 13px; }
section { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 20px; margin-top: 16px; }
.scroll { overflow-x: auto; }
table.data { border-collapse: collapse; width: 100%; font-size: 13px; }
table.data th, table.data td { text-align: left; padding: 6px 10px; border-bottom: 1px solid var(--grid); white-space: nowrap; }
table.data th { color: var(--ink-2); font-weight: 600; }
td.num { font-variant-numeric: tabular-nums; }
tr.sig td { font-weight: 600; }
.legend { display: flex; gap: 16px; flex-wrap: wrap; font-size: 13px; color: var(--ink-2); margin-bottom: 8px; }
.legend span { display: inline-flex; align-items: center; gap: 6px; }
.key.dot { width: 10px; height: 10px; border-radius: 50%; display: inline-block; }
.key.dot.frontier { background: var(--accent); }
.key.dot.dominated { background: var(--dominated); }
.key.whisker { width: 2px; height: 14px; background: var(--muted); display: inline-block; }
.chart svg { display: block; width: 100%; height: auto; overflow: visible; }
.chart text { fill: var(--ink-2); font-size: 12px; font-family: inherit; }
.chart .tick text { fill: var(--muted); font-variant-numeric: tabular-nums; }
.chart .gridline { stroke: var(--grid); stroke-width: 1; }
.chart .baseline { stroke: var(--axis); stroke-width: 1; }
.chart .hit { fill: transparent; cursor: default; }
.chart .hit:focus { outline: none; }
.chart g.mark:hover .dot, .chart g.mark:focus-within .dot { stroke: var(--ink); }
.tooltip { position: fixed; z-index: 10; pointer-events: none; background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px; font-size: 12px; box-shadow: 0 4px 16px rgba(0,0,0,0.12); max-width: 280px; }
.tooltip strong { display: block; font-size: 14px; }
.tooltip .sub { color: var(--ink-2); }
.filters { display: flex; flex-wrap: wrap; gap: 12px; margin: 8px 0; align-items: end; }
.filters label { display: flex; flex-direction: column; gap: 2px; font-size: 12px; color: var(--ink-2); }
.filters .grow { flex: 1 1 200px; }
select, input { font: inherit; color: var(--ink); background: var(--page); border: 1px solid var(--border); border-radius: 6px; padding: 5px 8px; }
.grid-wrap { max-height: 70vh; overflow: auto; border: 1px solid var(--grid); border-radius: 8px; }
table.grid { border-collapse: separate; border-spacing: 0; font-size: 12px; min-width: 100%; }
table.grid th, table.grid td { padding: 4px 8px; border-bottom: 1px solid var(--grid); background: var(--surface); }
table.grid thead th { position: sticky; top: 0; z-index: 2; text-align: left; color: var(--ink-2); white-space: nowrap; }
table.grid th.item { position: sticky; left: 0; z-index: 1; text-align: left; font-weight: 400; min-width: 220px; max-width: 360px; }
table.grid thead th.item { z-index: 3; }
th.item .id { font-weight: 600; font-variant-numeric: tabular-nums; }
th.item .q { color: var(--ink-2); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
button.cell { font: inherit; color: var(--ink); background: none; border: 1px solid transparent; border-radius: 6px; padding: 2px 6px; cursor: pointer; display: inline-flex; gap: 4px; align-items: center; white-space: nowrap; }
button.cell:hover, button.cell:focus-visible { border-color: var(--border); background: var(--page); }
.badge { display: inline-flex; align-items: center; gap: 4px; }
.badge i { width: 8px; height: 8px; border-radius: 50%; display: inline-block; flex: none; }
.s-good i { background: var(--good); } .s-ok i { background: var(--muted); } .s-warning i { background: var(--warning); }
.s-serious i { background: var(--serious); } .s-critical i { background: var(--critical); }
.excluded { color: var(--muted); font-style: italic; }
dialog { border: 1px solid var(--border); border-radius: 12px; background: var(--surface); color: var(--ink); width: min(820px, calc(100vw - 32px)); max-height: 85vh; padding: 20px; }
dialog::backdrop { background: rgba(0,0,0,0.4); }
dialog .close { float: right; font: inherit; background: none; border: none; color: var(--ink-2); cursor: pointer; font-size: 16px; }
dialog h3 { margin: 0 0 8px; font-size: 16px; }
dialog h4 { margin: 16px 0 4px; font-size: 13px; color: var(--ink-2); }
dialog pre { white-space: pre-wrap; word-break: break-word; background: var(--page); border: 1px solid var(--grid); border-radius: 8px; padding: 10px; font: 12px/1.5 ui-monospace, "Cascadia Code", Consolas, monospace; margin: 0; }
dialog ul { margin: 0; padding-left: 18px; }
`;

const JS = `
(() => {
  const data = JSON.parse(document.getElementById('data').textContent);
  const NS = 'http://www.w3.org/2000/svg';
  const $ = (id) => document.getElementById(id);
  const el = (tag, attrs = {}, text) => {
    const n = tag.startsWith('svg:') ? document.createElementNS(NS, tag.slice(4)) : document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    if (text !== undefined) n.textContent = text;
    return n;
  };
  const pct = (x) => Math.round(x * 100) + '%';
  const usd = (x) => x === 0 ? '$0' : x < 0.01 ? '$' + x.toFixed(4) : '$' + x.toFixed(3);
  const secs = (ms) => ms == null ? '-' : (ms / 1000).toFixed(1) + 's';
  const m = data.meta;

  $('lede').textContent = m.description;
  $('meta').textContent = m.dataset + ' · ' + m.scored + ' scored items' + (m.repeats > 1 ? ' × ' + m.repeats + ' repeats' : '') +
    ' · headline metric: ' + m.primary + ' · ' + m.startedAt.slice(0, 16).replace('T', ' ') + ' UTC · status ' + m.status + ' · spent ' + usd(m.spentUsd);

  // ---------- tooltip ----------
  const tip = $('tip');
  function showTip(evt, lines) {
    tip.replaceChildren();
    lines.forEach((l, i) => tip.append(el(i === 0 ? 'strong' : 'div', i > 1 ? { class: 'sub' } : {}, l)));
    tip.hidden = false;
    const r = evt.target.getBoundingClientRect();
    const x = evt.clientX ?? r.right, y = evt.clientY ?? r.top;
    const w = tip.offsetWidth, h = tip.offsetHeight;
    tip.style.left = Math.min(window.innerWidth - w - 8, x + 12) + 'px';
    tip.style.top = Math.max(8, y - h - 12) + 'px';
  }
  const hideTip = () => { tip.hidden = true; };

  // ---------- accuracy vs cost ----------
  (function scatter() {
    const vs = data.variants.filter((v) => v.n > 0);
    if (!vs.length) return;
    const W = 720, H = 380, L = 56, R = 140, T = 16, B = 44;
    const svg = el('svg:svg', { viewBox: '0 0 ' + W + ' ' + H, role: 'img', 'aria-label': 'Accuracy against cost per answer, one dot per variant' });
    const costs = vs.map((v) => v.perAnswerUsd).filter((c) => c > 0);
    const minC = Math.min(...costs), maxC = Math.max(...costs);
    const log = costs.length > 1 && maxC / minC > 8;
    let x, ticksX;
    if (log) {
      const lo = Math.log10(minC) - 0.15, hi = Math.log10(maxC) + 0.15;
      x = (c) => L + ((Math.log10(Math.max(c, minC / 2)) - lo) / (hi - lo)) * (W - L - R);
      ticksX = [];
      for (let e = Math.floor(lo); e <= Math.ceil(hi); e++) for (const k of [1, 2, 5]) { const t = k * 10 ** e; if (Math.log10(t) >= lo && Math.log10(t) <= hi) ticksX.push(t); }
    } else {
      const hi = (maxC || 1) * 1.15;
      x = (c) => L + (c / hi) * (W - L - R);
      const step = niceStep(hi / 5);
      ticksX = []; for (let t = 0; t <= hi; t += step) ticksX.push(t);
    }
    const minY = Math.max(0, Math.floor(Math.min(...vs.map((v) => v.acc.lo)) * 10) / 10 - 0.05);
    const y = (a) => T + (1 - (a - minY) / (1 - minY)) * (H - T - B);
    const ticksY = []; for (let t = Math.ceil(minY * 10) / 10; t <= 1.0001; t += 0.1) ticksY.push(t);

    for (const t of ticksY) {
      const g = el('svg:g', { class: 'tick' });
      g.append(el('svg:line', { class: 'gridline', x1: L, x2: W - R, y1: y(t), y2: y(t) }));
      g.append(el('svg:text', { x: L - 8, y: y(t) + 4, 'text-anchor': 'end' }, pct(t)));
      svg.append(g);
    }
    svg.append(el('svg:line', { class: 'baseline', x1: L, x2: W - R, y1: H - B, y2: H - B }));
    for (const t of ticksX) {
      const g = el('svg:g', { class: 'tick' });
      g.append(el('svg:text', { x: x(t), y: H - B + 18, 'text-anchor': 'middle' }, usd(t)));
      svg.append(g);
    }
    svg.append(el('svg:text', { x: (L + W - R) / 2, y: H - 6, 'text-anchor': 'middle' }, 'Cost per answer' + (log ? ' (log scale)' : '')));

    const front = vs.filter((v) => v.frontier).sort((a, b) => a.perAnswerUsd - b.perAnswerUsd);
    if (front.length > 1) {
      svg.append(el('svg:polyline', { points: front.map((v) => x(v.perAnswerUsd) + ',' + y(v.acc.p)).join(' '), fill: 'none', stroke: 'var(--accent)', 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round', opacity: 0.5 }));
    }
    // Labels: nudge apart labels that would overlap (same side, < 14px apart vertically).
    const placed = [];
    for (const v of [...vs].sort((a, b) => b.acc.p - a.acc.p)) {
      const cx = x(v.perAnswerUsd), cy = y(v.acc.p);
      const color = v.frontier ? 'var(--accent)' : 'var(--dominated)';
      const g = el('svg:g', { class: 'mark' });
      g.append(el('svg:line', { x1: cx, x2: cx, y1: y(v.acc.lo), y2: y(v.acc.hi), stroke: color, 'stroke-width': 2, opacity: 0.35, 'stroke-linecap': 'round' }));
      g.append(el('svg:circle', { class: 'dot', cx, cy, r: 5, fill: color, stroke: 'var(--surface)', 'stroke-width': 2 }));
      let ly = cy + 4;
      while (placed.some((p) => Math.abs(p.y - ly) < 14 && Math.abs(p.x - cx) < 120)) ly += 14;
      placed.push({ x: cx, y: ly });
      g.append(el('svg:text', { x: cx + 10, y: ly }, v.id));
      const hit = el('svg:circle', { class: 'hit', cx, cy, r: 14, tabindex: 0, 'aria-label': v.id + ': ' + pct(v.acc.p) + ' accuracy, ' + usd(v.perAnswerUsd) + ' per answer' });
      const lines = () => [pct(v.acc.p) + ' accurate (' + v.correct + '/' + v.n + ')', v.id, '95% interval ' + pct(v.acc.lo) + '–' + pct(v.acc.hi), usd(v.perAnswerUsd) + ' per answer · median ' + secs(v.p50), v.model + (v.frontier ? ' · on the frontier' : '')];
      hit.addEventListener('pointermove', (e) => showTip(e, lines()));
      hit.addEventListener('focus', (e) => showTip(e, lines()));
      hit.addEventListener('pointerleave', hideTip);
      hit.addEventListener('blur', hideTip);
      g.append(hit);
      svg.append(g);
    }
    $('scatter').append(svg);
  })();

  function niceStep(raw) {
    const p = 10 ** Math.floor(Math.log10(raw)), f = raw / p;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p;
  }

  // ---------- latency ----------
  (function latency() {
    const vs = data.variants.filter((v) => v.p50 != null);
    if (!vs.length) return;
    const bar = 18, gap = 14, L = 170, R = 150, T = 8;
    const W = 720, H = T + vs.length * (bar + gap) + 28;
    const max = Math.max(...vs.map((v) => v.p95 ?? v.p50)) * 1.05;
    const x = (ms) => L + (ms / max) * (W - L - R);
    const svg = el('svg:svg', { viewBox: '0 0 ' + W + ' ' + H, role: 'img', 'aria-label': 'Median and p95 latency per variant' });
    const step = niceStep(max / 5);
    for (let t = 0; t <= max; t += step) {
      const g = el('svg:g', { class: 'tick' });
      g.append(el('svg:line', { class: 'gridline', x1: x(t), x2: x(t), y1: T, y2: H - 24 }));
      g.append(el('svg:text', { x: x(t), y: H - 8, 'text-anchor': 'middle' }, secs(t)));
      svg.append(g);
    }
    vs.forEach((v, i) => {
      const yy = T + i * (bar + gap);
      const w = Math.max(2, x(v.p50) - L);
      const g = el('svg:g', { class: 'mark' });
      g.append(el('svg:text', { x: L - 10, y: yy + bar / 2 + 4, 'text-anchor': 'end' }, v.id));
      // 4px rounded data end, square at the baseline.
      g.append(el('svg:path', { d: 'M' + L + ',' + yy + 'h' + Math.max(0, w - 4) + 'a4,4 0 0 1 4,4v' + (bar - 8) + 'a4,4 0 0 1 -4,4h-' + Math.max(0, w - 4) + 'z', fill: 'var(--accent)' }));
      if (v.p95 != null) g.append(el('svg:line', { x1: x(v.p95), x2: x(v.p95), y1: yy - 3, y2: yy + bar + 3, stroke: 'var(--ink-2)', 'stroke-width': 2, 'stroke-linecap': 'round' }));
      g.append(el('svg:text', { x: x(v.p95 ?? v.p50) + 8, y: yy + bar / 2 + 4 }, secs(v.p50) + ' · p95 ' + secs(v.p95)));
      const hit = el('svg:rect', { class: 'hit', x: 0, y: yy - gap / 2, width: W, height: bar + gap, tabindex: 0, 'aria-label': v.id + ': median ' + secs(v.p50) + ', p95 ' + secs(v.p95) });
      const lines = () => [secs(v.p50) + ' median', v.id, 'p95 ' + secs(v.p95)];
      hit.addEventListener('pointermove', (e) => showTip(e, lines()));
      hit.addEventListener('focus', (e) => showTip(e, lines()));
      hit.addEventListener('pointerleave', hideTip);
      hit.addEventListener('blur', hideTip);
      g.append(hit);
      svg.append(g);
    });
    $('latency').append(svg);
  })();

  // ---------- verdict grid ----------
  const GOOD = ['correct', 'declined', 'pass'], OK = ['acceptable'], WARN = ['outdated'], BAD = ['wrong', 'hallucinated', 'fail'];
  function statusOf(label) {
    const base = label.replace(' (truncated)', '');
    if (GOOD.includes(base)) return ['s-good', '✓'];
    if (OK.includes(base)) return ['s-ok', '≈'];
    if (WARN.includes(base)) return ['s-warning', '⚠'];
    if (BAD.includes(base)) return ['s-critical', '✗'];
    return ['s-serious', '!'];
  }
  const cellsFor = (v, item) => data.cells[v + '\\u0000' + item] || [];
  const passed = (c) => c.pass === true;

  const tagSel = $('f-tag');
  [...new Set(data.items.flatMap((i) => i.tags))].sort().forEach((t) => tagSel.append(el('option', { value: t }, t)));

  function render() {
    const show = $('f-show').value, tag = tagSel.value, q = $('f-q').value.trim().toLowerCase();
    const items = data.items.filter((i) => {
      if (tag && !i.tags.includes(tag)) return false;
      if (q && !(i.id.toLowerCase().includes(q) || i.input.toLowerCase().includes(q))) return false;
      const cs = data.variants.flatMap((v) => cellsFor(v.id, i.id));
      if (show === 'misses') return cs.some((c) => !passed(c));
      if (show === 'split') return cs.some(passed) && cs.some((c) => !passed(c));
      return true;
    });
    $('grid-count').textContent = items.length + ' of ' + data.items.length + ' items. Click a verdict to read the answer and the judge\\'s reason.';
    const table = $('grid');
    table.replaceChildren();
    const head = el('tr');
    head.append(el('th', { class: 'item' }, 'Item'));
    data.variants.forEach((v) => head.append(el('th', {}, v.id)));
    const thead = el('thead');
    thead.append(head);
    table.append(thead);
    const body = el('tbody');
    for (const item of items) {
      const tr = el('tr');
      const th = el('th', { class: 'item', scope: 'row' });
      th.append(el('div', { class: 'id' }, item.id + (item.answerable ? '' : ' · unanswerable')));
      th.append(el('div', { class: 'q', title: item.input }, item.input));
      if (item.exclude) th.append(el('div', { class: 'excluded' }, 'not scored: ' + item.exclude));
      tr.append(th);
      for (const v of data.variants) {
        const td = el('td');
        cellsFor(v.id, item.id).forEach((c) => {
          const [cls, icon] = statusOf(c.label);
          const b = el('button', { class: 'cell', type: 'button', 'aria-label': v.id + ', ' + item.id + ': ' + c.label });
          const badge = el('span', { class: 'badge ' + cls });
          badge.append(el('i'), document.createTextNode(icon + ' ' + c.label));
          b.append(badge);
          b.addEventListener('click', () => openDetail(item, v, c));
          td.append(b);
        });
        tr.append(td);
      }
      body.append(tr);
    }
    table.append(body);
  }

  function openDetail(item, v, c) {
    const box = $('detail-body');
    box.replaceChildren();
    box.append(el('h3', {}, item.id + ' · ' + v.id + (m.repeats > 1 ? ' · repeat ' + (c.repeat + 1) : '')));
    box.append(el('p', { class: 'muted' }, c.label + ' · ' + secs(c.latencyMs) + (c.costUsd != null ? ' · ' + usd(c.costUsd) : '') + ' · ' + v.model));
    box.append(el('h4', {}, 'Question'), el('p', {}, item.input));
    if (item.reference.length) {
      box.append(el('h4', {}, 'Reference'));
      const ul = el('ul');
      item.reference.forEach((r) => ul.append(el('li', {}, r)));
      box.append(ul);
    }
    if (c.reason) box.append(el('h4', {}, 'Why'), el('p', {}, c.reason));
    box.append(el('h4', {}, 'Answer'), el('pre', {}, c.answer || '(no answer)'));
    $('detail').showModal();
  }

  ['f-show', 'f-tag', 'f-q'].forEach((id) => $(id).addEventListener('input', render));
  render();
})();
`;
