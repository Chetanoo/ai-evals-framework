# ai-eval-framework

A mini framework for LLM evals. It takes a set of questions with reference answers, runs them through a matrix of **models × prompts × retrieved contexts**, and compares the variants on **quality, cost and speed**, with confidence intervals and paired significance tests, so a difference of two questions isn't mistaken for an improvement.

Its first case study is [doc-agent-rag](../doc-agent-rag), a docs bot for the Vercel AI SDK. It answers ~97% of 203 questions correctly but its three question sets are close to saturated, so the comparisons that are still open are of configurations: *what is each retrieval step worth, which model should it serve, and did the prompt change matter?* Those are the experiments below.

## What it does

```
Dataset ──► Variants (model × prompt × context × params) ──► Runner ──► Scorers ──► Reports
                                                               │
                                                     cache · rate limit · budget cap
```

- **Any OpenRouter model** through one API key. The real cost of every call comes from OpenRouter's usage metadata, not from a price table.
- **Frozen contexts.** Retrieval results are exported once into files (`contexts/`). Every variant gets exactly the same sources, runs need no database, and a run is reproducible months later.
- **Scorers:** an LLM judge with a configurable rubric (it grades only against the reference, never from its own knowledge), plus free checks: required terms, outdated terms, citation validity, and whether a cited source actually contains the answer.
- **Statistics:** accuracy with a 95% Wilson interval, exact McNemar tests for every pair of variants on the same items, the accuracy/cost Pareto frontier, p50/p95 latency, agreement across repeats.
- **Cheap to iterate:** answers and verdicts are cached by content hash, so re-running an experiment or adding a variant only pays for what's new. `--dry-run` checks every model id against OpenRouter and estimates the cost before any paid call; `maxCostUsd` stops a run when its budget is spent.
- **Reports:** a console table, `report.md`, and a self-contained `report.html` with an accuracy-vs-cost chart, latency bars, and a filterable grid of every answer with the judge's reason.

## Quick start

Requirements: Node 22+ and an [OpenRouter](https://openrouter.ai) API key.

```bash
cp .env.example .env     # then put your OpenRouter key in .env
npm install
npm test                 # unit tests + an end-to-end run with a fake provider (free)
npm run eval -- run experiments/example.ts --dry-run    # check model ids, estimate cost
npm run eval -- run experiments/example.ts              # six questions, two models: under $0.03
```

In PowerShell, quote the separator: `npm run eval '--' run experiments/example.ts`.

## Concepts

**Dataset** (`datasets/*.json`): items with an `input`, `reference` key points, and optional `answerable: false` (the model should decline), `tags`, `checks.mustInclude` / `checks.mustNotInclude` (`"a|b"` = either), `evidence` (facts a supporting source must contain), and `exclude` (scored but left out of metrics, with a reason).

**Context set** (`contexts/<dataset>/<name>.json`): item id → the sources retrieval returned, in rank order, plus the retrieval config that produced them.

**Prompt template** (`prompts/*.ts`): `(item, sources) => { instructions, prompt }`.

**Experiment** (`experiments/*.ts`):

```ts
import { defineExperiment, matrix, llmJudge, includes, citations } from '../src/index.js';
import { ragV5, noContext } from '../prompts/docs-agent.js';

export default defineExperiment({
  name: 'my-experiment',
  dataset: 'datasets/docs-agent/hard-2.json',
  contextsDir: 'contexts/docs-agent/hard-2',
  variants: matrix({
    models: { qwen: 'qwen/qwen3.8-27b', mistral: 'mistralai/mistral-small-2603' },
    prompts: [ragV5],
    contexts: ['v5', 'no-rerank-k8'],
  }),
  scorers: [llmJudge({ model: 'google/gemini-3.6-flash', domain: 'questions about the Vercel AI SDK 7' }), includes(), citations()],
  repeats: 1,
  maxCostUsd: 2,
});
```

The headline metric is the first judge scorer (or `primary`). A file can export an array of experiments; pick one with `--experiment <name>`.

## CLI

| Command | What it does |
|---|---|
| `run <experiment.ts>` | Runs, then writes `report.md` and `report.html`. `--dry-run`, `--experiment`, `--items a,b`, `--variants x,y`, `--no-cache` |
| `report <run-dir>` | Rebuilds the reports from a run's files |
| `judge <run-dir> --model <id>` | Re-grades every answer with another judge model (same rubric) |
| `compare <run-a> [<run-b>] [--a <variant> --b <variant>]` | Paired McNemar test and the items that changed verdict, within a run or across runs |
| `import-docs-agent <file> --name <n> --out <file>` | Converts a doc-agent-rag question file into a dataset |

A `<run-dir>` can be an experiment folder (`runs/models-hard-2`): its latest run is used. Each run directory holds `run.json` (manifest: variants, prompt instructions, retrieval config, scorers), a copy of the dataset, and `results.jsonl` / `scores.jsonl`, appended while the run goes, so a stopped run keeps what it finished.

## The docs-agent case study

The three doc-agent-rag question sets are imported as `datasets/docs-agent/{original,hard-1,hard-2}.json` (35 + 75 + 93 items). The prompts in `prompts/docs-agent.ts` are copied verbatim from the bot, including the pre-v4 version without source kinds.

**Step 1, in doc-agent-rag** (database up, `OPENROUTER_API_KEY` in the environment or `.env`): freeze retrieval for every question under five configs.

```bash
npm run export-contexts
```

| Context | Retrieval |
|---|---|
| `v5` | vector top 30 → Cohere rerank → best 8 (what the bot serves) |
| `rerank-k5` | same, best 5 |
| `no-rerank-k8` | vector top 8 (v3) |
| `no-rerank-k5` | vector top 5 |
| `hybrid-k5` | equal-weight vector + full-text (RRF), top 5 (v2) |

Plus `no-retrieval`: the model alone. The export prints evidence recall per config and warns if the reranker fell back to vector order for any question. Cost: about $0.05.

**Step 2, here:** see the estimate, then run. The key is read from the environment first, then `.env`; the dry run needs no key.

```bash
npm run eval -- run experiments/docs-agent.ts --dry-run
npm run eval -- run experiments/docs-agent.ts
```

| Experiment | Variants | Question it answers |
|---|---|---|
| `ablation-{original,hard-1,hard-2}` | Mistral Small × 6 retrieval configs | What is each pipeline step worth? |
| `models-hard-2` | Qwen 3.8 27B, Mistral Small, GPT-5.4 mini, Claude Haiku 5.5, Gemini 3.5 Flash-Lite, all on `v5` | Which model is the best trade-off of quality, price and speed? |
| `prompts-{original,hard-1,hard-2}` | Mistral, Qwen × prompt v5 / v3 | Did labeling sources by kind (v4) matter beyond the one question it fixed? |

All eight runs cost $4.11 together and took about two hours; experiments share cached answers where variants coincide (for example Mistral + v5 appears in all three). New OpenRouter accounts are limited to about 20 requests per minute per model, so runs are throttled to 18; set `EVAL_RPM=0` once that limit no longer applies.

### Results: models on hard-2

Same v5 retrieval and prompt for every model; 87 answerable questions + 5 unanswerable, `tel-07` excluded. Run cost $1.36 (answers $0.95, judge $0.40), 26 minutes at 18 requests/minute.

| Model | Correct | 95% CI | $/answer | p50 / p95 latency |
|---|---|---|---|---|
| Qwen 3.8 27B | **86/87** | 94–100% | $0.0016 | 4.7 / 12.9 s |
| GPT-5.4 mini | 85/87 | 92–99% | $0.0044 | 3.6 / 6.5 s |
| Mistral Small | 83/87 | 89–98% | **$0.0008** | 3.3 / 5.7 s |
| Claude Haiku 5.5 | 83/87 | 89–98% | $0.0009 | 4.2 / 6.5 s |
| Gemini 3.5 Flash-Lite | 82/87 | 87–98% | $0.0026 | **2.7 / 4.0 s** |

All five declined all 5 unanswerable questions, and none hallucinated.

What it shows:

- **No model is significantly better than another.** The largest gap, Qwen vs Gemini Flash-Lite, is 4 items to 0 (McNemar p = 0.125). The intervals all overlap. hard-2 can't tell these models apart; it would take a harder or larger set.
- **Price is what separates them.** Mistral and Qwen are the Pareto frontier. GPT-5.4 mini is within one item of Qwen at 2.7× the price. Gemini Flash-Lite costs 3× Mistral and scores lowest, though it is the fastest.
- **Haiku 5.5 uses ~50% more input tokens for the same prompt** (5,244 vs ~3,400 average: a different tokenizer), but its lower price still lands it next to Mistral.
- **One miss is retrieval's, not the models'.** All five fail `anc-01` (response bodies are opt-in via `include` in v7): no retrieved chunk mentions `responseBody` under any retrieval config, and every model answered faithfully from what it got. Qwen's 86/87 is the ceiling this context allows.
- **The other misses had the answer in context.** `ui-02` (three models recommend `useChat`'s removed `input` / `handleSubmit`) is the most common. Haiku's misses lean to over-caution: on `code-01` and `out-02` it said the sources don't cover something they do.
- **No sign the Gemini judge favors Gemini:** the Gemini candidate came last.
- **The frozen pipeline reproduces the live one.** Mistral scores 83/87, as in doc-agent-rag's own hard-2 run; Qwen scores 86/87 vs 84/87 there. The two runs differ in retrieval (re-exported) and sampling, and a 2-item gap on one run isn't significant.

### Results: what each pipeline step is worth

Mistral Small with the same prompt; only the retrieved context changes. Correct answers on answerable questions:

| Context | original (29) | hard-1 (72) | hard-2 (87) | avg input tokens (hard-2) |
|---|---|---|---|---|
| no retrieval | 2 (7%) | 13 (18%) | 14 (16%) | 99 |
| hybrid top 5 (v2) | 23 (79%) | 54 (75%) | 71 (82%) | 3,055 |
| vector top 5 | 25 (86%) | 62 (86%) | 75 (86%) | 2,016 |
| vector top 8 (v3) | 28 (97%) | 66 (92%) | 76 (87%) | 3,072 |
| reranked, best 5 | **29 (100%)** | 69 (96%) | 81 (93%) | 2,242 |
| reranked, best 8 (v5, live) | 28 (97%) | **70 (97%)** | **83 (95%)** | 3,374 |

The three sets have different items, so the paired counts can be pooled (188 answerable questions):

| Comparison | Only the first right | Only the second right | p |
|---|---|---|---|
| vector top 8 (v3) vs v5 | 3 | 14 | **0.013** |
| vector top 5 vs reranked best 5 | 5 | 22 | **0.002** |
| reranked best 5 vs v5 | 1 | 3 | 0.63 |

What it shows:

- **Retrieval is nearly everything.** Alone, Mistral gets 7–18% right and invents an answer for 8 of the 14 unanswerable questions. With any retrieval it hallucinates none.
- **Reranking is the step that pays off.** v3 → v5 is not significant on any single set, but pooled it is: 14 items gained, 3 lost (p = 0.013). At five chunks the gain is larger (22 vs 5, p = 0.002).
- **Cutting to 5 reranked chunks is not a free cost cut.** It looked tied on the first two sets, but hard-2 adds 2 more items for v5 (pooled 3 vs 1, not significant). It saves a third of the input tokens, about $0.0002 per answer with Mistral: too little to give up even a likely 1–2%.
- **Hybrid search (v2) is the weakest retrieval on all three sets**, below plain vector top 5. Yet it has the answer in context about as often (77 vs 74 of 88 on hard-2) and feeds 50% more tokens: its full-text matches seem to add long chunks that distract more than they help.

### Results: did the v4 prompt change matter?

v4 added a `kind` attribute to each source (guide, reference, cookbook, migration-guide, troubleshooting) and a rule: when sources disagree, follow the guide or reference, since cookbook examples can lag behind the API. Same model, same v5 context, prompt with vs without it:

| | original | hard-1 | hard-2 | pooled: only v5 / only v3 right |
|---|---|---|---|---|
| Mistral, v5 prompt / v3 prompt | 28 / 28 | 70 / 71 | 83 / 82 | 2 / 2, p = 1.0 |
| Qwen, v5 prompt / v3 prompt | 29 / 28 | 71 / 70 | 86 / 85 | 3 / 0, p = 0.25 |

**No measurable effect beyond the one question it was made for.** Qwen is one item better on every set, which is suggestive but not significant; Mistral is a wash. The change costs ~100 input tokens per answer, so it's worth keeping, but it was not the step that moved accuracy: retrieval was.

One judge call in ~2,500 returned output that didn't parse (Mistral + v3 prompt, `ui-14` on hard-2). Such a judgment is now retried once, and if it still fails it is reported as ungraded and left out of the accuracy and paired tests rather than counted as a miss. Re-running the experiment re-judged just that answer for $0.0007 (`correct`); everything else came from the cache.

### Takeaways for doc-agent-rag

1. **Keep v5 retrieval.** Reranking is the one step with a significant pooled gain over v3, and serving 5 chunks instead of 8 doesn't save enough to justify the likely small loss.
2. **Mistral Small is the right default model.** It ties every other model statistically and is the cheapest. Qwen is the most accurate (86/87) at twice the price, and the better choice if 3 more correct answers per 87 are worth it.
3. **The remaining misses are mostly retrieval and docs, not models.** `anc-01` has no chunk with the answer under any config, and `ui-02` (the removed `useChat` input helpers) trips three models with the evidence in context: that's a docs or prompt fix.
4. **hard-2 is saturated for model comparison.** Every model scores 94–99%. A harder set, or more repeats, is needed to tell them apart.

### Checked against doc-agent-rag

`scripts/docs-agent-run.ts import` converts a frozen doc-agent run (answers + verdicts) into a run directory, for free. On `rag-v5-hard2-run1` the framework reproduces doc-agent's published numbers: Qwen 84/87, Mistral 83/87, 5/5 unanswerable declined, `tel-07` excluded as a snapshot gap; the paired test gives p = 1.0 (2 vs 1 discordant items).

To check that this framework's judge agrees with doc-agent's, re-grade an imported run (~$0.06) and compare:

```bash
npx tsx scripts/docs-agent-run.ts import ../doc-agent-rag/evals/baselines/rag-v5-run1.json --dataset datasets/docs-agent/original.json --name rag-v5-original
npm run eval -- judge runs/docs-agent-import/rag-v5-original --model google/gemini-3.6-flash
npx tsx scripts/docs-agent-run.ts agreement runs/docs-agent-import/rag-v5-original
```

## Design notes

- **The judge is from doc-agent-rag, generalized.** Its rubric (correct / acceptable / outdated / wrong; declined / hallucinated) and the rule "grade only against the reference" were tuned there over five iterations. The default judge is Gemini 3.6 Flash for continuity with those results. That makes it the same family as one candidate in `models-hard-2`; re-judge with another family (`judge --model anthropic/...`) before trusting a Gemini win.
- **String checks are signals, not the metric.** On doc-agent's hard-1 set a required-terms check called Mistral significantly worse than Qwen (p = 0.03) while the judge found them tied. Checks are reported next to the judge, never instead of it.
- **Cost means the cost of the configuration.** A cached answer reports what it cost when it was generated, so the cost columns compare variants fairly; `spent` in the manifest is what the run actually paid.
- **Identical answers are judged once.** The judge cache key is the answer text, so with `temperature: 0` repeats that produce the same text don't pay the judge twice. Use `--no-cache` for fresh samples of both.
- **Majority vote for paired tests.** With repeats, McNemar compares each item's majority verdict; the per-repeat accuracies and their agreement are reported separately.

## Limitations

- OpenRouter is the only provider. Others plug in through the `Provider` interface (`src/types.ts`), as the test suite's fake provider does.
- Single-turn questions only; no tool use or multi-turn conversations.
- The Wilson interval treats repeats as independent samples, which overstates confidence when repeats agree; use the per-item majority (McNemar) for decisions.
- Retrieval itself isn't evaluated here: context sets are inputs. doc-agent-rag's own `eval:retrieval` measures it, and the export prints evidence recall per config.

## Project structure

```
src/                 types, config, dataset loading, runner, metrics, stats, CLI
src/providers/       OpenRouter provider and model price list
src/scorers/         llm judge, includes/excludes, citations
src/report/          console + Markdown, HTML
prompts/             prompt templates (docs-agent copies, generic ones)
experiments/         docs-agent.ts, example.ts
datasets/ contexts/  question sets and frozen retrieval results
scripts/             doc-agent-rag run import and judge agreement
test/                node:test unit and end-to-end tests
runs/                outputs (gitignored)
```
