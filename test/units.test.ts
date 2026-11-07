import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defineExperiment, matrix } from '../src/config.js';
import { fromDocsAgent, loadDataset } from '../src/dataset.js';
import { parseCitations } from '../src/scorers/citations.js';
import { includes } from '../src/scorers/checks.js';
import { hashOf } from '../src/store.js';
import { matchesTerm, supportsFact } from '../src/text.js';
import { plain } from '../prompts/basic.js';

test('matrix names only the dimensions that vary', () => {
  const p1 = plain(undefined, 'p1');
  const p2 = plain(undefined, 'p2');
  assert.deepEqual(matrix({ models: ['a/x', 'b/y'], prompts: [p1] }).map((v) => v.id), ['x', 'y']);
  assert.deepEqual(
    matrix({ models: { m: 'a/x' }, prompts: [p1, p2], contexts: [null, 'v5'] }).map((v) => v.id),
    ['p1/none', 'p1/v5', 'p2/none', 'p2/v5'],
  );
  assert.equal(matrix({ models: ['a/x'], prompts: [p1] })[0]!.id, 'x');
});

test('defineExperiment validates', () => {
  const variants = matrix({ models: ['a/x'], prompts: [plain()] });
  assert.throws(() => defineExperiment({ name: 'e', dataset: 'd', variants: [...variants, ...variants], scorers: [includes()] }), /duplicate variant/);
  assert.throws(
    () => defineExperiment({ name: 'e', dataset: 'd', variants: matrix({ models: ['a/x'], prompts: [plain()], contexts: ['v5'] }), scorers: [includes()] }),
    /contextsDir/,
  );
  const e = defineExperiment({ name: 'e', dataset: 'd', variants, scorers: [includes()] });
  assert.equal(e.primary, 'includes');
  assert.equal(e.repeats, 1);
});

test('"a|b" terms and facts', () => {
  assert.ok(matchesTerm('use onEnd here', 'onFinish|onEnd'));
  assert.ok(!matchesTerm('use onFinish', 'onEnd'));
  assert.ok(supportsFact('isStepCount(5) stops', ['isStepCount', 'stops|ends']));
  assert.ok(!supportsFact('isStepCount', ['isStepCount', 'stops']));
});

test('citations: same rules as doc-agent-rag', () => {
  assert.deepEqual(parseCitations('Use instructions [1]. Also [2][4] and [1, 3].'), [1, 2, 3, 4]);
  assert.deepEqual(parseCitations('Wrapped [[2]][[3]].'), [2, 3]);
  assert.deepEqual(parseCitations('```ts\nconst a = arr[0];\nsave(); // [5]\n```'), [5]);
  assert.deepEqual(parseCitations('Inline `x[1]` and fn()[2] are not citations.'), []);
});

test('cache keys ignore key order but not values', () => {
  assert.equal(hashOf({ a: 1, b: { c: 2, d: 3 } }), hashOf({ b: { d: 3, c: 2 }, a: 1 }));
  assert.notEqual(hashOf({ a: 1, repeat: 0 }), hashOf({ a: 1, repeat: 1 }));
});

test('imported docs-agent datasets have the expected items', async () => {
  for (const [name, total, unanswerable, excluded] of [
    ['original', 35, 6, 0],
    ['hard-1', 75, 3, 0],
    ['hard-2', 93, 5, 1],
  ] as const) {
    const d = await loadDataset(`datasets/docs-agent/${name}.json`);
    assert.equal(d.items.length, total, name);
    assert.equal(d.items.filter((i) => !i.answerable).length, unanswerable, name);
    assert.equal(d.items.filter((i) => i.exclude).length, excluded, name);
  }
});

test('docs-agent importer maps fields', () => {
  const d = fromDocsAgent(
    {
      questions: [
        {
          id: 'q1',
          category: 'api',
          answerable: true,
          question: 'How?',
          expected_answer: ['Use x'],
          must_include: ['x'],
          stale_signals: ['old'],
          evidence: [['x']],
          snapshot_gap: 'later',
        },
      ],
    },
    { name: 't', source: 'test' },
  );
  const item = d.items[0]!;
  assert.equal(item.input, 'How?');
  assert.deepEqual(item.checks, { mustInclude: ['x'], mustNotInclude: ['old'] });
  assert.deepEqual(item.tags, ['category:api']);
  assert.match(item.exclude!, /later/);
});
