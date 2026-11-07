// The docs-agent case study: doc-agent-rag's question sets, with retrieval frozen by its
// scripts/export-contexts.ts (see contexts/docs-agent/). Three experiments, one per question:
//   ablation-<set>  what each retrieval step is worth (one model, every retrieval config)
//   models-hard-2   which model to serve (five models, the v5 pipeline)
//   prompts-<set>   what the v4 prompt change (source kinds) is worth
//
//   npm run eval -- run experiments/docs-agent.ts --experiment models-hard-2 --dry-run
import { defineExperiment, matrix, includes, excludes, citations, llmJudge } from '../src/index.js';
import { noContext, ragV3, ragV5 } from '../prompts/docs-agent.js';

export const MODELS = {
  qwen: 'qwen/qwen3.8-27b',
  mistral: 'mistralai/mistral-small-2603',
  'gpt-5.4-mini': 'openai/gpt-5.4-mini',
  'haiku-5.5': 'anthropic/claude-haiku-5.5',
  'gemini-3.5-flash-lite': 'google/gemini-3.5-flash-lite',
};

// Same judge as doc-agent-rag, so results are comparable with its README. It's a Gemini model,
// so it may favor gemini-3.5-flash-lite in models-hard-2; re-judge with another family to check:
//   npm run eval -- judge runs/models-hard-2 --model anthropic/claude-sonnet-5.5
const JUDGE = 'google/gemini-3.6-flash';

const SETS = ['original', 'hard-1', 'hard-2'] as const;
type Set = (typeof SETS)[number];

const scorers = () => [
  llmJudge({ model: JUDGE, domain: 'developer questions about the Vercel AI SDK, version 7' }),
  includes(),
  excludes('stale-mentions'),
  citations(),
];

const common = (set: Set) => ({
  dataset: `datasets/docs-agent/${set}.json`,
  contextsDir: `contexts/docs-agent/${set}`,
  scorers: scorers(),
  concurrency: 5,
  // New OpenRouter accounts get ~20 requests/minute per model. Set EVAL_RPM=0 once that limit is gone.
  rateLimitPerMinute: Number(process.env.EVAL_RPM ?? 18),
  maxCostUsd: 3,
  // doc-agent-rag v5 runs averaged 480-590 output tokens per answer (reasoning included).
  estimatedOutputTokens: 600,
});

const ablation = (set: Set) =>
  defineExperiment({
    name: `ablation-${set}`,
    description: 'Mistral Small with each retrieval config, from no retrieval to the full v5 pipeline.',
    ...common(set),
    variants: [
      ...matrix({ models: { mistral: MODELS.mistral }, prompts: [noContext] }).map((v) => ({ ...v, id: 'no-retrieval' })),
      ...matrix({
        models: { mistral: MODELS.mistral },
        prompts: [ragV5],
        contexts: ['hybrid-k5', 'no-rerank-k5', 'no-rerank-k8', 'rerank-k5', 'v5'],
      }),
    ],
  });

const models = (set: Set) =>
  defineExperiment({
    name: `models-${set}`,
    description: 'Five models on the same v5 retrieval and prompt: quality vs price vs speed.',
    ...common(set),
    variants: matrix({ models: MODELS, prompts: [ragV5], contexts: ['v5'] }),
  });

const prompts = (set: Set) =>
  defineExperiment({
    name: `prompts-${set}`,
    description: 'The v4 prompt change: sources labeled by kind, with a rule that guides and reference beat cookbook.',
    ...common(set),
    variants: matrix({ models: { mistral: MODELS.mistral, qwen: MODELS.qwen }, prompts: [ragV5, ragV3], contexts: ['v5'] }),
  });

export default [...SETS.map(ablation), models('hard-2'), ...SETS.map(prompts)];
