import { supportsFact } from '../text.js';
import type { Scorer } from '../types.js';

// Citation parsing ported from doc-agent-rag (src/rag/citations.ts), so this counts the same
// citations its UI shows: [1], [2][4], [1, 3], [[2]][[3]], and code comments like "// [2]";
// not arr[0] or fn()[1].
const CITATION_RUN = /[ \t]*(?<![\w)])((?:\[\d+(?:\s*,\s*\d+)*])+)(?!\()/g;
const WRAPPED = /\[(\s*\[\d+(?:\s*,\s*\d+)*](?:\s*,?\s*\[\d+(?:\s*,\s*\d+)*])*\s*)]/g;
const CODE_COMMENT_CITATION = /(?:\/\/|\/\*)\s*((?:\[\d+(?:\s*,\s*\d+)*]\s*)+)(?:\*\/)?[ \t]*$/gm;

const unwrap = (text: string) => text.replace(WRAPPED, (_m, inner: string) => inner.trim().replace(/]\s*,?\s*\[/g, ']['));
const numbersIn = (run: string) => (run.match(/\d+/g) ?? []).map(Number);

function splitCode(md: string): { text: string; code: boolean }[] {
  const out: { text: string; code: boolean }[] = [];
  for (const [i, block] of md.split(/(```[\s\S]*?(?:```|$))/).entries()) {
    if (i % 2 === 1) {
      out.push({ text: block, code: true });
      continue;
    }
    for (const [j, piece] of block.split(/(`[^`\n]*`)/).entries()) out.push({ text: piece, code: j % 2 === 1 });
  }
  return out;
}

export function parseCitations(md: string): number[] {
  const nums = new Set<number>();
  for (const { text, code } of splitCode(md)) {
    const pattern = code ? CODE_COMMENT_CITATION : CITATION_RUN;
    for (const m of (code ? text : unwrap(text)).matchAll(pattern)) for (const n of numbersIn(m[1] ?? '')) nums.add(n);
  }
  return [...nums].sort((a, b) => a - b);
}

// For variants with context: does the answer cite sources, are the numbers valid, and does a cited
// source contain the item's evidence? pass = cites something and every citation exists.
export function citations(name = 'citations'): Scorer {
  return {
    name,
    kind: 'check',
    describe: () => ({ type: 'citations' }),
    async score({ item, result, sources }) {
      if (sources === null || !item.answerable) return { pass: null };
      const cited = parseCitations(result.answer ?? '');
      const invalid = cited.filter((n) => n < 1 || n > sources.length);
      const evidenceIn = (n: number) => item.evidence.some((f) => supportsFact(sources[n - 1]?.content ?? '', f));
      const hasEvidence = item.evidence.length > 0;
      const details = {
        cited,
        invalid,
        // Did the context contain the answer at all? (null = no evidence defined for the item)
        evidenceInSources: hasEvidence ? sources.some((_, i) => evidenceIn(i + 1)) : null,
        citesEvidence: hasEvidence ? cited.some((n) => evidenceIn(n)) : null,
      };
      const pass = cited.length > 0 && invalid.length === 0;
      const reason = !cited.length ? 'no citations' : invalid.length ? `invalid: ${invalid.join(', ')}` : undefined;
      return { pass, ...(reason && { reason }), details };
    },
  };
}
