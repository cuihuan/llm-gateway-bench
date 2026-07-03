# Research: LLM benchmark sites and open-source tools (2026-06)

> This document is the research distilled before building the repo; its conclusions directly determine the repo's form.
> §1–3 are pre-build research (2026-06-10); §4–6 are a deep dive into user pain-points and detection techniques (2026-06-11).

## 1. Survey of benchmark sites

| Site | What it measures | Method | Open data |
|---|---|---|---|
| [Artificial Analysis](https://artificialanalysis.ai) | Quality index, price ($/1M), TTFT, tok/s — **comparing the same model across providers** | Continuous automated probing of 500+ real endpoints, median + percentiles, 7/30/90-day windows | Has a Data API (free 1k calls/day) |
| [LMArena](https://arena.ai) (formerly LMSYS) | Human-preference Elo + 95% CI, by track (text/WebDev/vision/Agent…) | Crowdsourced blind battles, Bradley-Terry continuously recomputed | Periodically releases battle datasets |
| [OpenRouter rankings](https://openrouter.ai/rankings) | Real-traffic ranking; **per-model, per-provider TTFT/throughput/uptime** | Passive stats from its own production traffic (rolling 5-minute window) | Partial (model-metadata API) |
| [BFCL (Berkeley Function-Calling Leaderboard)](https://gorilla.cs.berkeley.edu/leaderboard.html) | Tool-call accuracy + cost/latency columns | AST diffing + executable verification, version-pinned and reproducible | Fully open source (data + code + model responses) |
| [LiveBench](https://livebench.ai) | Quality scores across 7 categories, 21 tasks | Fresh questions monthly to prevent contamination, rule-based scoring, no LLM judge | Fully open source |
| [K2 Vendor Verifier](https://github.com/MoonshotAI/K2-Vendor-Verifier) | **Tool-call fidelity of the same open-source model across 12+ providers** | Replays a fixed 4,000 requests, diffing against the official API as the gold standard | Code + half the data open source |
| [LLMStatus.net](https://llmstatus.net) / [ModelUptime](https://modeluptime.com) / [LLM Overwatch](https://llmoverwatch.com) | Official-API availability/latency status pages | Active probing every 60s–10min (some multi-region) | No |
| GPT for Work tracker *(retired 2026 — page now 410 Gone)* | OpenAI/Anthropic/Gemini response times | Was: every 10 minutes, 3 geographic locations, randomized prompt to defeat caching | No |
| HF Open LLM Leaderboard | (retired 2025-03) | Static benchmarks saturate and die; **only continuously refreshed data survives** | Historical archive |

**UI patterns worth borrowing** (from the best of them):
1. A sortable leaderboard table: percentile metrics (p50/p95) + confidence intervals, not a lone average;
2. A price vs speed/quality **scatter plot**, making the Pareto frontier obvious at a glance (Artificial Analysis's signature);
3. A per-endpoint **over-time time series** — turning a "one-off snapshot" into "long-term trust", which is exactly the long-term value of accumulated data;
4. A per-endpoint uptime band chart (OpenRouter model-page style);
5. Trustworthiness signals: public detection prompts and frequency, pinned versions, open raw data.

## 2. Survey of open-source tools

| Tool | Status | What it measures | Use for this repo |
|---|---|---|---|
| [llmperf](https://github.com/ray-project/llmperf) (Ray, 1.1k★) | **Archived** | TTFT/ITL/tok/s/error rate | Methodology reference: fixed 550 in / 150 out tokens, 150 requests for percentiles |
| [llmperf-leaderboard](https://github.com/ray-project/llmperf-leaderboard) | **Archived** | Periodic probing → static leaderboard | The only precedent with the exact same goal as this repo; dead, leaving the slot open |
| [AIPerf](https://github.com/ai-dynamo/aiperf) (NVIDIA, 361★) | Active | TTFT/ITL/tok/s high-concurrency load test | Load-test form, unsuited to low-frequency probing; metric definitions are a reference |
| [guidellm](https://github.com/vllm-project/guidellm) (vLLM, 1.2k★) | Active | Rate sweep + SLO analysis | Same as above, aimed at self-deployment capacity testing |
| [promptfoo](https://github.com/promptfoo/promptfoo) (22k★, MIT) | Active | Quality assertions, multi-provider comparison, has an official GitHub Action | The top pick for a **later quality column**: CI-native + multi-provider |
| [llm-gateway-bench](https://github.com/taffy-owo/llm-gateway-bench) (3★, MIT) | New | Streaming TTFT/p95/success rate, YAML multi-gateway comparison | SSE timing details are a reference |
| [litellm](https://github.com/BerriAI/litellm) (50k★) | Active | `model_prices_and_context_window.json` is the de-facto-standard open price library | **The price-column data source** |
| uptime-kuma / arguslm / LMeterX / Helicone / Langfuse | Active | Various probing/observability | All require a persistent server, not matching the "serverless, static leaderboard" form |
| lm-evaluation-harness / openai-evals | Active/maintenance | Academic quality benchmarks | Too heavy, unrelated to probing |

**Tool conclusions**:
- Streaming TTFT/throughput measurement is a ~200-line problem solved countless times (SSE timing + `stream_options.include_usage`) — **lightest to build ourselves**;
- "GitHub Actions scheduled probing + time series stored in the repo + static leaderboard" — **no active project is currently doing this**;
- Multi-region direct-reachability probing (especially CN direct connection) — no LLM tool does it at all, the real differentiator (GH Actions defaults to US runners only; a CN viewpoint needs a self-hosted runner or edge probe).

## 3. Positioning conclusion (what this repo will do)

1. **Form**: serverless. GitHub Actions scheduled probing → result JSON committed back to `data/results/` → static pages render the leaderboard (GitHub Pages). The data itself is open and reproducible, accumulating into a moat over time.
2. **Viewpoint**: a user-perspective five dimensions — reachability, stability, speed, price, catalog (see `methodology.md`).
3. **Differentiation**:
   - CN/multi-region direct-reachability probing (nobody does it);
   - Neutrality (OpenRouter markets itself; Artificial Analysis doesn't test relays);
   - A future "fidelity" dimension: K2 Vendor Verifier-style diffing against the official API to detect model substitution/quantization/context truncation.
4. **Engineering red lines** (pitfalls learned from the research): cron has 15min+ jitter → record real timestamps; shared runners have noisy neighbors → multi-sample per run for the median, concurrency ≤4; public detection prompts + randomization to defeat caching.

---

## 4. Deep dive: user pain-points × black-box detection toolbox (2026-06 supplement)

> Channel origin **can't be directly "proven"**; this repo's stance is a **combination of behavioral fingerprints**: multiple black-box-measurable signals
> jointly profile a gateway, without relying on the gateway's self-declaration. Below are pain-points distilled from linux.do / V2EX / Zhihu / 36kr /
> arXiv / GitHub community detection tools, with the corresponding actionable detection methods.

### 4.1 User pain-point board (ranked by "impact on gateway choice")

| # | Pain-point | Hard data | How to test it black-box | This repo's status |
|---|---|---|---|---|
| 1 | **Model substitution/degradation** | CISPA audit: 45.83% of endpoints fail fingerprint verification, performance deviation up to 47.21%; ACM IMC: 40%+ of endpoints fingerprint-mismatched. Techniques: probabilistic downgrade, silent version switching | Periodic model-identity fingerprint (LLMmap 8-question, 95%+ accurate) + capability-regression scores, drawn as a time series to catch intermittent substitution | Missing (P1) |
| 2 | **Token theft/inflated usage** | CISPA: pay $14.84, get $5.70-7.77 (~38%); IMC: one site over-charged by 62.8%; cache reads billed at full price | Local tokenizer recomputation, comparing against the gateway-reported prompt_tokens/completion_tokens, alert on deviation >5% | Partial (already measures usage report rate; recomputation diff not yet done, P0) |
| 3 | **Exit scam/no invoice/compliance gaps** | V2EX "the relay's underwear" documents cheap acquisition → price hike → service degradation → domain vanishing; 92+ relay products mostly without company registration/ICP | Survival duration/uptime history, a graveyard of dead sites, entity/ICP/invoice metadata columns | Partial (has uptime history + manual annotation, no graveyard/survival duration) |
| 4 | **Quantization degradation** (especially aggregators routing to FP4/INT4) | qwen-code PR#348 avoids quantizing providers; Roo-Code#11325 documents CJK output degrading to garbage on Int4/FP4 | A CJK output integrity probe + an encoding-quality probe + comparison against disclosed quantization level | Missing (P2, needs a quality column) |
| 5 | **Fake streaming** | Relays cache a non-streaming response then replay it disguised as SSE, hiding queue latency | Per-chunk timing: TTFT≈total latency + content dumped within a tiny window | **Implemented** ✓ |
| 6 | **Context truncation** | Relays trim long context to save upstream cost; api-checker uses canary+binary-search to locate the truncation boundary | Multi-depth needle-in-haystack (8K/32K/128K), compared against the official API | Missing (P1, $0.4-1.2 per run, weekly) |
| 7 | **Peak throttling/dynamic multipliers** | linux.do measured "frequently freezes at peak"; one site bumped Claude Code's multiplier 1.3→1.5 without notice | **The core value of probing**: draw TTFT/throughput/success-rate curves by time-of-day, comparing peak vs trough | Partial (has time series, not yet sliced by time-of-day) |
| 8 | **Ban-wave fallout** | An Anthropic ban wave emptied account pools, ~70% due to dirty data-center IPs; reverse Sub2API stacks risk-flagged in bulk | Availability/success-rate event timeline catching ban-wave outages + annotating channel type | Partial (success-rate time series exists, no event annotation) |

### 4.2 Black-box detection toolbox (by implementation cost/priority)

| Method | Protocol | Per-run cost | Source |
|---|---|---|---|
| **Fake-streaming detection** | Per-chunk timing, looking at the TTFT/E2E ratio and inter-chunk interval distribution | $0 (just instrumentation) | LiteLLM#19909 |
| **Usage-recomputation diff** | Locally budget tokens for a fixed prompt, compare against gateway-reported, alert on deviation >5%; incidentally check for hidden system-prompt injection | $0 (piggyback on existing probe) | 36kr/Zhihu |
| **K2-style tool-call diff** | A 200-request subset comparing finish_reason F1 + JSON schema validity rate (official API as gold standard) | ~$1-3/model | K2-Vendor-Verifier |
| **LLMmap identity fingerprint** | 8 carefully crafted queries, a classifier identifies the model version, 95%+ accurate | <$0.01/model | LLMmap, USENIX'25 |
| **MMD model-equality test** | ~10 completions sampled per prompt, string-kernel MMD + permutation test vs a reference model | $0.1-0.5/probe | Model Equality Testing, ICLR'25 |
| **logprob drift tracking** | Take the logprob of 1 token for a fixed prompt, track mean drift to detect fine-tuning/quantization | <1 cent (only 5/13 providers expose logprobs) | arXiv 2512.03816 |
| **Energy-distance behavioral fingerprint** | Sample a fixed prompt set (800 short requests) every few hours, embed and compare distributions, e-value aggregation to judge change | Medium (designed for periodic probing) | arXiv 2603.19022 |
| **needle context truncation** | Bury a UUID needle at multiple depths; a hard cut shows up as deterministic failure before the cut point | $0.4-1.2/model (128K) | LLMTest_NeedleInAHaystack |

### 4.3 Industry baseline protocols (probe-convention alignment)

- **Artificial Analysis** (gold standard): streaming probes, four load tiers of 1k/10k/100k input + vision, 1k/10k/vision 8 times a day (~every 3h), 10-concurrency once a day, 100k weekly; metrics take the **trailing 72h median**; tokens uniformly normalized to tiktoken o200k_base to keep $/token and tok/s comparable across providers; fixed GCP us-central1 single-VM egress.
- **OpenRouter**: passive stats on real traffic, rolling 5-minute window p50/p75/p90/p99; uptime = success/total **excluding user errors (4xx)** — this convention is worth borrowing; at model×provider granularity rather than per-host.
- **thefastest.ai**: daily multi-region (three Fly.io regions), warmup connection to remove TCP/TLS handshake latency, 1k in/20 out, best-of-3 dropping queuing outliers.
- **llmperf**: 550 in/150 out, a Shakespeare-sonnet-concatenated prompt forcing long output + a number-conversion correctness probe; a single tokenizer to keep tok/s comparable.
- **vLLM bench serve / AIPerf**: metric naming `ttft/tpot/itl/e2el` + p50/p90/p99, Poisson arrivals simulating real load — borrow the schema naming directly.

### 4.4 Community relay-detection tools worth borrowing

- **api-check** (925★): `system_fingerprint` consistency comparison to detect adulterated models, pure front-end with the key never leaving local — borrow the trust-dimension protocol directly.
- **ChannelMonitor** (active): ≥30-minute probe interval (a cost/anti-abuse-friendly floor), RPS/RPM rate-limit defaults, (channel,model)-granularity availability semantics.
- **all-api-hub** (4000★): a relay-type identification list can serve as our gateway taxonomy; cross-site price normalization feeds the price matrix.
- **api-key-tester**: four-state key classification (valid/invalid/rate-limited/paid) — separating rate-limited from dead avoids misjudging a gateway as down.
- **Uptime Kuma**: a push-heartbeat integration pattern, letting probe results feed any Kuma instance.

### 4.5 Implementation priority (conclusion)

- **P0 (zero cost, piggyback on existing probe, do immediately)**: fake-streaming detection ✓ done; local usage recomputation diff (catching inflated multipliers/hidden injection).
- **P1 (cents to a few dollars per run, weekly)**: model-identity fingerprint (LLMmap-style 8-question) against substitution; needle context-truncation detection; peak vs trough curves sliced by time-of-day.
- **P2 (needs a quality baseline)**: quantization/degradation detection (CJK integrity + encoding quality); K2-style tool-call diffing (already have a single-model tool-call check, extend to a diff against the official).
- **UI**: a top-of-page pain-point guide translating "can I trust it" into the 8 concrete pain-points above + matching evidence columns; a new "self-test guide" section teaching users to reproduce with their own key; trust-rating copy emphasizing "a combination of behavioral fingerprints, not claims".

---

## 4. User pain-point board (ranked by influence on the gateway-choice decision)

Sources: linux.do / V2EX / Zhihu / 36kr community discussions + the CISPA academic audit
[*Real Money, Fake Models* (arXiv 2603.01919)](https://arxiv.org/abs/2603.01919).
Each pain-point is annotated with a black-box-measurable forensic method and this repo's current coverage status.

| # | Pain-point | Quantitative evidence | Black-box forensic method | This repo's status |
|---|---|---|---|---|
| 1 | **Model substitution/degradation**: selling a cheap model under the Claude/GPT name, or "probabilistic downgrade" (routing a fraction of requests to a cheap model), silent version switching | CISPA: **45.83% of relay endpoints fail the identity-fingerprint test**, performance deviation up to 47.21%; 17 shadow APIs slipped into 187 academic papers | A combination of behavioral fingerprints (tool-call fidelity/streaming authenticity/latency signature) + periodic identity-fingerprint probing ([LLMmap](https://arxiv.org/abs/2407.15847): 8 requests, >95% accuracy) + time-series display to catch "intermittent substitution" | Partial: behavioral fingerprints live; identity fingerprint P1 |
| 2 | **Token theft/inflated usage**: privately tweaked billing multipliers (counting one Chinese character as 3-4 tokens), secretly injected system prompts bloating prompt_tokens, cache price billed at full price | CISPA measured: pay $14.84 at official prices and actually get only **$5
