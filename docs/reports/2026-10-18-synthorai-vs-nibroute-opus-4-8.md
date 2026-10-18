# SynthorAI vs NIBRoute — Claude Opus 4.8

Date: 2026-10-18  
Formal run ID: `035c0bd2-3f35-43e4-a291-8cfb92dc5418`  
Harness: Terminal-Bench / Harbor / Claude Code 2.1.302  
Model: `claude-opus-4-8`  
Task: `regex-log`

## Executive result

Both routers completed the task successfully. SynthorAI passed both A/A baseline runs and NIBRoute passed its candidate run. This first run therefore found no intelligence-quality difference on the selected task. NIBRoute took longer than both SynthorAI trials, but one candidate trial is not enough to establish a stable latency difference.

| Route | Trial | Verifier reward | Trial exception | Agent duration | Input tokens | Cache tokens | Output tokens | Harbor cost estimate |
|---|---|---:|---|---:|---:|---:|---:|---:|
| SynthorAI | A | 1.0 | None | 126.9 s | 119,051 | 86,783 | 10,621 | $0.5106 |
| SynthorAI | B | 1.0 | None | 174.4 s | 95,263 | 81,734 | 14,422 | $0.4860 |
| NIBRoute | Candidate | 1.0 | None | 187.1 s | 153,890 | 105,075 | 3,709 | $0.4385 |

SynthorAI's mean agent duration was 150.7 seconds. The NIBRoute trial was 36.4 seconds, or 24.2%, slower than that mean. The Harbor cost estimate for NIBRoute was 12.0% below the SynthorAI mean, but this is an estimate derived from reported usage and configured model pricing, not a provider invoice.

## Protocol smoke checks

Before the formal run, both fixed router endpoints returned HTTP 200 from `/v1/models`, advertised `claude-opus-4-8`, and returned `OK` from both `/v1/messages` and `/v1/chat/completions`.

The tiny direct probe exposed a substantial metering difference: SynthorAI reported 14 input tokens and 4 output tokens with a $0.00017 cost, while NIBRoute reported about 6,480 input tokens and 1–2 output tokens plus credit usage rather than USD. This may reflect upstream prompt injection, token accounting differences, or both. It is a metering/integrity signal and must not be interpreted as an intelligence result.

## Interpretation

- Intelligence on `regex-log`: tie; all three independently verified trials passed.
- Reliability: not established. SynthorAI has only two trials and NIBRoute only one.
- Speed: NIBRoute was slower in this sample, but additional repeated trials are required.
- Usage: reported token shapes differ materially both between routes and between trajectories. Compare provider-side billing records before treating the Harbor estimate as actual spend.
- Security: router credentials were held in process memory for execution and were not written into run metadata, reports, or the repository.

## Recommended next run

Run at least five trials per job on `regex-log`, then repeat on `git-recovery` and one longer reasoning task. Report pass rate, median and p90 duration, trial exceptions, token distributions, and provider-side billed usage separately.

## Audit note

An earlier run, `8c9d95b6-919f-4615-8fdb-24037f64bfb2`, is invalid because its submitted credentials contained literal quote characters and every trial ended with `AgentAuthenticationError`. It is excluded from all comparisons above.
