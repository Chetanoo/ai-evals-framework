// "a|b" matches if either a or b appears in the text (case-sensitive, like identifiers).
export const matchesTerm = (text: string, term: string) => term.split('|').some((alt) => text.includes(alt));

// A fact is a list of terms that must all appear in the same text.
export const supportsFact = (text: string, fact: string[]) => fact.every((term) => matchesTerm(text, term));

// Stable JSON for hashing: object keys sorted at every level.
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}
