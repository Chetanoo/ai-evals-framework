import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Experiment } from './config.js';
import { loadContextSet, loadDataset } from './dataset.js';
import { fetchModels } from './providers/openrouter.js';
import { runFiles, writeManifest, type Manifest, type VariantInfo } from './run.js';
import { JsonlCache, JsonlWriter, createThrottle, hashOf, runPool } from './store.js';
import type { BuiltPrompt, Item, Provider, Result, Score, ScorerContext, Source, Variant } from './types.js';

export const CACHE_DIR = '.cache';

export type RunOptions = {
  provider: Provider;
  cache: boolean;
  items?: string[] | undefined; // only these item ids
  variants?: string[] | undefined; // only these variant ids
  outRoot?: string; // default: runs/
  cacheDir?: string; // default: .cache/
  log?: (line: string) => void;
};

type Task = {
  variant: Variant;
  item: Item;
  repeat: number;
  sources: Source[] | null;
  built: BuiltPrompt;
  key: string; // generation cache key
};

// Everything that changes the answer goes into the key. `repeat` is in it so repeats are separate samples.
const generationKey = (v: Variant, built: BuiltPrompt, repeat: number) =>
  hashOf({ model: v.model, instructions: built.instructions ?? null, prompt: built.prompt, params: v.params, repeat });

async function prepare(exp: Experiment, opts: Pick<RunOptions, 'items' | 'variants'>) {
  const dataset = await loadDataset(exp.dataset);

  let items = dataset.items;
  if (opts.items?.length) {
    const unknown = opts.items.filter((id) => !items.some((i) => i.id === id));
    if (unknown.length) throw new Error(`Unknown item ids: ${unknown.join(', ')}`);
    items = items.filter((i) => opts.items!.includes(i.id));
  }

  let variants = exp.variants;
  if (opts.variants?.length) {
    const unknown = opts.variants.filter((id) => !variants.some((v) => v.id === id));
    if (unknown.length) throw new Error(`Unknown variants: ${unknown.join(', ')}. Known: ${variants.map((v) => v.id).join(', ')}`);
    variants = variants.filter((v) => opts.variants!.includes(v.id));
  }

  const contextNames = [...new Set(variants.map((v) => v.context).filter((c): c is string => c !== null))];
  const contextSets = new Map(
    await Promise.all(contextNames.map(async (name) => [name, await loadContextSet(exp.contextsDir!, name, dataset)] as const)),
  );

  const tasks: Task[] = [];
  for (const variant of variants)
    for (const item of items) {
      const sources = variant.context === null ? null : contextSets.get(variant.context)!.items[item.id]!;
      const built = variant.prompt.build(item, sources);
      for (let repeat = 0; repeat < exp.repeats; repeat++) {
        tasks.push({ variant, item, repeat, sources, built, key: generationKey(variant, built, repeat) });
      }
    }

  return { dataset, items, variants, contextSets, tasks };
}

// ---------- Dry run: validate model ids and estimate the cost before any paid call ----------

export type Estimate = {
  tasks: number;
  cached: number;
  rows: { model: string; role: 'answer' | 'judge'; calls: number; inputTokens: number; outputTokens: number; usd: number }[];
  totalUsd: number;
};

const approxTokens = (text: string) => Math.ceil(text.length / 4);

export async function estimateRun(exp: Experiment, opts: Pick<RunOptions, 'items' | 'variants' | 'cache' | 'cacheDir'>): Promise<Estimate> {
  const { tasks } = await prepare(exp, opts);
  const cache = opts.cache ? await JsonlCache.open(path.join(opts.cacheDir ?? CACHE_DIR, 'generations.jsonl')) : null;
  const pending = tasks.filter((t) => !cache?.has(t.key));

  const judgeModels = exp.scorers
    .filter((s) => s.kind === 'judge')
    .map((s) => s.describe())
    .map((d) => ({ model: String(d.model), rubric: String(d.rubric ?? '') }));

  const models = await fetchModels();
  const allModels = [...new Set([...exp.variants.map((v) => v.model), ...judgeModels.map((j) => j.model)])];
  const unknown = allModels.filter((m) => !models.has(m));
  if (unknown.length) throw new Error(`Not on OpenRouter: ${unknown.join(', ')} (check the ids at https://openrouter.ai/models)`);

  const rows = new Map<string, Estimate['rows'][number]>();
  const add = (model: string, role: 'answer' | 'judge', input: number, output: number) => {
    const info = models.get(model)!;
    const k = `${model}\0${role}`;
    const row = rows.get(k) ?? { model, role, calls: 0, inputTokens: 0, outputTokens: 0, usd: 0 };
    row.calls++;
    row.inputTokens += input;
    row.outputTokens += output;
    row.usd += input * info.inputPerToken + output * info.outputPerToken;
    rows.set(k, row);
  };

  for (const t of pending) {
    add(t.variant.model, 'answer', approxTokens((t.built.instructions ?? '') + t.built.prompt), exp.estimatedOutputTokens);
    for (const j of judgeModels) {
      const judgeInput = approxTokens(j.rubric + t.item.input + t.item.reference.join('\n')) + exp.estimatedOutputTokens;
      // Verdicts are short: doc-agent-rag's judge averaged ~$0.00086 per call, nearly all of it input.
      add(j.model, 'judge', judgeInput, 150);
    }
  }

  const list = [...rows.values()].map((r) => ({ ...r, usd: +r.usd.toFixed(4) }));
  return { tasks: tasks.length, cached: tasks.length - pending.length, rows: list, totalUsd: +list.reduce((s, r) => s + r.usd, 0).toFixed(4) };
}

// ---------- The run ----------

function statusOf(text: string, finishReason: string): Result['status'] {
  if (finishReason === 'length') return 'truncated';
  if (text.trim() === '') return 'empty';
  return 'ok';
}

export async function runExperiment(exp: Experiment, opts: RunOptions): Promise<{ dir: string; manifest: Manifest }> {
  const log = opts.log ?? console.log;
  const { dataset, variants, contextSets, tasks } = await prepare(exp, opts);

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.resolve(opts.outRoot ?? 'runs', exp.name, stamp);
  await mkdir(dir, { recursive: true });
  const files = runFiles(dir);
  await writeFile(files.dataset, JSON.stringify(dataset, null, 2));

  const firstItem = dataset.items[0]!;
  const variantInfo: VariantInfo[] = variants.map((v) => {
    const sources = v.context === null ? null : (contextSets.get(v.context)!.items[firstItem.id] ?? []);
    return {
      id: v.id,
      model: v.model,
      prompt: v.prompt.name,
      context: v.context,
      params: v.params,
      instructions: v.prompt.build(firstItem, sources).instructions ?? null,
      contextConfig: v.context === null ? null : contextSets.get(v.context)!.config,
    };
  });

  const manifest: Manifest = {
    experiment: exp.name,
    ...(exp.description !== undefined && { description: exp.description }),
    dataset: { file: exp.dataset, name: dataset.name, items: dataset.items.length, hash: hashOf(dataset) },
    contextsDir: exp.contextsDir ?? null,
    variants: variantInfo,
    scorers: exp.scorers.map((s) => ({ name: s.name, kind: s.kind, ...s.describe() })),
    primary: exp.primary,
    repeats: exp.repeats,
    filters: { items: opts.items?.length ? opts.items : null, variants: opts.variants?.length ? opts.variants : null },
    status: 'running',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    spentUsd: 0,
  };
  await writeManifest(dir, manifest);

  const cacheDir = opts.cacheDir ?? CACHE_DIR;
  const genCache = opts.cache ? await JsonlCache.open(path.join(cacheDir, 'generations.jsonl')) : null;
  const judgeCache = opts.cache ? await JsonlCache.open(path.join(cacheDir, 'judgments.jsonl')) : null;
  const throttle = createThrottle(exp.rateLimitPerMinute);
  const resultsOut = new JsonlWriter(files.results);
  const scoresOut = new JsonlWriter(files.scores);

  let spent = 0;
  let budgetHit = false;
  const overBudget = () => exp.maxCostUsd !== null && spent >= exp.maxCostUsd;

  const scorerCtx: ScorerContext = { provider: opts.provider, throttle, cache: judgeCache };

  log(`Run ${exp.name}: ${variants.length} variants × ${tasks.length / variants.length / exp.repeats} items × ${exp.repeats} repeats = ${tasks.length} answers`);
  log(`Writing to ${dir}\n`);
  let done = 0;

  const runTask = async (t: Task): Promise<void> => {
    const base = { variant: t.variant.id, item: t.item.id, repeat: t.repeat, sourceCount: t.sources?.length ?? null };
    let result: Result;

    const hit = genCache?.get(t.key) as Omit<Result, 'variant' | 'item' | 'repeat' | 'cached' | 'sourceCount'> | undefined;
    if (hit) {
      result = { ...base, ...hit, cached: true };
    } else if (overBudget()) {
      budgetHit = true;
      result = { ...base, ...emptyResult('skipped', `budget of $${exp.maxCostUsd} reached`) };
    } else {
      try {
        await throttle(t.variant.model);
        const r = await opts.provider.generate({
          model: t.variant.model,
          ...(t.built.instructions !== undefined && { instructions: t.built.instructions }),
          prompt: t.built.prompt,
          params: t.variant.params,
        });
        const body = {
          status: statusOf(r.text, r.finishReason),
          answer: r.text,
          error: null,
          finishReason: r.finishReason,
          inputTokens: r.inputTokens,
          outputTokens: r.outputTokens,
          reasoningTokens: r.reasoningTokens,
          costUsd: r.costUsd,
          latencyMs: r.latencyMs,
        };
        spent += r.costUsd ?? 0;
        // Truncated and empty answers are cached too: they're what this config produces.
        await genCache?.set(t.key, body);
        result = { ...base, ...body, cached: false };
      } catch (err) {
        result = { ...base, ...emptyResult('error', err instanceof Error ? err.message : String(err)) };
      }
    }
    await resultsOut.append(result);

    // Score right away, so a stopped run still has scores for what it answered.
    const verdicts: string[] = [];
    for (const scorer of exp.scorers) {
      let s: Omit<Score, 'variant' | 'item' | 'repeat' | 'scorer'>;
      if (result.status !== 'ok' && result.status !== 'truncated') {
        s = { pass: null, reason: `no answer (${result.status})` };
      } else {
        try {
          s = await scorer.score({ item: t.item, result, sources: t.sources }, scorerCtx);
        } catch (err) {
          s = { pass: null, label: 'scorer-error', reason: err instanceof Error ? err.message : String(err) };
        }
      }
      if (s.costUsd && !s.details?.cached) spent += s.costUsd;
      await scoresOut.append({ variant: t.variant.id, item: t.item.id, repeat: t.repeat, scorer: scorer.name, ...s });
      if (scorer.name === exp.primary || scorer.kind === 'judge') verdicts.push(s.label ?? (s.pass === null ? '-' : s.pass ? 'pass' : 'fail'));
    }

    done++;
    const tag = result.cached ? ' (cached)' : '';
    const extra = result.error ? `  ${result.error.slice(0, 120)}` : '';
    log(`[${done}/${tasks.length}] ${t.variant.id}  ${t.item.id}${exp.repeats > 1 ? `#${t.repeat}` : ''}  ${result.status}  ${verdicts.join(' ')}${tag}${extra}`);
  };

  // Interleave variants so a stopped or budget-capped run covers every variant evenly.
  const order = [...tasks].sort((a, b) => a.repeat - b.repeat || a.item.id.localeCompare(b.item.id));
  await runPool(order.map((t) => () => runTask(t)), exp.concurrency);
  await resultsOut.flush();
  await scoresOut.flush();

  manifest.status = budgetHit ? 'stopped-budget' : 'complete';
  manifest.finishedAt = new Date().toISOString();
  manifest.spentUsd = +spent.toFixed(5);
  await writeManifest(dir, manifest);
  return { dir, manifest };
}

function emptyResult(status: 'error' | 'skipped', error: string) {
  return {
    status,
    answer: null,
    error,
    finishReason: null,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    costUsd: null,
    latencyMs: 0,
    cached: false,
  } as const;
}
