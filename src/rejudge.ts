import path from 'node:path';
import { createThrottle, JsonlCache, JsonlWriter, runPool } from './store.js';
import { CACHE_DIR } from './runner.js';
import { runFiles, writeManifest, type LoadedRun } from './run.js';
import { llmJudge, type JudgeOptions } from './scorers/judge.js';
import type { Provider, Score } from './types.js';

// Re-grades every answer in a run with a judge (another model or rubric). New scores are appended
// to scores.jsonl under the same scorer name and replace the old ones when the run is loaded.
// Sources aren't stored in the run, so only the judge is re-run (checks don't change anyway).
export async function rejudge(
  run: LoadedRun,
  opts: { provider: Provider; model: string; scorer?: string; concurrency?: number; rateLimitPerMinute?: number; cache: boolean },
  log = console.log,
): Promise<void> {
  const scorerName = opts.scorer ?? run.manifest.scorers.find((s) => s.kind === 'judge')?.name;
  if (typeof scorerName !== 'string') throw new Error('This run has no judge scorer; pass --scorer <name>.');
  const desc = run.manifest.scorers.find((s) => s.name === scorerName);
  if (!desc || desc.type !== 'llm-judge') throw new Error(`"${scorerName}" is not an llm-judge scorer in this run`);

  const judge = llmJudge({
    model: opts.model,
    name: scorerName,
    rubric: desc.rubric as string,
    labels: desc.labels as NonNullable<JudgeOptions['labels']>,
  });
  const items = new Map(run.dataset.items.map((i) => [i.id, i]));
  const cache = opts.cache ? await JsonlCache.open(path.join(CACHE_DIR, 'judgments.jsonl')) : null;
  const ctx = { provider: opts.provider, throttle: createThrottle(opts.rateLimitPerMinute ?? 0), cache };
  const out = new JsonlWriter(runFiles(run.dir).scores);

  const todo = run.results.filter((r) => r.status === 'ok' || r.status === 'truncated');
  let done = 0;
  let spent = 0;
  await runPool(
    todo.map((result) => async () => {
      let s: Omit<Score, 'variant' | 'item' | 'repeat' | 'scorer'>;
      try {
        s = await judge.score({ item: items.get(result.item)!, result, sources: null }, ctx);
        if (!s.details?.cached) spent += s.costUsd ?? 0;
      } catch (err) {
        s = { pass: null, label: 'scorer-error', reason: err instanceof Error ? err.message : String(err) };
      }
      await out.append({ variant: result.variant, item: result.item, repeat: result.repeat, scorer: scorerName, ...s });
      log(`[${++done}/${todo.length}] ${result.variant}  ${result.item}  ${s.label ?? s.pass}`);
    }),
    opts.concurrency ?? 5,
  );
  await out.flush();

  const m = run.manifest;
  m.scorers = m.scorers.map((s) => (s.name === scorerName ? { ...s, model: opts.model } : s));
  m.rejudged = [...(m.rejudged ?? []), { at: new Date().toISOString(), scorer: scorerName, model: opts.model }];
  m.spentUsd = +(m.spentUsd + spent).toFixed(5);
  await writeManifest(run.dir, m);
}
