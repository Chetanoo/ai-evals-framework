import { z } from 'zod';
import { hashOf } from '../store.js';
import type { Item, Scorer } from '../types.js';

// Generalized from doc-agent-rag's scripts/judge.ts. The key rule: the judge must not grade from its
// own knowledge, which may be as outdated as the models it grades. It grades only against the reference.
export function defaultRubric(domain: string): string {
  return `You grade answers to ${domain}.
Your own knowledge of this subject may be outdated or wrong. Do NOT rely on it to decide what is correct.
Grade ONLY against the reference provided with each question.

For answerable questions, pick exactly one verdict:
- "correct": the answer's main recommendation matches the reference key points. Minor omissions are fine.
- "acceptable": the answer does not use the reference approach, but gives a generic, valid solution
  that does not depend on anything the reference contradicts.
- "outdated": the answer relies on things listed as outdated, or on names the reference says were renamed,
  deprecated or removed.
- "wrong": the answer contradicts the reference, or its core solution relies on functions, options,
  facts or behavior that the reference contradicts or that appear to be invented.
  An answer that says the information isn't available is also "wrong", even if it is honest about it.
  If the answer covers the main recommendation and only says a secondary detail is missing,
  grade the part it answered.

For unanswerable questions (the source material does not contain the answer), pick exactly one verdict:
- "declined": the answer says it doesn't know or can't find it. Pointing to where to look is fine.
  Mentioning general, uncontroversial context is fine.
- "hallucinated": the answer states specific facts as true (dates, numbers, names, plans)
  that the reference does not support.

Keep the reason to one or two sentences and name the specific claim that decided the verdict.`;
}

export type JudgeOptions = {
  model: string;
  name?: string;
  // Fills the default rubric: "You grade answers to <domain>."
  domain?: string;
  // Replaces the default rubric entirely. Keep the labels below in sync with it.
  rubric?: string;
  labels?: {
    answerable: string[];
    unanswerable: string[];
    pass: string[]; // answerable verdicts that count as correct (headline accuracy)
    lenient: string[]; // answerable verdicts that count as correct-or-acceptable
    declinePass: string[]; // unanswerable verdicts that count as a pass
  };
  reasoningMaxTokens?: number;
};

const DEFAULT_LABELS = {
  answerable: ['correct', 'acceptable', 'outdated', 'wrong'],
  unanswerable: ['declined', 'hallucinated'],
  pass: ['correct'],
  lenient: ['correct', 'acceptable'],
  declinePass: ['declined'],
};

export function judgePrompt(item: Item, answer: string): string {
  return [
    `QUESTION:\n${item.input}`,
    `ANSWERABLE FROM THE SOURCE MATERIAL: ${item.answerable ? 'yes' : 'no'}`,
    item.reference.length ? `REFERENCE:\n${item.reference.map((p) => `- ${p}`).join('\n')}` : '',
    item.checks.mustNotInclude.length
      ? `OUTDATED (recommending these means "outdated"):\n${item.checks.mustNotInclude.map((s) => `- ${s}`).join('\n')}`
      : '',
    `ANSWER TO GRADE:\n"""\n${answer}\n"""`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

type Cached = { label: string; reason: string; costUsd: number | null };

export function llmJudge(opts: JudgeOptions): Scorer {
  const name = opts.name ?? 'judge';
  const rubric = opts.rubric ?? defaultRubric(opts.domain ?? 'questions');
  const labels = opts.labels ?? DEFAULT_LABELS;
  const params = { temperature: 0, maxOutputTokens: 4000, reasoningMaxTokens: opts.reasoningMaxTokens ?? 2000 };

  return {
    name,
    kind: 'judge',
    describe: () => ({ type: 'llm-judge', model: opts.model, rubric, labels }),
    async score({ item, result }, ctx) {
      const prompt = judgePrompt(item, result.answer ?? '');
      const allowed = item.answerable ? labels.answerable : labels.unanswerable;
      const key = hashOf({ model: opts.model, rubric, prompt, allowed, params });

      let verdict = ctx.cache?.get(key) as Cached | undefined;
      const cached = !!verdict;
      if (!verdict) {
        const schema = z.object({
          reason: z.string().describe('One or two sentences naming the claim that decided the verdict'),
          verdict: z.enum(allowed as [string, ...string[]]),
        });
        // One retry when the judge's output doesn't parse (seen once in ~2,500 Gemini calls).
        // HTTP-level retries are the provider's job; this covers a malformed structured answer.
        let attempt = 0;
        for (;;) {
          try {
            await ctx.throttle(opts.model);
            const r = await ctx.provider.generate({ model: opts.model, instructions: rubric, prompt, params, schema });
            const out = schema.parse(r.output);
            verdict = { label: out.verdict, reason: out.reason, costUsd: r.costUsd };
            break;
          } catch (err) {
            if (++attempt >= 2) throw err;
          }
        }
        await ctx.cache?.set(key, verdict);
      }

      const pass = item.answerable ? labels.pass.includes(verdict.label) : labels.declinePass.includes(verdict.label);
      return {
        pass,
        label: verdict.label,
        reason: verdict.reason,
        costUsd: verdict.costUsd,
        details: { cached, lenient: item.answerable ? labels.lenient.includes(verdict.label) : pass },
      };
    },
  };
}
