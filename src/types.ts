import { z } from 'zod';

// ---------- Files on disk (validated with zod when loaded) ----------

// One question with its reference answer.
export const ItemSchema = z.object({
  id: z.string().min(1),
  input: z.string().min(1),
  // Key points a correct answer contains. The judge grades against these.
  reference: z.array(z.string()).default([]),
  // false = the answer isn't in the source material; the model should decline.
  answerable: z.boolean().default(true),
  tags: z.array(z.string()).default([]),
  checks: z
    .object({
      // Cheap string checks. "a|b" means either a or b.
      mustInclude: z.array(z.string()).default([]),
      // Things a correct answer should not recommend (e.g. outdated APIs). Also shown to the judge.
      mustNotInclude: z.array(z.string()).default([]),
    })
    .default({ mustInclude: [], mustNotInclude: [] }),
  // Facts needed to answer, for checking cited sources: each fact is a list of terms that must all
  // appear in one source ("a|b" = either).
  evidence: z.array(z.array(z.string())).default([]),
  // If set, the item is run and scored but left out of the metrics (the reason is shown in reports).
  exclude: z.string().optional(),
  meta: z.record(z.string(), z.unknown()).default({}),
});
export type Item = z.infer<typeof ItemSchema>;

export const DatasetSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  source: z.string().optional(),
  items: z.array(ItemSchema).min(1),
});
export type Dataset = z.infer<typeof DatasetSchema>;

// A retrieved passage given to the model as context.
export const SourceSchema = z.object({
  id: z.string(),
  title: z.string(),
  url: z.string().optional(),
  kind: z.string().optional(),
  content: z.string(),
});
export type Source = z.infer<typeof SourceSchema>;

// Frozen retrieval results for one dataset: item id → sources, in rank order.
export const ContextSetSchema = z.object({
  name: z.string().min(1),
  dataset: z.string().min(1),
  description: z.string().optional(),
  // The retrieval settings that produced it (free-form, recorded for reports).
  config: z.record(z.string(), z.unknown()).default({}),
  created: z.string().optional(),
  items: z.record(z.string(), z.array(SourceSchema)),
});
export type ContextSet = z.infer<typeof ContextSetSchema>;

// ---------- Experiment definition (TypeScript, see src/config.ts) ----------

export type BuiltPrompt = { instructions?: string; prompt: string };

export type PromptTemplate = {
  name: string;
  // sources is null when the variant has no context set.
  build: (item: Item, sources: Source[] | null) => BuiltPrompt;
};

export type GenerationParams = {
  temperature: number;
  maxOutputTokens: number;
  // Reasoning budget for reasoning models (ignored by the others). null = provider default.
  reasoningMaxTokens: number | null;
};

export type Variant = {
  id: string;
  model: string; // OpenRouter model id, e.g. "mistralai/mistral-small-2603"
  prompt: PromptTemplate;
  context: string | null; // context set name; null = no context
  params: GenerationParams;
};

// ---------- Provider ----------

export type GenerateRequest = {
  model: string;
  instructions?: string;
  prompt: string;
  params: GenerationParams;
  // Structured output: the provider returns `output` parsed with this schema.
  schema?: z.ZodType;
};

export type GenerateResponse = {
  text: string;
  output?: unknown;
  finishReason: string;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  costUsd: number | null;
  latencyMs: number;
};

export type Provider = {
  name: string;
  generate: (req: GenerateRequest) => Promise<GenerateResponse>;
};

// ---------- Run outputs (JSONL rows) ----------

export type ResultStatus = 'ok' | 'truncated' | 'empty' | 'error' | 'skipped';

export type Result = {
  variant: string;
  item: string;
  repeat: number;
  status: ResultStatus;
  answer: string | null;
  error: string | null;
  finishReason: string | null;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  costUsd: number | null;
  latencyMs: number;
  cached: boolean;
  // Number of sources the model was given (null = no context).
  sourceCount: number | null;
};

export type Score = {
  variant: string;
  item: string;
  repeat: number;
  scorer: string;
  // null = not applicable (e.g. no checks defined for this item, or the answer errored).
  pass: boolean | null;
  label?: string;
  reason?: string;
  costUsd?: number | null;
  details?: Record<string, unknown>;
};

// ---------- Scorers ----------

export type ScoreInput = {
  item: Item;
  result: Result;
  sources: Source[] | null;
};

export type ScorerContext = {
  provider: Provider;
  // Waits for a slot for `model` under the run's rate limit.
  throttle: (model: string) => Promise<void>;
  cache: { get: (key: string) => unknown; set: (key: string, value: unknown) => Promise<void> } | null;
};

export type Scorer = {
  name: string;
  // Judge scorers cost money and drive the headline accuracy; checks are free.
  kind: 'check' | 'judge';
  // Serializable description, recorded in the run manifest.
  describe: () => Record<string, unknown>;
  score: (input: ScoreInput, ctx: ScorerContext) => Promise<Omit<Score, 'variant' | 'item' | 'repeat' | 'scorer'>>;
};
