# Evaluation system (user perspective)

For an engineer about to use an LLM gateway/relay API, the questions that really matter, in priority order, are: **can I trust it → is it cheap → is it stable**.
Each question maps to an evaluation dimension and a set of collectable metrics. Everything automatable comes from the public probe script
(`probe/probe.mjs`); what can't be automated (policy-class) uses "manual annotation + evidence links" and accepts PR corrections.
All raw data is committed in `data/results/`.

## Dimension 1: Trust & integrity — "can I trust it?"

This is the core anxiety that sets a relay apart from the official API, broken into three verifiable sub-items:

| Sub-item | Metric | Collection method |
|---|---|---|
| Channel origin | Direct official upstream (official routing) vs reverse/account-pool/multi-layer resale | **Diff verification** (see below) + the gateway's public claims + evidence links |
| Data retention | Whether the prompt body is logged, the retention period, whether used for training | Manual annotation of privacy policy/ToS, with link to original text and annotation date |
| Legal-entity qualifications | Whether the operating entity is public, whether invoices are available, exit-risk signals | Manual annotation + evidence links |

**Diff verification (hard evidence of channel origin)**: following the [K2 Vendor Verifier](https://github.com/MoonshotAI/K2-Vendor-Verifier)
method — a fixed request set (including tool calls, long context, and sampling-parameter-sensitive cases) is fired at both the gateway and the official API simultaneously,
comparing tool-call validity rate, tokenizer behavior, output distribution, and latency signature. Those that consistently pass the diff are marked
`direct-connection verified`; those that fail or refuse testing are marked `unverified` — no presumption of guilt, but a clear distinction.

> Ratings have only three tiers: `verified` / `claimed but unverified` / `unverified`. Anything missing an evidence link never gets `verified`.

> **Further reading on fidelity/quantization detection:** beyond K2-Vendor-Verifier's tool-call-F1 approach, see [DiFR — Inference Verification Despite Nondeterminism](https://arxiv.org/abs/2511.20621) (verifying a provider actually runs the claimed model, robust to sampling nondeterminism) and the [rank-based uniformity test](https://arxiv.org/abs/2506.06975) for detecting silent quantization / model substitution behind a black-box API (with the honest caveat that detection is weak for 8-bit variants). These are the statistical backing for the diff-verification stance above.

**Data-retention/training rating** (the `good`/`warn`/`bad`/`unknown` four tiers of the `data retention` sub-item; per-gateway annotations in the `promptRetention`, `training` fields of `data/annotations/*.json`):

| Tier | Criteria | Examples |
|---|---|---|
| `good` | Has a **formal public policy** (privacy policy/ToS/official docs) with favorable terms: not used for training by default, not retained by default or only short-term for troubleshooting | OpenAI, Together, Groq, SiliconFlow (both items good) |
| `warn` | Has a formal policy but with terms needing caution (trained by default with only opt-out, data stored in a specific jurisdiction, broad retention scope or no explicit period), **or** only a marketing-style self-claim without formal policy docs / not independently verified | DeepSeek, Moonshot (trained by default + in-territory); OpenRouter, AiHubMix (retention only warn, training good); Synthorai (self-claim, no docs) |
| `bad` | Policy explicitly states user content is used for training with no opt-out, or publicly admits resale/leakage | (none currently) |
| `unknown` | Verified but the policy is **silent** on this sub-item (with the source noted), or not yet annotated (`to be annotated`, `evidence:null`) | OhMyGPT training item |

Two iron rules: (1) anything lacking formal policy docs and having only a homepage slogan is **at most `warn`**, never `good`; (2) **related parties are judged strictly** and don't get a higher tier for the relationship (see the conflict-of-interest disclosure in the `synthorai` annotation).

## Dimension 2: Price — "is it cheap? where does it stand vs others?"

| Metric | Collection method |
|---|---|
| List price $/1M tokens (input/output) | The gateway's public price API or pricing page; official price from the litellm open price library |
| Price index | Per-model multiplier = (input price ratio + output price ratio) ÷ 2 (arithmetic mean); then geometric mean across all comparable models (<1 cheap, >1 pricey). Asymmetric pricing like input-discount/output-markup gets averaged out, so also read the two raw columns of the price matrix |
| Billing transparency | Whether there's a public price API, whether cache price is distinguished, whether there are hidden multipliers (manual annotation) |

## Dimension 3: Stability — "has it been stable recently?"

| Metric | Collection method |
|---|---|
| Success rate (uptime%) | Request success rate from the every-6-hours probe, aggregated by day, 7/30-day rolling |
| Error breakdown | Distribution of failed requests: 429 rate-limit vs 5xx outage vs timeout (completely different in nature, read separately) |
| Latency drift | The over-time curve of TTFT p50, identifying "slows down at peak" |
| Time-of-day profile | TTFT/success rate aggregated by UTC hour; peak drift = slowest-hour ÷ fastest-hour TTFT (≥2× goes red). Directly addresses the "peak-hour throttling/freezing" pain point; GH Actions every 6h cron → about 4 slots per day, filling out across days |
| Network reachability | Connection latency from each probe region to the gateway (GH Actions starts in the US; CN/Hong Kong probes on the roadmap) |

> **Fairness rule (user-side error exclusion)**: errors caused by the probe itself don't count as failures — those are probe/config
> problems, not gateway outages. Two classes are excluded: (1) auth 401/403 (key not authorized, whitelist restriction);
> (2) other 4xx (400/404/422…: the gateway doesn't have this model, the parameter is unsupported, the probe was used wrong).
> Both are removed from the uptime denominator per error per sample, and disclosed separately on the stability panel. **429 rate-limit is not excluded**
> — it's a real availability signal (capacity/rate-limiting). The convention aligns with OpenRouter uptime (excludes user-side 4xx).
> Implementation in `probe/aggregate.mjs:classifyError` and `rollupGateway`.
>
> Success-rate statistics are strictly capped to a 30-day window (the 7-day rolling value is given alongside); history outside the window
> lives only in the `data/results/` raw data and doesn't affect leaderboard numbers.

> This is where the long-term value of accumulated data lies: the longer it runs, the more convincing the curve, and a new site can't fake it.

## Supporting dimension 4: Speed — "is it fast?"

| Metric | Definition |
|---|---|
| TTFT | The time from a streaming request's start to the first content token, reported as p50/p95. **p95 is given only when a single probe has ≥5 successful samples** (default 3 samples/model, where p95≈max is statistically meaningless → shows "—", never fabricated) |
| Throughput tok/s | Decode throughput = tokens generated **after the first token** ÷ decode time **after the first token**, i.e. `(completion_tokens − 1) ÷ (total − ttft)`. Aligns with the llmperf / Artificial Analysis convention ("after the first token"): it doesn't count the first token in the numerator while subtracting its time from the denominator — otherwise it would systematically overestimate, and the slower the model the larger the inflation |
| Non-streaming latency | The p50 of full-request time for the tool-call probe (non-streaming) |

The methodology follows the llmperf community convention: a small prompt (with a random request id to defeat gateway-side caching), a capped max_tokens,
multi-sampling for percentiles in a single probe, concurrency ≤4 to avoid becoming a load test. The detection prompts are public in the script.

> Speed conventions align with [Artificial Analysis's provider-performance methodology](https://artificialanalysis.ai/methodology/intelligence-benchmarking) (TTFT, output tokens/sec and price-per-token measured across live APIs); for audited serving-system benchmarks at the hardware layer see [MLPerf Inference](https://mlcommons.org/benchmarks/inference-datacenter/) (MLCommons).

## Capability probing: tool calls and billing transparency

| Metric | Definition | Why measure it |
|---|---|---|
| Tool calls | Send a request with a public tool definition; does the model return a valid JSON call for that tool | Reverse/resale channels commonly drop the tools field — a hard signal of channel quality |
| Usage report rate | Whether the streaming response carries usage.completion_tokens | A gateway without usage can't have its billing reconciled, and throughput can only be estimated from chunk counts |
| Streaming authenticity | Behavioral fingerprint for fake streaming: the first token takes long (ttft ≥800ms and ≥4× the window) + all content dumped within a ≤250ms window (≥5 chunks required to judge) | Buffer-then-dump "fake streaming" makes TTFT effectively equal to the full latency, a common relay disguise; fast-but-real streaming (small ttft) and slow-but-real streaming (large window) don't get misfired |

> Channel origin is hard to directly "prove"; this benchmark's stance is a **combination of behavioral fingerprints**: whether tool calls get stripped,
> whether streaming is real, whether usage is reported, whether the latency signature matches the official — multiple black-box-measurable signals
> jointly form a channel-quality profile, without relying on the gateway's self-declaration.

## Probe regions

| Probe | Frequency | Viewpoint |
|---|---|---|
| GitHub Actions (gh-us) | Every 6 hours | Overseas public-internet baseline |
| Local recorder (local-*, see README) | Every 10 minutes | High-frequency time series + the user's real network (e.g. CN direct-connection feel) |

Data from different regions each carry a region label and coexist in `data/results/`, shown distinctly during aggregation.

## Supporting dimension 5: Catalog — "does it have the model I need?"

| Metric | Collection method |
|---|---|
| Model count | The count returned by `GET /v1/models` |
| Key-model coverage | An availability matrix for mainstream models (Claude/GPT/Gemini/DeepSeek/Qwen flagship and flash tiers) |
| Protocol coverage | OpenAI-compatible / Anthropic native / Gemini native |

## Model-eval layer (evals.html)

The gateway layer answers "which gateway is reliable to route through"; the model layer answers "which model gives the most value". Data source `data/models.json`
(official list prices + traceable benchmarks, dated by `asOf`); `aggregate.mjs` produces `web/models.json`.
The core calculations are pure functions (`probe/metrics.mjs`), with unit tests.

| Sub-item | Convention | Implementation |
|---|---|---|
| Price-value measurement | Task cost = (input price × input tokens + output price × output tokens) ÷ 1e6; budget can buy = budget ÷ unit price × 1e6; local/free recorded as 0 / ∞ | `taskCost` / `tokensForBudget` |
| Authoritative benchmark | Includes only hard scores **with a public source** (MMLU-Pro/GPQA/SWE-bench/AIME…), each carrying a source link + collection date; missing recorded as — **never fabricated**; cross-source not fully comparable, magnitude reference only; links out to Artificial Analysis / LM Council / OpenCompass for a fuller picture | The `bench` field in `data/models.json` |
| By scenario | Maps benchmarks to scenarios (coding→SWE-bench, science→GPQA, math→AIME, knowledge→MMLU-Pro), no fabricated numbers from the same source | `renderScenarios` in evals.html |
| Quality-per-dollar | Composite knowledge score (MMLU-Pro) ÷ output price = how many points per dollar; a rough quality/cost ratio, a sorting reference within the same-benchmark column only | `valuePerDollar` |

> Prices are official list prices, adjusted by vendors; maintainable in `data/models.json`, and benchmark scores
> are welcome via PRs with sources. The model layer does no probing (that's the gateway layer's job); it's a "list price + public evals" benchmark.

## Composite scoring

No weighted total score (a black-box total score is inevitably questioned). The leaderboard defaults to sorting by "30-day stability", with trust rating,
price index, etc. each as their own column, and engineers sort by the column they care about. The model layer is the same: price-value, benchmark, and
cost-effectiveness are each independent, not synthesized into a single total.

## Fairness

- The probe code, detection prompts, raw data, and aggregation logic are all open source — anyone can reproduce with their own key;
- Policy-class annotations must carry an evidence link and annotation date, and accept PR corrections;
- The gateway list accepts self-service PR submissions (`data/gateways.json`);
- When the maintainer has a conflict of interest with a gateway, it is disclosed in the list entry.
