// Prompt templates from doc-agent-rag, copied verbatim so this framework measures what the bot serves.
//   ragV5      src/rag/prompt.ts (v4+): numbered sources labeled by kind, with a rule on which kind wins
//   ragV3      the same prompt before v4 (commit bb6360a): no kind labels, no kind rule
//   noContext  scripts/run-baseline.ts: the model alone, no sources
import type { PromptTemplate, Source } from '../src/types.js';

const KIND_RULE =
  '- Each source has a kind: guide, reference, cookbook, migration-guide or troubleshooting. Guides and reference pages describe the current API; cookbook examples can lag behind it. When sources disagree, follow the guide or reference, and say briefly that another source shows an older approach.\n';

const ragInstructions = (withKinds: boolean) => `You are a documentation assistant for the Vercel AI SDK (the "ai" npm package), version 7.
Answer the developer's question using ONLY the numbered sources provided. They are excerpts from the current v7 docs.

Rules:
- Your own knowledge of this SDK is probably outdated: many APIs were renamed or removed in v6 and v7. When the sources and your memory disagree, follow the sources.
- Cite the sources that support each claim inline by number, e.g. [1] or [2][4], right after the claim.
- Code examples may only use APIs, options and imports that appear in the sources.
- Migration guide excerpts show old code in blocks titled "Before". Never recommend that code.
${withKinds ? KIND_RULE : ''}- If the sources don't contain the answer, say you couldn't find it in the docs. Don't guess and don't fill gaps from memory. If they answer only part of the question, answer that part and say what's missing.

Answer concisely, with a short TypeScript example when useful.`;

// Some page titles keep YAML quotes ("React error \"...\""), which would break the attribute.
const attr = (s: string) => s.replace(/\\"/g, "'").replace(/"/g, '');

function formatSources(sources: Source[], withKinds: boolean): string {
  return sources
    .map((s, i) => {
      const kind = withKinds ? ` kind="${s.kind ?? 'unknown'}"` : '';
      return `<source id="${i + 1}"${kind} section="${attr(s.title)}" url="${attr(s.url ?? '')}">\n${s.content}\n</source>`;
    })
    .join('\n\n');
}

function rag(name: string, withKinds: boolean): PromptTemplate {
  const instructions = ragInstructions(withKinds);
  return {
    name,
    build(item, sources) {
      if (sources === null) throw new Error(`prompt ${name} needs a context set`);
      return { instructions, prompt: `<sources>\n${formatSources(sources, withKinds)}\n</sources>\n\nQuestion: ${item.input}` };
    },
  };
}

export const ragV5 = rag('rag-v5', true);
export const ragV3 = rag('rag-v3', false);

export const noContext: PromptTemplate = {
  name: 'no-context',
  build: (item) => ({
    instructions: `You are an expert on the Vercel AI SDK (the "ai" npm package), latest version.
Answer the developer's question concisely, with a short TypeScript example when useful.
If you are not sure or don't have the information, say so instead of guessing.`,
    prompt: item.input,
  }),
};
