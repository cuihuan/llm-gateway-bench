# Router Comparison Report

Run: 14589c94-5b56-4cce-acb3-00fea53dc470 · Generated (UTC): 2026-10-19T06:46:35.164Z

Model: claude-opus-4-8 · Task: regex-log · Agent: claude-code

SynthorAI A and B are pooled. Compare cost per trial and per successful task because the baseline runs twice as many trials.

## Overview

| Metric | SynthorAI | NIBRoute |
|---|---:|---:|
| Trials | 10 / 10 | 5 / 5 |
| Task pass rate | 100.0% (10/10) | 100.0% (5/5) |
| Mean agent time (s) | 123.7 | 180.4 |
| Total cost (USD, estimate) | $3.7862 | $2.1227 |
| Cost per trial (USD, estimate) | $0.3786 | $0.4245 |
| Cache hit rate (input tokens) | 88.8% | 68.7% |

## Findings

- Performance: NIBRoute used 180.4 s per trial versus 123.7 s for SynthorAI; 45.8% slower in this sample.
- Price: NIBRoute cost $0.4245 per trial versus $0.3786; the estimate is 12.1% higher. Actual billed charges were not collected.
- Cache: SynthorAI 88.8%; NIBRoute 68.7%. This is token reuse, not a dollar discount.
- Quality: SynthorAI passed 10/10; NIBRoute passed 5/5. These results apply to this task only.

## 1. Performance

| Metric | SynthorAI | NIBRoute |
|---|---:|---:|
| Mean agent time (s) | 123.7 | 180.4 |
| Median agent time (s) | 122.4 | 193.9 |
| Fastest / slowest trial (s) | 99.5 / 157.4 | 151.9 / 200.7 |
| Mean tool calls per trial | 2.9 | 3.8 |

Agent time includes model inference and tool execution; container setup is excluded. It is not time to first token or pure decoding speed.

## 2. Price & cache

| Metric | SynthorAI | NIBRoute |
|---|---:|---:|
| Total cost (USD, estimate) | $3.7862 | $2.1227 |
| Actual router charge (USD) | Not collected | Not collected |
| Cost per trial (USD, estimate) | $0.3786 | $0.4245 |
| Cost per successful task (USD, estimate) | $0.3786 | $0.4245 |
| Successful tasks per estimated USD | 2.6 | 2.4 |
| Cache hit rate (input tokens) | 88.8% | 68.7% |
| Cache read tokens | 986,073 | 506,510 |
| Cache write tokens | 124,616 | 194,508 |
| Total input tokens (including cache) | 1,110,763 | 737,214 |
| Output tokens | 100,557 | 18,912 |

Cache hit rate = total cache-read tokens / total input tokens, weighted by token volume. Cache writes are included in total input but do not count as hits. A higher hit rate alone does not prove lower billed cost.

Costs are agent-reported or Harbor pricing estimates, not verified router charges. Provider balance deltas, discounts, currency conversion and invoices were not collected; actual billed spend and dollar savings from caching are unavailable.

## 3. Quality & governance

| Metric | SynthorAI | NIBRoute |
|---|---:|---:|
| Task pass rate | 100.0% (10/10) | 100.0% (5/5) |
| Mean verifier reward (0-1) | 1.000 | 1.000 |
| Verifier checks passed / total | 10 / 10 | 5 / 5 |
| Task failures / execution exceptions | 0 / 0 | 0 / 0 |
| Completed without execution exceptions | 10 / 10 | 5 / 5 |
| Missing trial results / missing verifier rewards | 0 / 0 | 0 / 0 |
| Cost / cache coverage (trials) | 10/10 · 10/10 | 5/5 · 5/5 |
| Usage accounting anomalies | 0 | 0 |
| Distinct benchmark tasks | 1 | 1 |

Quality is measured by the independent task verifier, not an invented intelligence score. A pass requires reward 1 with no execution exception. Missing usage remains N/A, never zero.

Cost sources: Agent-reported estimate. Neither source verifies the router invoice.

## Integrity hard gates

Reference status: NO DIRECT OFFICIAL REFERENCE. A and B are repeat runs of the baseline router. Neither configured router is an Anthropic direct API reference; official token equality and official error ceilings remain UNVERIFIED.

| Check | SynthorAI A | SynthorAI B | NIBRoute |
|---|---|---|---|
| Response model matches requested model | PASS | PASS | PASS |
| Every visible thinking block has a signature | PASS | PASS | PASS |
| Every expected trial has cache hits | PASS | PASS | PASS |
| First input equals official on identical requests | UNVERIFIED: official reference unavailable | UNVERIFIED: official reference unavailable | UNVERIFIED: official reference unavailable |
| Trial exceptions no greater than official | UNVERIFIED: official reference unavailable | UNVERIFIED: official reference unavailable | UNVERIFIED: official reference unavailable |
| API errors no greater than official | UNVERIFIED: official reference unavailable | UNVERIFIED: official reference unavailable | UNVERIFIED: official reference unavailable |
| First input equals baseline A/B (router comparison) | PASS | PASS | UNVERIFIED: request digests differ |
| First input stable on identical logged requests within router | PASS | PASS | FAIL: input varies for identical logged requests |

Hard-gate result: ISSUES DETECTED. At least one directly observable hard gate failed.

- NIBRoute: first-input totals vary for the same logged request digest. Investigate hidden upstream prompt changes or usage recounting; this does not prove model substitution.
- NIBRoute: 8 response message(s) contain visible thinking text but report zero thinking tokens. Treat the thinking-token row as an upstream telemetry discrepancy, not evidence of zero reasoning. Token-based cost estimates may also be affected by unreliable usage.

| Check | SynthorAI A | SynthorAI B | NIBRoute |
|---|---|---|---|
| Trials / expected | 5/5 | 5/5 | 5/5 |
| Complete session evidence (trials) | 5/5 | 5/5 | 5/5 |
| Trial exceptions / missing results | 0 / 0 | 0 / 0 | 0 / 0 |
| API error messages observed by Claude Code | 0 | 0 | 0 |
| API request records / requests without a response | 25 / 5 | 22 / 5 | 24 / 0 |
| Response model counts (unique messages) | claude-opus-4-8 x 20 | claude-opus-4-8 x 17 | claude-opus-4-8 x 24 |
| Thinking signature coverage (visible blocks) | 100.0% (10/10) | 100.0% (7/7) | 100.0% (8/8) |
| Calls with thinking text but zero reported thinking tokens | 0 | 0 | 8 |
| Redacted thinking with opaque data / blocks | 0 / 0 | 0 / 0 | 0 / 0 |
| Trials with cache hits | 5/5 | 5/5 | 5/5 |
| First request total input tokens (all observed values) | 23,128 | 23,128 | 33,206, 34,188, 35,653, 36,154, 36,490 |
| First request uncached input tokens | 2 | 2 | 4,662, 4,800, 5,006, 5,076, 5,123 |
| First request cache-read tokens | 23,126 | 0, 23,126 | 0 |
| First request cache-write tokens | 0 | 0, 23,126 | 28,544, 29,388, 30,647, 31,078, 31,367 |
| Message ID prefixes | msg_bdrk x 20 | msg_bdrk x 17 | msg_128 x 1, msg_2a4 x 1, msg_530 x 1, msg_599 x 1, msg_8b0 x 1, msg_645 x 1, msg_6d3 x 1, msg_dee x 1, msg_ed2 x 1, msg_fc8 x 1, msg_00e x 1, msg_29e x 1, msg_3cf x 1, msg_7a6 x 1, msg_80e x 1, msg_67c x 1, msg_90f x 1, msg_9f5 x 1, msg_bf8 x 1, msg_f6f x 1, msg_0a0 x 1, msg_7f4 x 1, msg_be6 x 1, msg_cc6 x 1 |
| inference_geo | (empty) x 20 | (empty) x 17 | (empty) x 24 |

Thinking coverage counts individual visible thinking blocks, not calls; one signed block cannot hide an unsigned block in the same message. A nonempty signature is presence evidence only, not cryptographic verification. Redacted opaque data is listed separately and is not counted as a visible thinking signature.

API errors are isApiErrorMessage records observed in the retained Claude Code sessions, not an HTTP wire audit. Request records with no paired response can include retries or compatibility fallback; a zero error-message count does not prove zero upstream HTTP errors.

First input = uncached input + cache creation + cache read, taken from the first main-session response and paired to its requestRef. Equality requires the same task and matching request digests, including settings. Different request digests make tokenizer/model substitution conclusions inconclusive. A token mismatch is an investigation signal, not proof of a substituted model.

Backend hints are self-reported: msg_011 is commonly associated with Anthropic API and msg_bdrk with Bedrock in the supplied comparison convention. Prefixes and inference_geo do not authenticate a backend. Empty and missing geo are distinguished. A different backend alone is informational; ask the router operator to explain it.

## Statistical comparison: NIBRoute

| Metric (trial means) | SynthorAI A | SynthorAI B | NIBRoute | A/A change | A/B change | p | Interpretation |
|---|---:|---:|---:|---:|---:|---:|---|
| Task pass rate | 100.0% | 100.0% | 100.0% | +0.0 pp | +0.0 pp | 1.0000 | No clear difference |
| API calls (unique response messages) | 4 | 3.4 | 4.8 | -15% | +30% | 0.0440 | Difference detected |
| Tool calls | 3 | 2.8 | 3.8 | -7% | +31% | 0.1092 | No clear difference |
| Agent time (s) | 121 | 126.5 | 180.4 | +5% | +46% | 0.0007 | Difference detected |
| Call duration, trial median (s, log estimate) | 10.7 | 11 | 7.9 | +3% | -28% | 0.0506 | No clear difference |
| Input tokens including cache | 120,164.4 | 101,988.2 | 147,442.8 | -15% | +33% | 0.0290 | Difference detected |
| Cache hit rate | 91.1% | 85.8% | 68.5% | -5.2 pp | -20.0 pp | 0.0003 | Difference detected |
| Output tokens | 9,856 | 10,255.4 | 3,782.4 | +4% | -62% | 0.0003 | Difference detected |
| Thinking tokens | 7,363.6 | 8,078.8 | 0 | +10% | -100% | 0.0003 | Difference detected |
| Calls containing thinking | 51.7% | 43.3% | 34.0% | -8.3 pp | -13.5 pp | 0.1792 | No clear difference |

A/A = B minus A; A/B = candidate minus pooled A+B. Percentage metrics use percentage points; other changes are relative (N/A for a zero denominator; absolute changes are then used for the variation check). The two-sided permutation test shuffles trial labels within each task (exact at up to 100,000 permutations; otherwise 10,000 seeded draws). A difference is flagged only at p < 0.05 and beyond the observed A/A change. Missing metrics or fewer than two trials per group remain inconclusive. These ten exploratory tests are not corrected for multiple comparisons; no clear difference is not evidence of equivalence.

Call duration uses the paired api-request timestamp through the last logged response block; it is a session-log estimate, not wire latency or time to first token. Unpaired calls remain N/A. Usage and thinking token counts are upstream-reported.

## Per-trial integrity evidence

| Group | Task | Trial | Pass | Exception | API errors | First input | First request digest | Thinking signed / visible | Cache hit |
|---|---|---|---|---|---:|---:|---|---|---|
| SynthorAI A | regex-log | regex-log__A85nxA9 | Yes | None | 0 | 23,128 | ad11fee6d96ce144a6280c9b05f2417ec3ef3e7d7ea2416cc18342cb8c4baaa4 | 3 / 3 | Yes |
| SynthorAI A | regex-log | regex-log__G2woX2u | Yes | None | 0 | 23,128 | ad11fee6d96ce144a6280c9b05f2417ec3ef3e7d7ea2416cc18342cb8c4baaa4 | 2 / 2 | Yes |
| SynthorAI A | regex-log | regex-log__M8tFSys | Yes | None | 0 | 23,128 | ad11fee6d96ce144a6280c9b05f2417ec3ef3e7d7ea2416cc18342cb8c4baaa4 | 2 / 2 | Yes |
| SynthorAI A | regex-log | regex-log__a4JQk2j | Yes | None | 0 | 23,128 | ad11fee6d96ce144a6280c9b05f2417ec3ef3e7d7ea2416cc18342cb8c4baaa4 | 2 / 2 | Yes |
| SynthorAI A | regex-log | regex-log__gishqAL | Yes | None | 0 | 23,128 | ad11fee6d96ce144a6280c9b05f2417ec3ef3e7d7ea2416cc18342cb8c4baaa4 | 1 / 1 | Yes |
| SynthorAI B | regex-log | regex-log__LUaHyEf | Yes | None | 0 | 23,128 | ad11fee6d96ce144a6280c9b05f2417ec3ef3e7d7ea2416cc18342cb8c4baaa4 | 1 / 1 | Yes |
| SynthorAI B | regex-log | regex-log__jTuDUnn | Yes | None | 0 | 23,128 | ad11fee6d96ce144a6280c9b05f2417ec3ef3e7d7ea2416cc18342cb8c4baaa4 | 2 / 2 | Yes |
| SynthorAI B | regex-log | regex-log__nuWjRdT | Yes | None | 0 | 23,128 | ad11fee6d96ce144a6280c9b05f2417ec3ef3e7d7ea2416cc18342cb8c4baaa4 | 1 / 1 | Yes |
| SynthorAI B | regex-log | regex-log__t2zRSZo | Yes | None | 0 | 23,128 | ad11fee6d96ce144a6280c9b05f2417ec3ef3e7d7ea2416cc18342cb8c4baaa4 | 2 / 2 | Yes |
| SynthorAI B | regex-log | regex-log__xYck2rc | Yes | None | 0 | 23,128 | ad11fee6d96ce144a6280c9b05f2417ec3ef3e7d7ea2416cc18342cb8c4baaa4 | 1 / 1 | Yes |
| NIBRoute | regex-log | regex-log__ATEWKuR | Yes | None | 0 | 34,188 | 106196bd4cf2ad346b0b4d7509d363aee057e8bdbfc1ebf70eeb4866b6972530 | 1 / 1 | Yes |
| NIBRoute | regex-log | regex-log__NFhsKnV | Yes | None | 0 | 35,653 | 106196bd4cf2ad346b0b4d7509d363aee057e8bdbfc1ebf70eeb4866b6972530 | 1 / 1 | Yes |
| NIBRoute | regex-log | regex-log__RLstivn | Yes | None | 0 | 36,490 | 106196bd4cf2ad346b0b4d7509d363aee057e8bdbfc1ebf70eeb4866b6972530 | 2 / 2 | Yes |
| NIBRoute | regex-log | regex-log__bjQa4QH | Yes | None | 0 | 36,154 | 106196bd4cf2ad346b0b4d7509d363aee057e8bdbfc1ebf70eeb4866b6972530 | 2 / 2 | Yes |
| NIBRoute | regex-log | regex-log__s2cnCfw | Yes | None | 0 | 33,206 | 106196bd4cf2ad346b0b4d7509d363aee057e8bdbfc1ebf70eeb4866b6972530 | 2 / 2 | Yes |

## First-request task check

| Task | SynthorAI A | SynthorAI B | NIBRoute |
|---|---|---|---|
| regex-log | 5/5 passed; first input median 23,128 | 5/5 passed; first input median 23,128 | 5/5 passed; first input median 35,653 |

Baseline repeat check: SynthorAI A mean 121.0 s; B mean 126.5 s.

This sample measures only the selected task. Small samples do not establish general intelligence, stable speed advantages, or model identity. Usage counters and upstream model identity have not been independently audited.
