import { matchesTerm } from '../text.js';
import type { Scorer } from '../types.js';

// Passes if the answer contains every item.checks.mustInclude term ("a|b" = either).
// Cheap, but it fails correct paraphrases: use it as a signal next to the judge, not instead of it.
export function includes(name = 'includes'): Scorer {
  return {
    name,
    kind: 'check',
    describe: () => ({ type: 'includes' }),
    async score({ item, result }) {
      const terms = item.checks.mustInclude;
      if (!terms.length || !item.answerable) return { pass: null };
      const missing = terms.filter((t) => !matchesTerm(result.answer ?? '', t));
      return missing.length ? { pass: false, reason: `missing: ${missing.join(', ')}`, details: { missing } } : { pass: true };
    },
  };
}

// Passes if the answer mentions none of item.checks.mustNotInclude. It can't tell a recommendation
// from "X is deprecated", so it over-flags; the judge decides whether a mention is really outdated.
export function excludes(name = 'excludes'): Scorer {
  return {
    name,
    kind: 'check',
    describe: () => ({ type: 'excludes' }),
    async score({ item, result }) {
      const terms = item.checks.mustNotInclude;
      if (!terms.length) return { pass: null };
      const hits = terms.filter((t) => matchesTerm(result.answer ?? '', t));
      return hits.length ? { pass: false, reason: `mentions: ${hits.join(', ')}`, details: { hits } } : { pass: true };
    },
  };
}
