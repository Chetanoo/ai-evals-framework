/**
 * Bridges doc-agent-rag's frozen eval runs (evals/baselines/*.json + *.judged.json) and this framework.
 *
 *   import <run.json> --dataset <file> --name <name>
 *       Converts a doc-agent run into a run directory (runs/docs-agent-import/<name>), with
 *       doc-agent's verdicts as the "judge" scores and a copy under "docs-agent-judge".
 *       Free: no model calls. `npm run eval -- report <dir>` then shows it like any other run.
 *
 *   agreement <run-dir>
 *       After `npm run eval -- judge <run-dir> --model google/gemini-3.6-flash` has re-graded the
 *       answers with this framework's judge, prints how often it agrees with doc-agent's judge.
 *
 *   npx tsx scripts/docs-agent-run.ts import ../doc-agent-rag/evals/baselines/rag-v5-run1.json --dataset datasets/docs-agent/original.json --name rag-v5-original
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { loadDataset, readJson } from '../src/dataset.js';
import { loadRun, runFiles, writeManifest, type Manifest } from '../src/run.js';
import { excludes, includes, llmJudge } from '../src/scorers/index.js';
import { hashOf, JsonlWriter } from '../src/store.js';
import type { Result, Score } from '../src/types.js';
import { modelAlias } from '../src/config.js';

type DocsAgentResult = {
  model: string;
  id: string;
  status: string;
  answer: string | null;
  finishReason: string | null;
  error: string | null;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  costUsd: number | null;
  sources?: unknown[];
};
type DocsAgentRun = { models: string[]; instructions?: string; settings?: Record<string, number>; retrieval?: Record<string, unknown>; results: DocsAgentResult[] };
type DocsAgentJudged = { judgeModel: string; judgments: { model: string; id: string; verdict: string; reason: string; judgeCostUsd: number | null }[] };

const JUDGE = llmJudge({ model: 'google/gemini-3.6-flash', domain: 'developer questions about the Vercel AI SDK, version 7' });
const LENIENT = ['correct', 'acceptable'];

async function importRun(file: string, datasetFile: string, name: string) {
  const run = (await readJson(file)) as DocsAgentRun;
  const judged = (await readJson(file.replace(/\.json$/, '.judged.json'))) as DocsAgentJudged;
  const dataset = await loadDataset(datasetFile);
  const items = new Map(dataset.items.map((i) => [i.id, i]));
  const dir = path.resolve('runs', 'docs-agent-import', name);
  await mkdir(dir, { recursive: true });
  const files = runFiles(dir);
  await writeFile(files.dataset, JSON.stringify(dataset, null, 2));
  for (const f of [files.results, files.scores]) await writeFile(f, '');

  const results = new JsonlWriter(files.results);
  const scores = new JsonlWriter(files.scores);
  const verdicts = new Map(judged.judgments.map((j) => [`${j.model}\0${j.id}`, j]));
  const checks = [includes(), excludes('stale-mentions')];
  const ctx = { provider: { name: 'none', generate: () => Promise.reject(new Error('no calls')) }, throttle: async () => {}, cache: null };

  for (const r of run.results) {
    const item = items.get(r.id);
    if (!item) throw new Error(`${r.id} is not in ${datasetFile}`);
    const variant = modelAlias(r.model);
    const status: Result['status'] = r.status === 'error' ? 'error' : r.status === 'truncated' ? 'truncated' : r.status === 'empty' ? 'empty' : 'ok';
    const result: Result = {
      variant, item: r.id, repeat: 0, status, answer: r.answer, error: r.error, finishReason: r.finishReason,
      inputTokens: r.inputTokens, outputTokens: r.outputTokens, reasoningTokens: r.reasoningTokens, costUsd: r.costUsd,
      latencyMs: r.latencyMs, cached: false, sourceCount: r.sources?.length ?? null,
    };
    await results.append(result);
    const j = verdicts.get(`${r.model}\0${r.id}`);
    const pass = !j ? null : item.answerable ? j.verdict === 'correct' : j.verdict === 'declined';
    const base = { variant, item: r.id, repeat: 0 };
    const judgeScore = j
      ? { pass, label: j.verdict, reason: j.reason, costUsd: j.judgeCostUsd, details: { lenient: item.answerable ? LENIENT.includes(j.verdict) : pass } }
      : { pass: null, reason: 'not judged' };
    await scores.append({ ...base, scorer: 'judge', ...judgeScore } satisfies Score);
    await scores.append({ ...base, scorer: 'docs-agent-judge', ...judgeScore } satisfies Score);
    for (const c of checks) {
      const s = status === 'ok' || status === 'truncated' ? await c.score({ item, result, sources: null }, ctx) : { pass: null };
      await scores.append({ ...base, scorer: c.name, ...s });
    }
  }
  await results.flush();
  await scores.flush();

  const manifest: Manifest = {
    experiment: `docs-agent ${name}`,
    description: `Imported from doc-agent-rag ${path.basename(file)}: answers and verdicts as doc-agent recorded them (judge: ${judged.judgeModel}).`,
    dataset: { file: datasetFile, name: dataset.name, items: dataset.items.length, hash: hashOf(dataset) },
    contextsDir: null,
    variants: run.models.map((m) => ({
      id: modelAlias(m),
      model: m,
      prompt: run.retrieval ? 'rag (doc-agent)' : 'no-context (doc-agent)',
      context: run.retrieval ? 'doc-agent live retrieval' : null,
      params: { temperature: 0, maxOutputTokens: run.settings?.MAX_OUTPUT_TOKENS ?? 12000, reasoningMaxTokens: run.settings?.REASONING_MAX_TOKENS ?? 4000 },
      instructions: run.instructions ?? null,
      contextConfig: (run.retrieval as Record<string, unknown> | undefined) ?? null,
    })),
    scorers: [
      { name: 'judge', kind: 'judge', ...JUDGE.describe() },
      { name: 'docs-agent-judge', kind: 'check', type: 'imported', model: judged.judgeModel },
      ...checks.map((c) => ({ name: c.name, kind: c.kind, ...c.describe() })),
    ],
    primary: 'judge',
    repeats: 1,
    filters: { items: null, variants: null },
    status: 'complete',
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    spentUsd: 0,
  };
  await writeManifest(dir, manifest);
  console.log(`Imported ${run.results.length} answers → ${dir}`);
}

async function agreement(dir: string) {
  const run = await loadRun(path.resolve(dir));
  const by = (scorer: string) => new Map(run.scores.filter((s) => s.scorer === scorer && s.label).map((s) => [`${s.variant}\0${s.item}`, s]));
  const ours = by('judge');
  const theirs = by('docs-agent-judge');
  if (!run.manifest.rejudged?.length) console.warn('Warning: this run was never re-judged, so "judge" still holds doc-agent\'s verdicts.');
  let same = 0;
  let samePass = 0;
  const diffs: string[] = [];
  for (const [k, t] of theirs) {
    const o = ours.get(k);
    if (!o) continue;
    if (o.label === t.label) same++;
    else diffs.push(`${k.replace('\0', '  ')}: doc-agent ${t.label}, framework ${o.label} — ${o.reason ?? ''}`);
    if (o.pass === t.pass) samePass++;
  }
  console.log(`Same verdict: ${same}/${theirs.size}; same pass/fail: ${samePass}/${theirs.size}`);
  for (const d of diffs) console.log(`  ${d}`);
}

const { positionals, values } = parseArgs({ allowPositionals: true, options: { dataset: { type: 'string' }, name: { type: 'string' } } });
const [cmd, arg] = positionals;
(cmd === 'import' && arg && values.dataset && values.name
  ? importRun(arg, values.dataset, values.name)
  : cmd === 'agreement' && arg
    ? agreement(arg)
    : Promise.reject(new Error('usage: import <run.json> --dataset <file> --name <name> | agreement <run-dir>'))
).catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
