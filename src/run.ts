import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DatasetSchema, type Dataset, type GenerationParams, type Result, type Score } from './types.js';
import { readJsonl } from './store.js';

// A run directory: runs/<experiment>/<timestamp>/
//   run.json        manifest (this type)
//   dataset.json    copy of the dataset, so the run is self-contained
//   results.jsonl   one row per (variant, item, repeat), appended as answers arrive
//   scores.jsonl    one row per (variant, item, repeat, scorer)
//   report.md / report.html

export type VariantInfo = {
  id: string;
  model: string;
  prompt: string;
  context: string | null;
  params: GenerationParams;
  instructions: string | null; // the prompt template's instructions, as built for the first item
  contextConfig: Record<string, unknown> | null;
};

export type Manifest = {
  experiment: string;
  description?: string;
  dataset: { file: string; name: string; items: number; hash: string };
  contextsDir: string | null;
  variants: VariantInfo[];
  scorers: Record<string, unknown>[];
  primary: string;
  repeats: number;
  filters: { items: string[] | null; variants: string[] | null };
  status: 'running' | 'complete' | 'stopped-budget';
  startedAt: string;
  finishedAt: string | null;
  // Money actually spent by this run (cache hits are free).
  spentUsd: number;
  rejudged?: { at: string; scorer: string; model: string }[];
};

export type LoadedRun = {
  dir: string;
  manifest: Manifest;
  dataset: Dataset;
  results: Result[];
  scores: Score[];
};

export const runFiles = (dir: string) => ({
  manifest: path.join(dir, 'run.json'),
  dataset: path.join(dir, 'dataset.json'),
  results: path.join(dir, 'results.jsonl'),
  scores: path.join(dir, 'scores.jsonl'),
  reportMd: path.join(dir, 'report.md'),
  reportHtml: path.join(dir, 'report.html'),
});

export async function writeManifest(dir: string, manifest: Manifest) {
  await writeFile(runFiles(dir).manifest, JSON.stringify(manifest, null, 2));
}

export async function loadRun(dir: string): Promise<LoadedRun> {
  const files = runFiles(dir);
  let manifest: Manifest;
  try {
    manifest = JSON.parse(await readFile(files.manifest, 'utf8')) as Manifest;
  } catch {
    throw new Error(`${dir} is not a run directory (no readable run.json)`);
  }
  const dataset = DatasetSchema.parse(JSON.parse(await readFile(files.dataset, 'utf8')));
  // A row can be written twice (e.g. a re-judge appends); the last one wins.
  const results = dedupe(await readJsonl<Result>(files.results), (r) => `${r.variant}\0${r.item}\0${r.repeat}`);
  const scores = dedupe(await readJsonl<Score>(files.scores), (s) => `${s.variant}\0${s.item}\0${s.repeat}\0${s.scorer}`);
  return { dir, manifest, dataset, results, scores };
}

function dedupe<T>(rows: T[], key: (row: T) => string): T[] {
  const map = new Map<string, T>();
  for (const row of rows) map.set(key(row), row);
  return [...map.values()];
}
