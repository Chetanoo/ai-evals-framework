// The whole pipeline (run → scores → summary → reports) with a fake provider: no network, no cost.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { defineExperiment, matrix } from '../src/config.js';
import { summarize } from '../src/metrics.js';
import { htmlReport } from '../src/report/html.js';
import { markdownReport } from '../src/report/text.js';
import { loadRun } from '../src/run.js';
import { runExperiment } from '../src/runner.js';
import { citations, includes, llmJudge } from '../src/scorers/index.js';
import type { GenerateRequest, Provider } from '../src/types.js';
import { withSources } from '../prompts/basic.js';

function fakeProvider(): Provider & { calls: GenerateRequest[] } {
  const calls: GenerateRequest[] = [];
  return {
    name: 'fake',
    calls,
    async generate(req) {
      calls.push(req);
      if (req.schema) {
        // Judge: answers from the "good" model are correct, the others wrong; unanswerable → declined.
        const verdict = req.prompt.includes('ANSWERABLE FROM THE SOURCE MATERIAL: no')
          ? 'declined'
          : req.prompt.includes('GOOD')
            ? 'correct'
            : 'wrong';
        return { text: '', output: { reason: `fake ${verdict}`, verdict }, finishReason: 'stop', inputTokens: 10, outputTokens: 5, reasoningTokens: 0, costUsd: 0.0001, latencyMs: 1 };
      }
      const good = req.model === 'x/good';
      const withContext = req.prompt.includes('<sources>');
      const text = `${good ? 'GOOD answer with alpha' : 'BAD answer'}${withContext ? ' [1]' : ''} </script><b>x</b>`;
      return { text, finishReason: 'stop', inputTokens: 100, outputTokens: 20, reasoningTokens: 0, costUsd: good ? 0.002 : 0.001, latencyMs: good ? 200 : 100 };
    },
  };
}

test('end to end with a fake provider', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'evals-'));
  const items: Record<string, unknown>[] = Array.from({ length: 8 }, (_, i) => ({
    id: `q${i}`,
    input: `Question ${i}?`,
    reference: ['alpha'],
    checks: { mustInclude: ['alpha'] },
    evidence: [['alpha']],
    tags: [i % 2 ? 'odd' : 'even'],
  }));
  items.push({ id: 'u1', input: 'Unknowable?', reference: ['not in the sources'], answerable: false, tags: ['unanswerable'] });
  await writeFile(path.join(root, 'ds.json'), JSON.stringify({ name: 'ds', items }));
  await mkdir(path.join(root, 'ctx'));
  await writeFile(
    path.join(root, 'ctx', 'k1.json'),
    JSON.stringify({ name: 'k1', dataset: 'ds', items: Object.fromEntries(items.map((i) => [i.id, [{ id: 's1', title: 'S', content: 'alpha is the answer' }]])) }),
  );

  const exp = defineExperiment({
    name: 'fake',
    dataset: path.join(root, 'ds.json'),
    contextsDir: path.join(root, 'ctx'),
    variants: matrix({ models: { good: 'x/good', bad: 'x/bad' }, prompts: [withSources()], contexts: [null, 'k1'] }),
    scorers: [llmJudge({ model: 'x/judge' }), includes(), citations()],
    repeats: 2,
  });

  const provider = fakeProvider();
  const opts = { provider, cache: true, outRoot: path.join(root, 'runs'), cacheDir: path.join(root, 'cache'), log: () => {} };
  const { dir, manifest } = await runExperiment(exp, opts);
  assert.equal(manifest.status, 'complete');
  // 4 variants × 9 items × 2 repeats. The fake answers the same text in both repeats, and an
  // identical answer is judged once (the judge cache), so 36 judge calls.
  assert.equal(provider.calls.filter((c) => !c.schema).length, 72);
  assert.equal(provider.calls.filter((c) => c.schema).length, 36);

  const run = await loadRun(dir);
  const s = summarize(run);
  const good = s.variants.find((v) => v.info.id === 'good/k1')!;
  const bad = s.variants.find((v) => v.info.id === 'bad/k1')!;
  assert.equal(good.answerable.correct, 16);
  assert.equal(good.answerable.n, 16);
  assert.equal(bad.answerable.correct, 0);
  assert.equal(good.unanswerable.declined, 2);
  assert.equal(good.checks.includes!.pass, 16);
  assert.deepEqual(good.citations?.citesEvidence, [16, 16]);
  assert.equal(s.variants.find((v) => v.info.id === 'good/none')!.citations, null);
  assert.equal(good.repeats.agreement, 1);
  const pair = s.pairs.find((p) => p.a === 'good/none' && p.b === 'bad/none')!;
  assert.equal(pair.onlyA.length, 8);
  assert.ok(pair.p < 0.01);
  assert.ok(s.frontier.includes('bad/none') && s.frontier.includes('good/none'));
  assert.ok(markdownReport(run, s).includes('## Paired comparisons'));

  // Answers containing "</script>" must not break out of the embedded JSON.
  const html = htmlReport(run, s);
  const json = html.slice(html.indexOf('<script id="data"'), html.indexOf('</script>', html.indexOf('<script id="data"')));
  assert.ok(json.includes('\\u003c/script>'));
  await writeFile(path.join(dir, 'report.html'), html);

  // Second run: everything comes from the cache, nothing is paid for.
  const before = provider.calls.length;
  const again = await runExperiment(exp, opts);
  assert.equal(provider.calls.length, before);
  assert.equal(again.manifest.spentUsd, 0);
});

test('budget cap stops new paid calls', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'evals-'));
  const items = Array.from({ length: 20 }, (_, i) => ({ id: `q${i}`, input: `Q${i}`, reference: ['alpha'] }));
  await writeFile(path.join(root, 'ds.json'), JSON.stringify({ name: 'ds', items }));
  const exp = defineExperiment({
    name: 'budget',
    dataset: path.join(root, 'ds.json'),
    variants: matrix({ models: ['x/good'], prompts: [withSources()] }),
    scorers: [includes()],
    concurrency: 1,
    maxCostUsd: 0.005,
  });
  const provider = fakeProvider();
  const { dir, manifest } = await runExperiment(exp, { provider, cache: false, outRoot: path.join(root, 'runs'), log: () => {} });
  assert.equal(manifest.status, 'stopped-budget');
  assert.equal(provider.calls.length, 3); // $0.002 each: stops once $0.005 is reached
  const run = await loadRun(dir);
  assert.equal(run.results.filter((r) => r.status === 'skipped').length, 17);
});
