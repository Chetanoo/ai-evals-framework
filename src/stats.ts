// Small, dependency-free statistics for comparing eval runs.

export type Interval = { p: number; lo: number; hi: number };

// Wilson score interval for a proportion k/n (95% by default). Better than the normal approximation
// for small n and for rates near 0 or 1, which is where eval scores live.
export function wilson(k: number, n: number, z = 1.96): Interval {
  if (n === 0) return { p: 0, lo: 0, hi: 1 };
  const p = k / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { p, lo: Math.max(0, center - half), hi: Math.min(1, center + half) };
}

// Exact (binomial) McNemar test, two-sided. b = items only A got right, c = items only B got right.
// Pairs on the same items, so it's far more sensitive than comparing two accuracies independently.
export function mcnemarExact(b: number, c: number): number {
  const n = b + c;
  if (n === 0) return 1;
  const k = Math.min(b, c);
  // P(X <= k) for X ~ Binomial(n, 0.5), summed in log space so large n can't underflow.
  let logTerm = -n * Math.LN2; // log C(n,0) * 0.5^n
  let tail = Math.exp(logTerm);
  for (let i = 1; i <= k; i++) {
    logTerm += Math.log(n - i + 1) - Math.log(i);
    tail += Math.exp(logTerm);
  }
  return Math.min(1, 2 * tail);
}

// Linear-interpolated percentile (p in 0..100) of unsorted values. NaN for an empty list.
export function percentile(values: number[], p: number): number {
  if (!values.length) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const pos = ((sorted.length - 1) * p) / 100;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

// Points not dominated by another point that is at least as cheap and at least as accurate
// (and strictly better on one). Returns their ids.
export function paretoFrontier(points: { id: string; cost: number; quality: number }[]): string[] {
  return points
    .filter(
      (p) =>
        !points.some(
          (q) => q !== p && q.cost <= p.cost && q.quality >= p.quality && (q.cost < p.cost || q.quality > p.quality),
        ),
    )
    .map((p) => p.id);
}
