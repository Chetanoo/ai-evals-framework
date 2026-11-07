import type { GenerationParams, PromptTemplate, Scorer, Variant } from './types.js';

// Same settings doc-agent-rag uses: deterministic, and room for reasoning plus the answer.
export const DEFAULT_PARAMS: GenerationParams = {
  temperature: 0,
  maxOutputTokens: 12000,
  reasoningMaxTokens: 4000,
};

export type Experiment = {
  name: string;
  description?: string;
  dataset: string; // path to a dataset JSON file
  contextsDir?: string; // directory with <context-name>.json files for this dataset
  variants: Variant[];
  scorers: Scorer[];
  // Scorer whose pass/fail is the headline accuracy. Default: the first judge, else the first scorer.
  primary: string;
  repeats: number;
  concurrency: number;
  // Requests per minute, per model (generation and judge models alike). 0 = unlimited.
  rateLimitPerMinute: number;
  maxCostUsd: number | null;
  // Rough average answer length, used only by --dry-run to estimate cost.
  estimatedOutputTokens: number;
};

export type ExperimentInput = Omit<
  Experiment,
  'primary' | 'repeats' | 'concurrency' | 'rateLimitPerMinute' | 'maxCostUsd' | 'estimatedOutputTokens'
> &
  Partial<Pick<Experiment, 'primary' | 'repeats' | 'concurrency' | 'rateLimitPerMinute' | 'maxCostUsd' | 'estimatedOutputTokens'>>;

export function defineExperiment(input: ExperimentInput): Experiment {
  if (input.variants.length === 0) throw new Error(`${input.name}: no variants`);
  if (input.scorers.length === 0) throw new Error(`${input.name}: no scorers`);

  const ids = input.variants.map((v) => v.id);
  const dup = ids.find((id, i) => ids.indexOf(id) !== i);
  if (dup) throw new Error(`${input.name}: duplicate variant id "${dup}"`);

  const names = input.scorers.map((s) => s.name);
  const dupScorer = names.find((n, i) => names.indexOf(n) !== i);
  if (dupScorer) throw new Error(`${input.name}: duplicate scorer name "${dupScorer}"`);

  if (input.variants.some((v) => v.context !== null) && !input.contextsDir) {
    throw new Error(`${input.name}: variants use context sets, so contextsDir is required`);
  }

  const primary = input.primary ?? input.scorers.find((s) => s.kind === 'judge')?.name ?? input.scorers[0]!.name;
  if (!names.includes(primary)) throw new Error(`${input.name}: primary scorer "${primary}" is not in scorers`);

  const repeats = input.repeats ?? 1;
  if (!Number.isInteger(repeats) || repeats < 1) throw new Error(`${input.name}: repeats must be a positive integer`);

  return {
    ...input,
    primary,
    repeats,
    concurrency: input.concurrency ?? 5,
    rateLimitPerMinute: input.rateLimitPerMinute ?? 0,
    maxCostUsd: input.maxCostUsd ?? null,
    estimatedOutputTokens: input.estimatedOutputTokens ?? 800,
  };
}

// Short display name for a model id: "mistralai/mistral-small-2603" → "mistral-small-2603".
export const modelAlias = (id: string) => id.slice(id.lastIndexOf('/') + 1);

export type MatrixInput = {
  // Model ids, or { alias: id } to choose the names shown in reports.
  models: string[] | Record<string, string>;
  prompts: PromptTemplate[];
  contexts?: (string | null)[]; // default: [null] (no context)
  params?: Partial<GenerationParams>;
};

// Every combination of model × prompt × context. The variant id names only the dimensions that
// vary ("qwen/v5" rather than "qwen/rag-v5/v5" when there's one prompt); reports show all three.
export function matrix({ models, prompts, contexts = [null], params = {} }: MatrixInput): Variant[] {
  const modelList = Array.isArray(models)
    ? models.map((id) => ({ alias: modelAlias(id), id }))
    : Object.entries(models).map(([alias, id]) => ({ alias, id }));
  if (!modelList.length || !prompts.length || !contexts.length) throw new Error('matrix: every dimension needs at least one value');

  const variants: Variant[] = [];
  for (const m of modelList)
    for (const p of prompts)
      for (const c of contexts) {
        const parts = [
          modelList.length > 1 ? m.alias : null,
          prompts.length > 1 ? p.name : null,
          contexts.length > 1 ? (c ?? 'none') : null,
        ].filter((x): x is string => x !== null);
        variants.push({
          id: parts.length ? parts.join('/') : m.alias,
          model: m.id,
          prompt: p,
          context: c,
          params: { ...DEFAULT_PARAMS, ...params },
        });
      }
  return variants;
}
