# Router Comparison Report

Date: 2026-10-18  
Run: `1050a6b1-b508-47f5-b99a-52309850e75f`  
Model: claude-opus-4-8 · Task: regex-log · Agent: claude-code

SynthorAI A and B are pooled. Compare cost per trial and per successful task because the baseline runs twice as many trials.

## Overview

| Metric | SynthorAI | NIBRoute |
|---|---:|---:|
| Trials | 6 / 6 | 3 / 3 |
| Task pass rate | 100.0% (6/6) | 100.0% (3/3) |
| Mean agent time (s) | 128.9 | 166.4 |
| Total cost (USD, estimate) | $2.4697 | $1.2591 |
| Cost per trial (USD, estimate) | $0.4116 | $0.4197 |
| Cache hit rate (input tokens) | 89.3% | 67.1% |

## Findings

- Performance: NIBRoute used 166.4 s per trial versus 128.9 s for SynthorAI; 29.1% slower in this sample.
- Price: NIBRoute cost $0.4197 per trial versus $0.4116; the estimate is 2.0% higher. Actual billed charges were not collected.
- Cache: SynthorAI 89.3%; NIBRoute 67.1%. This is token reuse, not a dollar discount.
- Quality: SynthorAI passed 6/6; NIBRoute passed 3/3. These results apply to this task only.

## 1. Performance

| Metric | SynthorAI | NIBRoute |
|---|---:|---:|
| Mean agent time (s) | 128.9 | 166.4 |
| Median agent time (s) | 122.3 | 165.1 |
| Fastest / slowest trial (s) | 106.5 / 153.4 | 156.9 / 177.3 |
| Mean tool calls per trial | 3.5 | 4.0 |

Agent time includes model inference and tool execution; container setup is excluded. It is not time to first token or pure decoding speed.

## 2. Price & cache

| Metric | SynthorAI | NIBRoute |
|---|---:|---:|
| Total cost (USD, estimate) | $2.4697 | $1.2591 |
| Actual router charge (USD) | Not collected | Not collected |
| Cost per trial (USD, estimate) | $0.4116 | $0.4197 |
| Cost per successful task (USD, estimate) | $0.4116 | $0.4197 |
| Successful tasks per estimated USD | 2.4 | 2.4 |
| Cache hit rate (input tokens) | 89.3% | 67.1% |
| Cache read tokens | 718,562 | 288,405 |
| Cache write tokens | 86,453 | 114,604 |
| Total input tokens (including cache) | 805,067 | 429,712 |
| Output tokens | 62,792 | 10,606 |

Cache hit rate = total cache-read tokens / total input tokens, weighted by token volume. Cache writes are included in total input but do not count as hits. A higher hit rate alone does not prove lower billed cost.

Costs are agent-reported or Harbor pricing estimates, not verified router charges. Provider balance deltas, discounts, currency conversion and invoices were not collected; actual billed spend and dollar savings from caching are unavailable.

## 3. Quality & governance

| Metric | SynthorAI | NIBRoute |
|---|---:|---:|
| Task pass rate | 100.0% (6/6) | 100.0% (3/3) |
| Mean verifier reward (0-1) | 1.000 | 1.000 |
| Verifier checks passed / total | 6 / 6 | 3 / 3 |
| Task failures / execution exceptions | 0 / 0 | 0 / 0 |
| Completed without execution exceptions | 6 / 6 | 3 / 3 |
| Missing trial results / missing verifier rewards | 0 / 0 | 0 / 0 |
| Cost / cache coverage (trials) | 6/6 · 6/6 | 3/3 · 3/3 |
| Usage accounting anomalies | 0 | 0 |
| Distinct benchmark tasks | 1 | 1 |

Quality is measured by the independent task verifier, not an invented intelligence score. A pass requires reward 1 with no execution exception. Missing usage remains N/A, never zero.

Cost source: Agent-reported estimate. This does not verify the router invoice.

Baseline repeat check: SynthorAI A mean 141.8 s; B mean 116.1 s.

This sample measures only the selected task. Small samples do not establish general intelligence, stable speed advantages, or model identity. Usage counters and upstream model identity have not been independently audited.

## Retention

The two pilot runs were removed from the visible history and their report endpoints return 404. Their raw directories remain recoverable in a private host archive. The active report is the nine-trial run above.
