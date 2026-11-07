import { scoredItems } from './dataset.js';
import type { LoadedRun, VariantInfo } from './run.js';
import { mcnemarExact, paretoFrontier, percentile, wilson, type Interval } from './stats.js';
import type { Item, Result, Score } from './types.js';

export type CheckSummary = { pass: number; fail: number; na: number };

export type VariantSummary = {
  info: VariantInfo;
  answerable: { n: number; correct: number; lenient: number; accuracy: Interval; lenientRate: number; labels: Record<string, number> };
  unanswerable: { n: number; declined: number; labels: Record<string, number> };
  checks: Record<string, CheckSummary>;
  citations: { uncited: number; invalid: number; citesEvidence: [number, number]; evidenceInSources: [number, number] } | null;
  status: Record<Result['status'], number>;
  cost: { answersUsd: number; judgeUsd: number; perAnswerUsd: number; missing: number };
  latency: { p50: number; p95: number };
  tokens: { input: number; output: number; reasoning: number }; // averages per answer
  // Accuracy per repeat, and the share of answerable items with the same verdict in every repeat.
  repeats: { accuracy: number[]; agreement: number | null };
};

export type PairComparison = {
  a: string;
  b: string;
  onlyA: string[]; // items A got right and B didn't (per-item majority over repeats)
  onlyB: string[];
  both: number;
  neither: number;
  p: number;
};

export type RunSummary = {
  primary: string;
  primaryKind: 'judge' | 'check';
  items: { total: number; scored: number; excluded: { id: string; reason: string }[] };
  variants: VariantSummary[];
  pairs: PairComparison[];
  frontier: string[]; // variant ids on the accuracy/cost Pareto frontier
  tags: { tag: string; n: number; byVariant: Record<string, number> }[]; // primary pass rate per tag
};

const key = (variant: string, item: string, repeat: number) => `${variant}\0${item}\0${repeat}`;

// The scorer itself failed (e.g. the judge's output didn't parse), so the answer has no verdict.
const ungraded = (s: Score | undefined) => s?.label === 'scorer-error';

export function summarize(run: LoadedRun): RunSummary {
  const { manifest, dataset, results, scores } = run;
  const primary = manifest.primary;
  const primaryKind = (manifest.scorers.find((s) => s.name === primary)?.kind as 'judge' | 'check' | undefined) ?? 'check';
  const items = scoredItems(dataset.items);
  const itemIds = new Set(items.map((i) => i.id));
  const repeats = manifest.repeats;

  const scoreBy = new Map<string, Score>();
  for (const s of scores) scoreBy.set(`${key(s.variant, s.item, s.repeat)}\0${s.scorer}`, s);
  const getScore = (v: string, i: string, r: number, scorer: string) => scoreBy.get(`${key(v, i, r)}\0${scorer}`);

  const resultBy = new Map(results.map((r) => [key(r.variant, r.item, r.repeat), r]));
  const checkNames = manifest.scorers.filter((s) => s.name !== primary && s.type !== 'citations').map((s) => String(s.name));
  const citationScorer = manifest.scorers.find((s) => s.type === 'citations')?.name as string | undefined;
  const judgeNames = new Set(manifest.scorers.filter((s) => s.kind === 'judge').map((s) => String(s.name)));

  // Majority vote per item across repeats (ties count as a miss).
  const majority = new Map<string, Map<string, boolean>>();

  const variants: VariantSummary[] = manifest.variants.map((info) => {
    const v = info.id;
    const rows = results.filter((r) => r.variant === v && itemIds.has(r.item));
    const answerable = items.filter((i) => i.answerable);
    const unanswerable = items.filter((i) => !i.answerable);

    const tally = (list: Item[]) => {
      const labels: Record<string, number> = {};
      let n = 0;
      let pass = 0;
      let lenient = 0;
      for (const item of list)
        for (let r = 0; r < repeats; r++) {
          const s = getScore(v, item.id, r, primary);
          const label = s?.label ?? (s?.pass === null || !s ? (resultBy.get(key(v, item.id, r))?.status ?? 'missing') : s.pass ? 'pass' : 'fail');
          labels[label] = (labels[label] ?? 0) + 1;
          // A failed judgment says nothing about the answer: leave it out of the denominator.
          // (A missing or errored *answer* still counts as a miss.)
          if (ungraded(s)) continue;
          n++;
          if (s?.pass) pass++;
          if (s?.details?.lenient ?? s?.pass) lenient++;
        }
      return { n, pass, lenient, labels };
    };
    const a = tally(answerable);
    const u = tally(unanswerable);

    const checks: Record<string, CheckSummary> = {};
    for (const name of checkNames) {
      const c = { pass: 0, fail: 0, na: 0 };
      for (const r of rows) {
        const s = getScore(v, r.item, r.repeat, name);
        if (s?.pass === true) c.pass++;
        else if (s?.pass === false) c.fail++;
        else c.na++;
      }
      checks[name] = c;
    }

    let citations: VariantSummary['citations'] = null;
    if (citationScorer && info.context !== null) {
      const cs = rows.map((r) => getScore(v, r.item, r.repeat, citationScorer)).filter((s): s is Score => !!s?.details);
      const flag = (k: string) => {
        const vals = cs.map((s) => s.details![k]).filter((x): x is boolean => typeof x === 'boolean');
        return [vals.filter(Boolean).length, vals.length] as [number, number];
      };
      citations = {
        uncited: cs.filter((s) => (s.details!.cited as number[]).length === 0).length,
        invalid: cs.reduce((n, s) => n + (s.details!.invalid as number[]).length, 0),
        citesEvidence: flag('citesEvidence'),
        evidenceInSources: flag('evidenceInSources'),
      };
    }

    const status = { ok: 0, truncated: 0, empty: 0, error: 0, skipped: 0 } as Record<Result['status'], number>;
    for (const r of rows) status[r.status]++;

    const answered = rows.filter((r) => r.status !== 'error' && r.status !== 'skipped');
    const costs = answered.map((r) => r.costUsd);
    const answersUsd = costs.reduce<number>((s, c) => s + (c ?? 0), 0);
    const judgeUsd = scores
      .filter((s) => s.variant === v && judgeNames.has(s.scorer) && itemIds.has(s.item))
      .reduce((sum, s) => sum + (s.costUsd ?? 0), 0);
    const avg = (f: (r: Result) => number) => (answered.length ? answered.reduce((s, r) => s + f(r), 0) / answered.length : 0);

    const byRepeat = Array.from({ length: repeats }, (_, r) => {
      const passed = answerable.filter((i) => getScore(v, i.id, r, primary)?.pass).length;
      return answerable.length ? passed / answerable.length : 0;
    });
    let agreement: number | null = null;
    if (repeats > 1 && answerable.length) {
      const same = answerable.filter((i) => {
        const vals = Array.from({ length: repeats }, (_, r) => !!getScore(v, i.id, r, primary)?.pass);
        return vals.every((x) => x === vals[0]);
      }).length;
      agreement = same / answerable.length;
    }

    const m = new Map<string, boolean>();
    for (const i of answerable) {
      if (Array.from({ length: repeats }, (_, r) => getScore(v, i.id, r, primary)).some(ungraded)) continue;
      const passes = Array.from({ length: repeats }, (_, r) => !!getScore(v, i.id, r, primary)?.pass).filter(Boolean).length;
      m.set(i.id, passes * 2 > repeats);
    }
    majority.set(v, m);

    return {
      info,
      answerable: { n: a.n, correct: a.pass, lenient: a.lenient, accuracy: wilson(a.pass, a.n), lenientRate: a.n ? a.lenient / a.n : 0, labels: a.labels },
      unanswerable: { n: u.n, declined: u.pass, labels: u.labels },
      checks,
      citations,
      status,
      cost: {
        answersUsd: +answersUsd.toFixed(5),
        judgeUsd: +judgeUsd.toFixed(5),
        perAnswerUsd: answered.length ? answersUsd / answered.length : 0,
        missing: costs.filter((c) => c === null).length,
      },
      latency: {
        p50: percentile(answered.map((r) => r.latencyMs), 50),
        p95: percentile(answered.map((r) => r.latencyMs), 95),
      },
      tokens: { input: avg((r) => r.inputTokens), output: avg((r) => r.outputTokens), reasoning: avg((r) => r.reasoningTokens) },
      repeats: { accuracy: byRepeat, agreement },
    };
  });

  const pairs: PairComparison[] = [];
  for (let x = 0; x < variants.length; x++)
    for (let y = x + 1; y < variants.length; y++) {
      pairs.push(comparePaired(variants[x]!.info.id, majority.get(variants[x]!.info.id)!, variants[y]!.info.id, majority.get(variants[y]!.info.id)!));
    }

  const frontier = paretoFrontier(
    variants.map((s) => ({ id: s.info.id, cost: s.cost.perAnswerUsd, quality: s.answerable.accuracy.p })),
  );

  const allTags = [...new Set(items.flatMap((i) => i.tags))].sort();
  const tags = allTags.map((tag) => {
    const tagged = items.filter((i) => i.tags.includes(tag));
    const byVariant: Record<string, number> = {};
    for (const s of variants) {
      let pass = 0;
      for (const i of tagged) for (let r = 0; r < repeats; r++) if (getScore(s.info.id, i.id, r, primary)?.pass) pass++;
      byVariant[s.info.id] = pass / (tagged.length * repeats);
    }
    return { tag, n: tagged.length, byVariant };
  });

  return {
    primary,
    primaryKind,
    items: {
      total: dataset.items.length,
      scored: items.length,
      excluded: dataset.items.filter((i) => i.exclude !== undefined).map((i) => ({ id: i.id, reason: i.exclude! })),
    },
    variants,
    pairs,
    frontier,
    tags,
  };
}

// Paired comparison on the items both variants have. pass maps: item id → passed.
export function comparePaired(a: string, passA: Map<string, boolean>, b: string, passB: Map<string, boolean>): PairComparison {
  const onlyA: string[] = [];
  const onlyB: string[] = [];
  let both = 0;
  let neither = 0;
  for (const [id, pa] of passA) {
    const pb = passB.get(id);
    if (pb === undefined) continue;
    if (pa && pb) both++;
    else if (pa) onlyA.push(id);
    else if (pb) onlyB.push(id);
    else neither++;
  }
  return { a, b, onlyA, onlyB, both, neither, p: mcnemarExact(onlyA.length, onlyB.length) };
}

// Per-item majority pass for one variant of a run (answerable, scored items only). Used by `compare`.
export function majorityPass(run: LoadedRun, variant: string): Map<string, boolean> {
  const { manifest, dataset, scores } = run;
  const map = new Map<string, boolean>();
  for (const item of scoredItems(dataset.items).filter((i) => i.answerable)) {
    const s = scores.filter((x) => x.variant === variant && x.item === item.id && x.scorer === manifest.primary);
    if (!s.length || s.some(ungraded)) continue;
    map.set(item.id, s.filter((x) => x.pass).length * 2 > manifest.repeats);
  }
  return map;
}
