import { readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import type { Experiment } from './config.js';
import { fromDocsAgent, readJson } from './dataset.js';
import { comparePaired, majorityPass, summarize } from './metrics.js';
import { openRouterProvider } from './providers/openrouter.js';
import { rejudge } from './rejudge.js';
import { htmlReport } from './report/html.js';
import { markdownReport, pValue, pct, printSummary, usd } from './report/text.js';
import { loadRun, runFiles, type LoadedRun } from './run.js';
import { estimateRun, runExperiment } from './runner.js';

const HELP = `Usage: npm run eval -- <command> [options]
(In PowerShell, quote the separator: npm run eval '--' run ...)

  run <experiment.ts>          Run an experiment, then write report.md and report.html
      --dry-run                  Check model ids and estimate cost; no paid calls
      --experiment <name>        Only this experiment, if the file exports several
      --items <id,id>            Only these items
      --variants <id,id>         Only these variants
      --no-cache                 Ignore cached answers and judgments (new samples, full cost)

  report <run-dir>             Rebuild the console summary, report.md and report.html
  judge <run-dir> --model <id> Re-grade a run's answers with another judge model
      --scorer <name>            Which judge scorer to replace (default: the first)
      --no-cache
  compare <run-a> [<run-b>]    Paired comparison (McNemar) and the items that changed
      --a <variant> --b <variant>  Variants to compare (default: same ids in both runs)
  import-docs-agent <file> --name <name> --out <file>
                               Convert a doc-agent-rag question file into a dataset

A <run-dir> can also be an experiment's folder (runs/<experiment>): its latest run is used.`;

async function resolveRunDir(dir: string): Promise<string> {
  const abs = path.resolve(dir);
  try {
    await stat(runFiles(abs).manifest);
    return abs;
  } catch {
    const subdirs = (await readdir(abs, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name).sort();
    for (const d of subdirs.reverse()) {
      try {
        await stat(runFiles(path.join(abs, d)).manifest);
        return path.join(abs, d);
      } catch {
        /* not a run */
      }
    }
    throw new Error(`No run found in ${dir}`);
  }
}

async function loadExperiments(file: string, only?: string): Promise<Experiment[]> {
  const mod = (await import(pathToFileURL(path.resolve(file)).href)) as { default?: Experiment | Experiment[] };
  if (!mod.default) throw new Error(`${file} has no default export (export default defineExperiment(...))`);
  const list = Array.isArray(mod.default) ? mod.default : [mod.default];
  if (!only) return list;
  const picked = list.filter((e) => e.name === only);
  if (!picked.length) throw new Error(`No experiment "${only}" in ${file}. Found: ${list.map((e) => e.name).join(', ')}`);
  return picked;
}

const csv = (s: string | undefined) => (s ? s.split(',').map((x) => x.trim()).filter(Boolean) : undefined);

async function writeReports(run: LoadedRun) {
  const summary = summarize(run);
  printSummary(run, summary);
  const files = runFiles(run.dir);
  await writeFile(files.reportMd, markdownReport(run, summary));
  await writeFile(files.reportHtml, htmlReport(run, summary));
  console.log(`\nReports: ${files.reportMd}\n         ${files.reportHtml}`);
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      'dry-run': { type: 'boolean' },
      'no-cache': { type: 'boolean' },
      experiment: { type: 'string' },
      items: { type: 'string' },
      variants: { type: 'string' },
      model: { type: 'string' },
      scorer: { type: 'string' },
      a: { type: 'string' },
      b: { type: 'string' },
      name: { type: 'string' },
      out: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const [command, ...args] = positionals;
  if (!command || values.help) {
    console.log(HELP);
    return;
  }
  const cache = !values['no-cache'];

  switch (command) {
    case 'run': {
      if (!args[0]) throw new Error('run needs an experiment file');
      const filters = { items: csv(values.items), variants: csv(values.variants), cache };
      for (const exp of await loadExperiments(args[0], values.experiment)) {
        let estimate;
        try {
          estimate = await estimateRun(exp, filters);
        } catch (err) {
          if (values['dry-run']) throw err;
          console.warn(`Cost estimate unavailable: ${err instanceof Error ? err.message : String(err)}`);
        }
        if (estimate) {
          console.log(`\n${exp.name}: ${estimate.tasks} answers, ${estimate.cached} cached. Estimated cost of the rest:`);
          console.table(estimate.rows);
          console.log(`Total ≈ ${usd(estimate.totalUsd)} (rough: ~4 characters per token, ${exp.estimatedOutputTokens} output tokens per answer)`);
          if (exp.maxCostUsd !== null && estimate.totalUsd > exp.maxCostUsd) {
            console.warn(`The estimate is over maxCostUsd ($${exp.maxCostUsd}); the run will stop when that is spent.`);
          }
        }
        if (values['dry-run']) continue;
        const { dir } = await runExperiment(exp, { provider: openRouterProvider(), ...filters });
        await writeReports(await loadRun(dir));
      }
      return;
    }

    case 'report': {
      if (!args[0]) throw new Error('report needs a run directory');
      await writeReports(await loadRun(await resolveRunDir(args[0])));
      return;
    }

    case 'judge': {
      if (!args[0] || !values.model) throw new Error('judge needs a run directory and --model <id>');
      const run = await loadRun(await resolveRunDir(args[0]));
      await rejudge(run, {
        provider: openRouterProvider(),
        model: values.model,
        ...(values.scorer !== undefined && { scorer: values.scorer }),
        cache,
      });
      await writeReports(await loadRun(run.dir));
      return;
    }

    case 'compare': {
      if (!args[0]) throw new Error('compare needs one or two run directories');
      const runA = await loadRun(await resolveRunDir(args[0]));
      const runB = args[1] ? await loadRun(await resolveRunDir(args[1])) : runA;
      let pairs: [string, string][];
      if (values.a || values.b) {
        if (!values.a || !values.b) throw new Error('pass both --a and --b');
        pairs = [[values.a, values.b]];
      } else if (runA === runB) {
        throw new Error('comparing within one run needs --a <variant> --b <variant>');
      } else {
        const idsB = new Set(runB.manifest.variants.map((v) => v.id));
        pairs = runA.manifest.variants.filter((v) => idsB.has(v.id)).map((v) => [v.id, v.id]);
        if (!pairs.length && runA.manifest.variants.length === 1 && runB.manifest.variants.length === 1) {
          pairs = [[runA.manifest.variants[0]!.id, runB.manifest.variants[0]!.id]];
        }
        if (!pairs.length) throw new Error('No variant ids in common; pass --a and --b');
      }
      if (runA !== runB && runA.manifest.dataset.hash !== runB.manifest.dataset.hash) {
        console.warn('Warning: the two runs used different versions of the dataset; only shared items are compared.');
      }
      const verdict = (run: LoadedRun, v: string, item: string) =>
        run.scores
          .filter((s) => s.variant === v && s.item === item && s.scorer === run.manifest.primary)
          .map((s) => s.label ?? String(s.pass))
          .join('/');
      for (const [a, b] of pairs) {
        for (const [run, v] of [[runA, a], [runB, b]] as const) {
          if (!run.manifest.variants.some((x) => x.id === v)) throw new Error(`No variant "${v}" in ${run.dir}`);
        }
        const pa = majorityPass(runA, a);
        const pb = majorityPass(runB, b);
        const c = comparePaired(a, pa, b, pb);
        const n = c.both + c.neither + c.onlyA.length + c.onlyB.length;
        const accA = (c.both + c.onlyA.length) / n;
        const accB = (c.both + c.onlyB.length) / n;
        console.log(`\nA = ${a}${args[1] ? ` (${path.basename(runA.dir)})` : ''}   B = ${b}${args[1] ? ` (${path.basename(runB.dir)})` : ''}`);
        console.log(`${n} shared answerable items: A ${pct(accA)}, B ${pct(accB)}; only A right: ${c.onlyA.length}, only B right: ${c.onlyB.length}; exact McNemar p = ${pValue(c.p)}`);
        for (const id of c.onlyA) console.log(`  only A  ${id}: A ${verdict(runA, a, id)}, B ${verdict(runB, b, id)}`);
        for (const id of c.onlyB) console.log(`  only B  ${id}: A ${verdict(runA, a, id)}, B ${verdict(runB, b, id)}`);
      }
      return;
    }

    case 'import-docs-agent': {
      if (!args[0] || !values.name || !values.out) throw new Error('import-docs-agent needs <file> --name <name> --out <file>');
      const dataset = fromDocsAgent(await readJson(args[0]), { name: values.name, source: args[0].replaceAll('\\', '/') });
      await writeFile(values.out, JSON.stringify(dataset, null, 2) + '\n');
      const unanswerable = dataset.items.filter((i) => !i.answerable).length;
      console.log(`${values.out}: ${dataset.items.length} items (${dataset.items.length - unanswerable} answerable, ${unanswerable} unanswerable)`);
      return;
    }

    default:
      console.log(HELP);
      process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
