# LLM Gateway Bench

> **Black-box benchmark for LLM API gateways/relays. Don't trust claims, measure behavior — see in 5 seconds how your gateway compares to the best.**
>
> 🔗 Live: **https://cuihuan.github.io/llm-gateway-bench/** · MIT

---

## ⚡ TL;DR

**What it is** — an open-source gateway-benchmark **tool + knowledge base**: black-box probe any OpenAI-compatible gateway with your own key, compare it to "the best" dimension by dimension, plus a guide on how to choose.

**The one question it answers**
> I just plugged in a gateway — is it any good? Where does it lag the best: **price, speed, stability, integrity, or caching?**

**Self-test in one command**
```bash
PROBE_KEY=sk-your-key npm run compare -- --model gemini-2.5-flash \
  --url https://your-gateway.com --name "My Gateway" --price-in 0.2 --price-out 1.0
# → A self-contained report: gap card (you vs best) + price/speed/stability/behavioral fingerprints/cache.
#   Keys never leave your machine.
```

### 🧠 What actually matters when choosing a gateway (in priority order)

| Dimension | Check | 🚩 Red flag |
|---|---|---|
| **1. Trust & integrity** | Is it the real model? Will it vanish? | Wrong model echo, no legal entity/invoice, suspiciously cheap |
| **2. Price** | Gateway price ÷ official price = multiplier | `<0.5×` is usually a reverse/pirated channel; inflated token usage |
| **3. Stability** | 30/7-day success rate, peak-hour slowdown | Shaky uptime, peak TTFT drift ≥2× |
| **4. Speed** | Time-to-first-token (TTFT), throughput tok/s | Fake streaming (buffers the whole reply, then dumps it at once) |
| **5. Cache** | Does a repeated prompt hit the cache? | Repeats cost full price (no caching) |
| *Catalog* | Does it carry the models and protocols you need? | — |

> Rule of thumb: **trust first, price second, speed third.** "Too cheap" is a danger sign — always read it alongside trust.

---

## 🧭 Choosing a Gateway (newbie guide)

**Why a gateway/relay** — one key, one OpenAI-compatible endpoint for many models; friendlier access/payment (especially in CN); sometimes cheaper or with fallback routing.

**They actually come in five flavors** (knowing which you want narrows the choice):
1. **Aggregator** — many providers, one API and one bill (e.g. OpenRouter).
2. **Relay** — resells upstream, usually price-first (this project focuses on their **trustworthiness**).
3. **Gateway · Router** — adds policy, logging, rate limiting, per-request model routing (LiteLLM, Portkey, Helicone).
4. **Cloud model-mall** — a cloud vendor's catalog with enterprise controls (Bedrock-style).
5. **First-party inference** — speed- or price-first inference (Groq, Together, SiliconFlow).

**Pitfalls newbies hit** (exactly what this project black-box detects):
- Model substitution / silent downgrade — selling a cheap model under the Claude name.
- Inflated token usage / hidden injected system prompt — overcharging.
- Fake streaming — buffers the whole reply then dumps it at once, hiding queue latency.
- Quantization degradation — routed to INT4/FP4 weights; CJK breaks first.
- Context truncation — long context silently trimmed to save cost.
- Exit scam / no invoice — cheap to acquire users → price hike → domain vanishes.
- Hidden fees — e.g. OpenRouter's 5.5% credit-top-up fee.

> Full pain-points × black-box detection toolbox in [docs/research.md](docs/research.md); per-dimension methodology in [docs/methodology.md](docs/methodology.md).

---

## 🛠 What you get

Three layers — self-test → reference leaderboard → learn how to judge:

**① Tools** (run locally, keys stay on your machine)
- `npm run compare` — your gateway vs others/best → a **gap card**.
- `npm run longcontext` — multi-length × multi-depth needle test → a **context-truncation** heatmap.
- `npm run matrix` — classic-model × gateway matrix (maintainers run it in CI).

**② Live explorer** (a reference baseline that mirrors the system below)
Open **https://cuihuan.github.io/llm-gateway-bench/**, top to bottom:
- **Pick-for-me** — tick what you care about (cheap/stable/fast/compliant) for a transparent recommendation (per-dimension ranking, no hidden weighting).
- **Quick-rank** — live re-rank by priority + protocol/type filters + "current #1" highlight.
- **Lenses** — ranking / price / stability / behavioral check / summary table — the same list with swappable column sets.
- **Gap check** — "test my own gateway" and see how far it lags the best.
- **Report gallery** — classic-model × gateway matrix, long-context, price comparisons; shareable.
- **Model evals** — which model gives the most value (price-value, authoritative benchmarks).

**③ Knowledge base**
- [docs/methodology.md](docs/methodology.md) — how each metric is measured, with definitions.
- [docs/research.md](docs/research.md) — user pain-points × detection toolbox × landscape survey.
- [web/articles/](web/articles/) — in-depth articles: selection framework, substitution detection, billing traps, exit risk, and more.
- [docs/COMPARE-TO-BEST.md](docs/COMPARE-TO-BEST.md), [docs/PRODUCT-SPEC.md](docs/PRODUCT-SPEC.md) — design and data model.

---

## 🚀 Quick Start

```bash
# Node ≥ 20, zero deps
git clone https://github.com/cuihuan/llm-gateway-bench && cd llm-gateway-bench
npm test                                   # unit tests

# A) Self-test + gap check: your gateway vs OpenRouter / others
PROBE_KEY=sk-mine OPENROUTER_API_KEY=sk-or AIHUBMIX_API_KEY=sk-ah \
  npm run compare -- --model gemini-2.5-flash \
    --url https://your-gateway.com --name "My Gateway" --price-in 0.2 --price-out 1.0 \
    --with openrouter,aihubmix
# → reports/<model>-<date>.html (self-contained, shareable)

# B) Long-context retention (multi-length × multi-depth needle)
PROBE_KEY=sk-mine npm run longcontext -- --model gemini-2.5-flash \
  --url https://your-gateway.com --lengths 4000,16000,64000 --depths 10,50,90

# C) Serve the live dashboard locally
npm run serve                              # http://localhost:8080
```

Each run measures: TTFT & throughput (multi-sample percentiles) · success rate · price multiplier · tool-call forwarding · fake streaming · model echo · CJK integrity · long-context truncation · usage recomputation · prompt caching.
**Red line: keys are read only from environment variables — never written into reports, never leaving your machine.**

---

## 📏 The Dimensions

Each dimension: **what · why it matters · how it's measured · red flag.**

- **Trust & integrity** — channel origin can't be "proven by claim", so we build a black-box profile from a **combination of behavioral fingerprints**: model echo (catches substitution), whether tool calls get stripped, fake streaming (per-chunk timing), CJK integrity (a quantization tell), context-truncation needle, usage recomputation (catches inflation); retention/training/legal-entity claims are annotated against terms-of-service text + evidence links. 🚩 Any fingerprint consistently failing / suspiciously cheap / no legal entity or invoice.
- **Price** — gateway price ÷ official price = price index (official price taken from the litellm price library), geometric mean across models. 🚩 `>1×` is pricey; `<0.5×` is usually a reverse/pirated channel; an unusually low charsPerToken = suspected inflated token usage.
- **Stability** — 7/30-day rolling success rate, error breakdown (rate-limit 429 ≠ outage 5xx ≠ timeout — read separately), latency drift, time-of-day profile (does it slow down at peak?). 🚩 Peak drift ≥2×, shaky success rate, ban-wave outages.
- **Speed** — streaming TTFT p50/p95, throughput tok/s. 🚩 Fake streaming (TTFT ≈ total latency, then dumped at once).
- **Cache** — send the same long prompt twice; check whether the second request's usage reports a cache hit (compatible with OpenAI/DeepSeek/Anthropic conventions). 🚩 Repeated prompts cost full price (unsupported / not reported).
- **Catalog** — does it carry the models you need, protocol coverage (OpenAI / Anthropic), model count.

---

## 🏗 How it works — serverless, data-as-repo

```
GitHub Actions (every 6h cron)
  ├─ probe/probe.mjs     black-box probe each gateway × model → data/results/
  ├─ probe/prices.mjs    pull public pricing (litellm/synthorai/openrouter) → data/prices.json
  ├─ probe/matrix.mjs    classic-model × gateway matrix → web/reports/matrix-*.json
  └─ probe/aggregate.mjs aggregate results + annotations + prices → web/data.json (+ price matrix)
        └─ web/*.html    static render (GitHub Pages); browser & CLI share one render fn
```
- **No server, no DB** — raw data is committed per run; fully auditable and reproducible.
- **Zero keys in repo** — keys live only in GitHub Secrets / local environment variables; gateways missing a key are marked skipped, not failed.
- **No black-box score** — each dimension is its own column; "Pick-for-me / Quick-rank" maps priorities to **transparent per-dimension sorts** and shows the per-dimension ranking.

---

## ➕ Use it

**Add a gateway** — PR [`data/gateways.json`](data/gateways.json) (fill in `baseUrl`, `authEnv`, `probeModels`); once the maintainer sets the key in Secrets it automatically enters the probe rotation. To join the classic-model matrix, also add that gateway's model aliases in [`data/tracked-models.json`](data/tracked-models.json).

**Share a report** — copy `report.json` into `web/reports/` and open a PR, or run `node scripts/publish-report.mjs <report.json>` (auto-archives + verifies there are no leaked keys).

**Local high-frequency recorder (macOS)** — `cp .env.example .env`, fill in your key → `./scripts/install-recorder.sh` (a launchd timer probes every 600s to add a local/CN direct-connection viewpoint).

Full contribution rules and trustworthiness invariants are in [CONTRIBUTING.md](CONTRIBUTING.md).

---

## 🔭 Landscape & references

Where we sit: **user-perspective, black-box, trust-first** benchmarking of OpenAI-compatible gateways/relays — serverless, data-as-repo. We borrow ideas from others and build our own.

**Companion tools (same author)** — to pick a gateway first: [awesome-ai-gateway](https://github.com/cuihuan/awesome-ai-gateway) (a curated list + reproducible cost benchmarks + compliance/security scorecards); to just check "is a model live, and how fast": [modelprobe](https://github.com/cuihuan/modelprobe) (zero-dependency Go prober you drop into CI/cron). This project focuses on **black-box probing of gateway behavior with your own key** — together the three form a "pick → benchmark behavior → probe availability" toolkit.

- **Model & provider benchmarks** — [Artificial Analysis](https://artificialanalysis.ai) (quality/price/speed across providers, the gold standard), [LMArena](https://lmarena.ai) (human-preference Elo), [OpenRouter Rankings](https://openrouter.ai/rankings) (real traffic), [LiveBench](https://livebench.ai), [BFCL function-calling leaderboard](https://gorilla.cs.berkeley.edu/leaderboard.html).
- **Fidelity & anti-fraud** — [K2 Vendor Verifier](https://github.com/MoonshotAI/K2-Vendor-Verifier) (cross-provider tool-call diffing for the same model), api-check (`system_fingerprint` consistency).
- **Gateway & router landscape** — [OpenRouter](https://openrouter.ai) (aggregator, mind the 5.5% top-up fee), [LiteLLM](https://github.com/BerriAI/litellm) (open-source self-hosted, 100+ providers), [Portkey](https://portkey.ai), [Helicone](https://helicone.ai), Eden AI.
- **CN relay reviews** — helpaio and others (the inspiration for this project's "Pick-for-me / Quick-rank / Lenses" information architecture).
- **Probing & quality tools** — [llmperf](https://github.com/ray-project/llmperf) (TTFT/throughput conventions), [promptfoo](https://github.com/promptfoo/promptfoo) (quality assertions), [litellm price library](https://github.com/BerriAI/litellm) (official-price data source).

---

## Fairness · Methodology

- The probe scripts, detection prompts, decision thresholds, raw data, and aggregation logic are **all open source** — anyone can reproduce them with their own key.
- The leaderboard has **no black-box weighted score**; each dimension is its own column. Policy claims must carry an **evidence link + date**; when missing they are recorded as "—" and **never fabricated**.
- When the maintainer has a conflict of interest with a gateway, it is **disclosed** inline in the entry.
- **Standing disclosure:** the maintainer runs [Runix](https://runixcloud.io), a commercial LLM gateway. It is **not** benchmarked here and holds no entry on the leaderboard — a maintainer publishing numbers for their own gateway alongside competitors is not a number anyone should trust. The probe scripts work against it the same as any other endpoint if you want to run them yourself with your own key.

Methodology in brief — every 6h via GitHub Actions, fixed-prompt streaming requests, 3 samples/model reported as percentiles, concurrency ≤4 (this is dial-testing, not load-testing); time-of-day profiling uses real timestamps to account for cron jitter. Full definitions: [docs/methodology.md](docs/methodology.md).

## License

MIT
