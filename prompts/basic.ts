// Generic templates for any dataset.
import type { PromptTemplate } from '../src/types.js';

// Just the question, with an optional system instruction.
export function plain(instructions?: string, name = 'plain'): PromptTemplate {
  return { name, build: (item) => ({ ...(instructions !== undefined && { instructions }), prompt: item.input }) };
}

// Numbered sources, then the question; asks for [n] citations.
export function withSources(name = 'with-sources'): PromptTemplate {
  return {
    name,
    build(item, sources) {
      if (sources === null) return { prompt: item.input };
      const blocks = sources.map((s, i) => `<source id="${i + 1}" title="${s.title.replace(/"/g, '')}">\n${s.content}\n</source>`).join('\n\n');
      return {
        instructions:
          "Answer using only the numbered sources. Cite them inline as [1], [2]. If the sources don't contain the answer, say so instead of guessing.",
        prompt: `<sources>\n${blocks}\n</sources>\n\nQuestion: ${item.input}`,
      };
    },
  };
}
