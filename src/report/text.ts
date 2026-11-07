import type { LoadedRun } from '../run.js';
import type { RunSummary, VariantSummary } from '../metrics.js';

// ---------- Formatting helpers ----------

export const pct = (x: number) => `${Math.round(x * 100)}%`;
export const usd = (x: number) => (x === 0 ? '$0' : x < 0.01 ? `$${x.toFixed(4)}` : `$${x.toFixed(3)}`);
export const secs = (ms: number) => (Number.isNaN(ms) ? '-' : `${(ms / 1000).toFixed(1)}s`);
export const pValue = (p: number) => (p < 0.001 ? '<0.001' : p.toFixed(3));
const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');

export function accuracyCell(s: VariantSummary): string {
  const a = s.answerable;
  if (!a.n) return '-';
  return `${a.correct}/${a.n} ${pct(a.accuracy.p)} [${pct(a.accuracy.lo)}–${pct(a.accuracy.hi)}]`;
}

// Labels other than the passing ones, e.g. "outdated 2, wrong 1".
function otherLabels(labels: Record<string, number>, skip: string[]): string {
  return (
    Object.entries(labels)
      .filter(([l]) => !skip.includes(l))
      .sort((a, b) => b[1] - a[1])
      .map(([l, n]) => `${l} ${n}`)
      .join(', ') || '-'
  );
}

const problems = (s: VariantSummary) => s.status.error + s.status.empty + s.status.truncated + s.status.skipped;

export function summaryRows(summary: RunSummary) {
  return summary.variants.map((s) => ({
    variant: s.info.id + (summary.frontier.includes(s.info.id) ? ' *' : ''),
    accuracy: accuracyCell(s),
    'correct+acceptable': s.answerable.n ? `${s.answerable.lenient}/${s.answerable.n}` : '-',
    misses: otherLabels(s.answerable.labels, ['correct', 'acceptable', 'pass']),
    declined: s.unanswerable.n ? `${s.unanswerable.declined}/${s.unanswerable.n}` : '-',
    hallucinated: s.unanswerable.labels.hallucinated ?? 0,
    'no answer': problems(s),
    '$/answer': usd(s.cost.perAnswerUsd),
    '$ answers': usd(s.cost.answersUsd),
    '$ judge': usd(s.cost.judgeUsd),
    'p50 latency': secs(s.latency.p50),
    'p95 latency': secs(s.latency.p95),
    'avg in/out tok': `${Math.round(s.tokens.input)}/${Math.round(s.tokens.output)}`,
  }));
}

// ---------- Console ----------

export function printSummary(run: LoadedRun, summary: RunSummary, log = console.log) {
  const m = run.manifest;
  log(`\n${m.experiment} — ${m.dataset.name} (${summary.items.scored} scored items${m.repeats > 1 ? ` × ${m.repeats} repeats` : ''}), status: ${m.status}`);
  log(`Accuracy = "${summary.primary}" passes on answerable items, with a 95% Wilson interval. * = on the accuracy/cost Pareto frontier.`);
  console.table(summaryRows(summary));
  const sig = summary.pairs.filter((p) => p.p < 0.05);
  if (summary.pairs.length) {
    log(`Paired differences (exact McNemar): ${sig.length} of ${summary.pairs.length} pairs significant at p < 0.05`);
    for (const p of sig) log(`  ${p.a} vs ${p.b}: ${p.onlyA.length} vs ${p.onlyB.length} items only one got right, p = ${pValue(p.p)}`);
  }
  if (summary.items.excluded.length) log(`Not scored: ${summary.items.excluded.map((e) => `${e.id} (${e.reason})`).join('; ')}`);
  if (m.spentUsd) log(`Spent this run: ${usd(m.spentUsd)} (cache hits are free)`);
}

// ---------- Markdown ----------

function table(rows: Record<string, string | number>[]): string {
  if (!rows.length) return '';
  const cols = Object.keys(rows[0]!);
  return [
    `| ${cols.map(cell).join(' | ')} |`,
    `| ${cols.map(() => '---').join(' | ')} |`,
    ...rows.map((r) => `| ${cols.map((c) => cell(String(r[c] ?? ''))).join(' | ')} |`),
  ].join('\n');
}

export function markdownReport(run: LoadedRun, summary: RunSummary): string {
  const m = run.manifest;
  const out: string[] = [];
  out.push(`# ${m.experiment}`);
  if (m.description) out.push(m.description);
  out.push(
    [
      `- **Dataset:** ${m.dataset.name} — ${summary.items.scored} scored items of ${summary.items.total}${m.repeats > 1 ? `, ${m.repeats} repeats` : ''}`,
      `- **Headline metric:** \`${summary.primary}\` (${summary.primaryKind}) on answerable items, 95% Wilson interval`,
      `- **Run:** ${m.startedAt}${m.finishedAt ? ` → ${m.finishedAt}` : ''}, status \`${m.status}\`, spent ${usd(m.spentUsd)}`,
      ...(m.filters.items ? [`- **Items filter:** ${m.filters.items.join(', ')}`] : []),
    ].join('\n'),
  );

  out.push('## Summary', table(summaryRows(summary)), '`*` = on the accuracy/cost Pareto frontier: no other variant is both cheaper and more accurate.');

  if (summary.pairs.length) {
    out.push(
      '## Paired comparisons',
      'Exact McNemar test on answerable items (majority verdict over repeats). "Only A" = items A got right and B didn\'t.',
      table(
        [...summary.pairs]
          .sort((x, y) => x.p - y.p)
          .map((p) => ({ A: p.a, B: p.b, 'only A': p.onlyA.length, 'only B': p.onlyB.length, both: p.both, neither: p.neither, p: pValue(p.p) + (p.p < 0.05 ? ' ✓' : '') })),
      ),
    );
  }

  const checkNames = [...new Set(summary.variants.flatMap((s) => Object.keys(s.checks)))];
  const hasCitations = summary.variants.some((s) => s.citations);
  if (checkNames.length || hasCitations) {
    out.push(
      '## Checks',
      'String checks are cheap but blunt: they fail correct paraphrases and flag outdated names an answer only mentions as deprecated.',
      table(
        summary.variants.map((s) => {
          const row: Record<string, string> = { variant: s.info.id };
          for (const n of checkNames) {
            const c = s.checks[n];
            row[n] = c && c.pass + c.fail ? `${c.pass}/${c.pass + c.fail}` : '-';
          }
          if (hasCitations) {
            const c = s.citations;
            row['uncited'] = c ? String(c.uncited) : '-';
            row['bad citations'] = c ? String(c.invalid) : '-';
            row['evidence in context'] = c ? `${c.evidenceInSources[0]}/${c.evidenceInSources[1]}` : '-';
            row['cites evidence'] = c ? `${c.citesEvidence[0]}/${c.citesEvidence[1]}` : '-';
          }
          return row;
        }),
      ),
    );
  }

  if (m.repeats > 1) {
    out.push(
      '## Repeats',
      table(
        summary.variants.map((s) => ({
          variant: s.info.id,
          'accuracy per repeat': s.repeats.accuracy.map(pct).join(', '),
          'same verdict in every repeat': s.repeats.agreement === null ? '-' : pct(s.repeats.agreement),
        })),
      ),
    );
  }

  if (summary.tags.length) {
    out.push(
      '## By tag',
      `"${summary.primary}" pass rate per tag (for \`unanswerable\`, that's the decline rate).`,
      table(
        summary.tags.map((t) => {
          const row: Record<string, string> = { tag: t.tag, n: String(t.n) };
          for (const s of summary.variants) row[s.info.id] = pct(t.byVariant[s.info.id] ?? 0);
          return row;
        }),
      ),
    );
  }

  out.push(
    '## Variants',
    table(
      m.variants.map((v) => ({
        id: v.id,
        model: `\`${v.model}\``,
        prompt: v.prompt,
        context: v.context ?? 'none',
        'context config': v.contextConfig ? Object.entries(v.contextConfig).map(([k, x]) => `${k}=${JSON.stringify(x)}`).join(', ') : '-',
        params: `temp ${v.params.temperature}, max out ${v.params.maxOutputTokens}, reasoning ${v.params.reasoningMaxTokens ?? 'default'}`,
      })),
    ),
  );

  // Every miss, with the scorer's reason: the part of a report worth reading line by line.
  const itemsById = new Map(run.dataset.items.map((i) => [i.id, i]));
  const misses = run.scores
    .filter((s) => s.scorer === m.primary && s.pass !== true && itemsById.get(s.item)?.exclude === undefined)
    .sort((a, b) => a.variant.localeCompare(b.variant) || a.item.localeCompare(b.item) || a.repeat - b.repeat);
  out.push('## Misses');
  if (!misses.length) out.push('None.');
  else
    out.push(
      table(
        misses.map((s) => ({
          variant: s.variant,
          item: s.item + (m.repeats > 1 ? `#${s.repeat}` : ''),
          verdict: s.label ?? (s.pass === null ? 'n/a' : 'fail'),
          reason: s.reason ?? '',
          question: (itemsById.get(s.item)?.input ?? '').slice(0, 140),
        })),
      ),
    );
  if (summary.items.excluded.length) {
    out.push('## Not scored', summary.items.excluded.map((e) => `- \`${e.id}\`: ${e.reason}`).join('\n'));
  }
  return out.join('\n\n') + '\n';
}
