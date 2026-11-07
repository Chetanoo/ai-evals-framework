import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { ContextSetSchema, DatasetSchema, type ContextSet, type Dataset, type Item } from './types.js';

export async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path.resolve(file), 'utf8'));
  } catch (err) {
    throw new Error(`Can't read ${file}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function parseOrThrow<T>(schema: z.ZodType<T>, data: unknown, file: string): T {
  const parsed = schema.safeParse(data);
  if (!parsed.success) throw new Error(`${file} is not valid:\n${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

export async function loadDataset(file: string): Promise<Dataset> {
  const dataset = parseOrThrow(DatasetSchema, await readJson(file), file);
  const ids = dataset.items.map((i) => i.id);
  const dup = ids.find((id, i) => ids.indexOf(id) !== i);
  if (dup) throw new Error(`${file}: duplicate item id "${dup}"`);
  return dataset;
}

export async function loadContextSet(dir: string, name: string, dataset: Dataset): Promise<ContextSet> {
  const file = path.join(dir, `${name}.json`);
  let raw: unknown;
  try {
    raw = await readJson(file);
  } catch (err) {
    throw new Error(
      `${err instanceof Error ? err.message : String(err)}\n` +
        'Context sets are exported by the retrieval system (for doc-agent-rag: `npm run export-contexts` there).',
    );
  }
  const set = parseOrThrow(ContextSetSchema, raw, file);
  if (set.dataset !== dataset.name) {
    throw new Error(`${file} was exported for dataset "${set.dataset}", not "${dataset.name}"`);
  }
  const missing = dataset.items.filter((i) => !set.items[i.id]).map((i) => i.id);
  if (missing.length) {
    throw new Error(`${file} has no sources for ${missing.length} items (${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ', ...' : ''})`);
  }
  return set;
}

// Items that count toward metrics.
export const scoredItems = (items: Item[]) => items.filter((i) => i.exclude === undefined);

// ---------- doc-agent-rag importer ----------

// The question format in doc-agent-rag/evals/*.json.
const DocsAgentQuestion = z.object({
  id: z.string(),
  category: z.string().optional(),
  topic: z.string().optional(),
  difficulty_predicted: z.string().optional(),
  answerable: z.boolean(),
  question: z.string(),
  expected_answer: z.array(z.string()),
  must_include: z.array(z.string()).default([]),
  stale_signals: z.array(z.string()).default([]),
  evidence: z.array(z.array(z.string())).optional(),
  snapshot_gap: z.string().optional(),
  sources: z.array(z.object({ url: z.string(), section: z.string().optional() })).optional(),
});

const DocsAgentFile = z.object({
  meta: z.object({ name: z.string().optional(), notes: z.string().optional() }).passthrough().optional(),
  questions: z.array(DocsAgentQuestion).min(1),
});

export function fromDocsAgent(data: unknown, opts: { name: string; source: string }): Dataset {
  const file = parseOrThrow(DocsAgentFile, data, opts.source);
  const items: Item[] = file.questions.map((q) => ({
    id: q.id,
    input: q.question,
    reference: q.expected_answer,
    answerable: q.answerable,
    tags: [
      q.category && `category:${q.category}`,
      q.topic && `topic:${q.topic}`,
      q.difficulty_predicted && `difficulty:${q.difficulty_predicted}`,
      q.answerable ? null : 'unanswerable',
    ].filter((t): t is string => !!t),
    checks: { mustInclude: q.must_include, mustNotInclude: q.stale_signals },
    evidence: q.evidence ?? [],
    ...(q.snapshot_gap !== undefined && { exclude: `snapshot gap: ${q.snapshot_gap}` }),
    meta: q.sources ? { sources: q.sources } : {},
  }));
  return DatasetSchema.parse({
    name: opts.name,
    description: file.meta?.notes,
    source: opts.source,
    items,
  });
}
