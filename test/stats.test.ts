import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mcnemarExact, paretoFrontier, percentile, wilson } from '../src/stats.js';

const close = (a: number, b: number, eps = 1e-4) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

test('wilson interval matches known values', () => {
  const half = wilson(5, 10);
  close(half.lo, 0.2366);
  close(half.hi, 0.7634);
  const zero = wilson(0, 10);
  assert.equal(zero.lo, 0);
  close(zero.hi, 0.2775);
  assert.deepEqual(wilson(0, 0), { p: 0, lo: 0, hi: 1 });
});

test('exact McNemar', () => {
  // doc-agent-rag hard-1 string check: 6 discordant items, all one way → p = 0.03
  close(mcnemarExact(0, 6), 0.03125);
  // "they differ on 1 question, p = 1.0"
  assert.equal(mcnemarExact(0, 1), 1);
  assert.equal(mcnemarExact(0, 0), 1);
  close(mcnemarExact(1, 9), 0.021484375);
  assert.equal(mcnemarExact(9, 1), mcnemarExact(1, 9));
  // large n doesn't underflow
  assert.ok(mcnemarExact(500, 600) > 0);
});

test('percentile interpolates', () => {
  assert.equal(percentile([4, 1, 3, 2], 50), 2.5);
  assert.equal(percentile([1, 2, 3, 4, 5], 100), 5);
  assert.ok(Number.isNaN(percentile([], 50)));
});

test('pareto frontier keeps non-dominated points', () => {
  const ids = paretoFrontier([
    { id: 'cheap', cost: 1, quality: 0.8 },
    { id: 'best', cost: 3, quality: 0.95 },
    { id: 'dominated', cost: 2, quality: 0.7 },
    { id: 'tie', cost: 3, quality: 0.95 },
  ]);
  assert.deepEqual(ids.sort(), ['best', 'cheap', 'tie']);
});
