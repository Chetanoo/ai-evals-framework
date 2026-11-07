import { generateText, Output } from 'ai';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import type { GenerateRequest, GenerateResponse, Provider } from '../types.js';

// One OpenRouter key reaches every model, and its usage metadata reports the real cost of each call.
export function openRouterProvider(apiKey = process.env.OPENROUTER_API_KEY): Provider {
  if (!apiKey) throw new Error('OPENROUTER_API_KEY is not set (set it in the environment or in .env).');
  const openrouter = createOpenRouter({ apiKey });

  return {
    name: 'openrouter',
    async generate(req: GenerateRequest): Promise<GenerateResponse> {
      const start = performance.now();
      const result = await generateText({
        model: openrouter(req.model, { usage: { include: true } }),
        ...(req.instructions !== undefined && { instructions: req.instructions }),
        prompt: req.prompt,
        temperature: req.params.temperature,
        maxOutputTokens: req.params.maxOutputTokens,
        // The SDK retries 429s and 5xx with exponential backoff.
        maxRetries: 3,
        ...(req.params.reasoningMaxTokens !== null && {
          // Ignored by models that don't reason.
          providerOptions: { openrouter: { reasoning: { max_tokens: req.params.reasoningMaxTokens } } },
        }),
        ...(req.schema && { output: Output.object({ schema: req.schema }) }),
      });

      const meta = result.finalStep.providerMetadata as { openrouter?: { usage?: { cost?: number } } } | undefined;
      return {
        text: result.text,
        ...(req.schema && { output: result.output }),
        finishReason: result.finalStep.finishReason,
        inputTokens: result.usage.inputTokens ?? 0,
        outputTokens: result.usage.outputTokens ?? 0,
        reasoningTokens: result.usage.outputTokenDetails?.reasoningTokens ?? 0,
        costUsd: meta?.openrouter?.usage?.cost ?? null,
        latencyMs: Math.round(performance.now() - start),
      };
    },
  };
}

// ---------- Model list and prices (public endpoint, no key needed) ----------

export type ModelInfo = { id: string; inputPerToken: number; outputPerToken: number; contextLength: number };

export async function fetchModels(): Promise<Map<string, ModelInfo>> {
  const res = await fetch('https://openrouter.ai/api/v1/models');
  if (!res.ok) throw new Error(`OpenRouter /models returned ${res.status}`);
  const body = (await res.json()) as {
    data: { id: string; context_length: number; pricing: { prompt: string; completion: string } }[];
  };
  return new Map(
    body.data.map((m) => [
      m.id,
      { id: m.id, inputPerToken: +m.pricing.prompt, outputPerToken: +m.pricing.completion, contextLength: m.context_length },
    ]),
  );
}
