// Smoke test: two cheap models on six general questions. A full run costs well under a cent.
//   npm run eval -- run experiments/example.ts
import { defineExperiment, matrix, includes, llmJudge } from '../src/index.js';
import { plain } from '../prompts/basic.js';

export default defineExperiment({
  name: 'example',
  dataset: 'datasets/example.json',
  variants: matrix({
    models: ['mistralai/mistral-small-2603', 'anthropic/claude-haiku-5.5'],
    prompts: [plain('Answer concisely. If you cannot know the answer, say so.')],
    params: { maxOutputTokens: 2000, reasoningMaxTokens: null },
  }),
  scorers: [llmJudge({ model: 'google/gemini-3.6-flash', domain: 'general knowledge and programming questions' }), includes()],
  estimatedOutputTokens: 200,
  maxCostUsd: 0.2,
});
