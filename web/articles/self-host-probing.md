The leaderboard only tests the gateways the maintainer configured a key for. But what you really want to know is usually whether **the one you're actually using** is any good — and it may not be on the leaderboard at all. The good news: this benchmark isn't a website you can only look at, it's a **set of tools you can take and run**. The probe scripts, decision logic, and aggregation code are all open source and zero-dependency; attach your own key to any OpenAI-compatible gateway and you get a checkup in three minutes, with the exact same conventions as the leaderboard.

## Why run it yourself

- **Test gateways not on the leaderboard**: the niche relay you bought, your company's self-hosted gateway, a channel a friend recommended — add it to the config and you can test it.
- **Use your real network viewpoint**: the leaderboard's probe runs in GitHub Actions' US data centers. Run it from CN/Hong Kong and you get **your own link's** direct-connection latency and stability, not someone else's.
- **Verify rather than take it on faith**: however pretty someone else's conclusion, nothing beats reproducing it once with your own key and your own eyes. The decision functions are pure functions with unit tests, the logic laid bare — no black box.

## A round in three minutes

The fastest way — `--url` to directly probe any OpenAI-compatible endpoint, **without editing any file or committing**:

```
git clone https://github.com/cuihuan/llm-gateway-bench && cd llm-gateway-bench

# The key is read from an environment variable (PROBE_KEY by default), not the command line, to avoid leaks:
PROBE_KEY=sk-... node probe/probe.mjs \
  --url https://your-gateway.com --model gpt-4o-mini --samples 3
```

The result (with the full set of behavioral fingerprints) prints straight to stdout — nothing written to disk, no pollution of the repo's data. To test several models at once, use `--model a,b,c`.

To fold it into the leaderboard and local dashboard, run the full flow: add the gateway to `data/gateways.json`, then `node probe/probe.mjs --gateway <id> --out data/results`, and finally `npm run aggregate && npm run serve` (→ http://localhost:8080).

All you need is Node ≥ 20, with no third-party dependencies. `--samples 3` means each model is probed three times for percentiles; to measure peak drift, attach a scheduled task (the repo includes a local recorder `scripts/record.sh` that runs every 10 minutes, ready to use).

## What it measures for you

A single round runs the full set of behavioral fingerprints at once, matching the columns you see on the leaderboard:

- **Speed**: streaming TTFT p50/p95, throughput tok/s — the real feel of your own link.
- **Is it the real model**: model echo check, tool-call forwarding, CJK output integrity, context-truncation needle. See [Model substitution and degradation: how to detect it black-box](model-substitution).
- **Is it overcharging**: usage-recomputation fingerprint (`charsPerToken` / `promptTokens`), usage report rate. See [Billing traps: inflated tokens, fake streaming, context truncation](billing-traps).
- **Is it stable**: run it for a few days straight and the success rate, error breakdown, and time-of-day profile grow on their own. See [Stability and exit risk: the time series is the moat](stability-and-exit-risk).

> A single probe can only tell you about "this instant". Probabilistic downgrades of substituted models, peak-hour throttling, intermittent outages — all need **continuous, repeated, off-peak** runs to surface. That's precisely the point of attaching it as a scheduled task that runs continuously.

## Who this tooling borrows from

The methodology didn't come from nowhere; it's aligned with mature industry practice: streaming timing and throughput measurement follow llmperf's conventions (a fixed small prompt, multi-sampling for percentiles, concurrency ≤ 4 to avoid turning it into a load test); the tool-call fidelity idea comes from [K2 Vendor Verifier](https://github.com/MoonshotAI/K2-Vendor-Verifier); the official-price baseline comes from litellm's open price library. For the full probing convention, fairness rules (e.g. probe-key auth failures not counted as outages), and trustworthiness design, see [How we probe, and why it's trustworthy](methodology-trust).

## Merge your gateway into the public leaderboard

If you're willing to let your results enter the public leaderboard and accumulate into a trustworthy curve over time: open a PR to `data/gateways.json`, fill in `baseUrl`, `authEnv`, `probeModels`, and once the maintainer configures the key in Secrets it automatically enters the every-6-hours probe rotation. The data is committed per run and fully auditable — which is also why this leaderboard **can't be faked by a new shop**: the moat isn't the code, it's a time series that has run long enough.

For the complete decision flow for choosing a gateway, go back to [The complete analysis framework for choosing an LLM gateway](choosing-a-gateway).
