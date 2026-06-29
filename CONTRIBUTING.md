# Contributing Guide

This is a **serious benchmark tool**, and its credibility rests entirely on data being traceable and reproducible. The single most important principle:

> **Never fabricate. Every number is either black-box probed by the scripts or backed by a citable public source; when unsure, leave it empty (`null` / `—`) — never make it up.**

This principle isn't a slogan — it's encoded into CI by `probe/data.test.mjs`: a benchmark score without a source makes `npm test` fail outright.

## Repository structure

| Path | Purpose |
|---|---|
| `probe/probe.mjs` | Prober CLI (`node probe/probe.mjs --help`), black-box probing of OpenAI-compatible endpoints |
| `probe/metrics.mjs` | Pure decision functions (fake streaming / CJK / needle / model echo / usage / price-value…), all unit-tested |
| `probe/aggregate.mjs` | Aggregates `data/results` + `annotations` + `prices` + `models` → `web/*.json` |
| `data/gateways.json` | List of gateways under test (self-service PR submissions) |
| `data/models.json` | Model-eval dataset (official list prices + traceable benchmarks) |
| `data/annotations/` | Manual trust/compliance annotations per gateway (with evidence links) |
| `web/` | Static site (leaderboard + model evals + behavioral check + analysis framework) |

## Running tests

Zero dependencies, Node ≥ 20:

```bash
npm test        # metrics / aggregate / prices / probe / data contracts
npm run aggregate && npm run serve   # build and serve the site locally to see the result
```

A push / PR automatically triggers [`ci.yml`](.github/workflows/ci.yml) to run the same test suite.

## Adding a gateway

PR [`data/gateways.json`](data/gateways.json). Each entry must contain at least:

- `id` (unique), `name`, `website`
- `baseUrl` (**must be `http(s)://`**, the OpenAI-compatible root; the prober will hit `/v1/...`)
- `authEnv` (the name of the environment variable holding the key; keys go only into GitHub Secrets, **never into the repo**, and a gateway missing its key is skipped automatically and not counted as a failure)
- `probeModels` (an array; pick 1–2 cheap models), `pricingUrl`, `tags`

Once the maintainer configures the key in Secrets, it automatically enters the every-6-hours probe rotation.

## Adding / correcting models and prices

PR [`data/models.json`](data/models.json). Prices are **official list prices**; each entry carries a `source`, and local/free models are recorded as `0`. Fields: `id` (unique), `name`, `vendor`, `input`, `output` (USD/1M, non-negative), `kind`, `source`.

## Adding benchmark scores (the strictest part)

When adding `bench` to a model, you **must** satisfy the following (or CI goes red):

- At least one numeric score (`mmluPro` / `gpqa` / `swe` / `aime`), in the range 0–100;
- `src` (source name) + `srcUrl` (an **`http(s)` link**) + `asOf` (collection date).

```json
"bench": { "mmluPro": 75.9, "gpqa": 59.1, "swe": 42.0,
           "src": "DeepSeek-V3 Technical Report",
           "srcUrl": "https://arxiv.org/abs/2412.19437", "asOf": "2024-12" }
```

If you can't find an exact citation for a score, **don't add it** — better to record `—` in the table. For a complete, up-to-date comparison, cite a dedicated aggregator leaderboard (the page already links out to Artificial Analysis / LM Council / OpenCompass).

## Adding / correcting trust annotations

PR [`data/annotations/`](data/annotations/). For policy-class conclusions (data retention, whether used for training), `evidence` **must be a link to the original terms-of-service text or `null`** — never an empty string; `channel.verify` ∈ `pass/fail/pending/baseline/none`, `status` ∈ `good/warn/bad/unknown`. When the maintainer has a conflict of interest with a gateway, disclose it in `disclosure`.

## A few red lines

- **No black-box weighted score** — each dimension is its own column; readers sort and weigh for themselves.
- **No mixing of probe regions** — gh-us latency ≠ what you feel in CN; columns are split by region.
- **Change the logic, add a unit test** — the decision functions are pure functions, easy to test.
- Raw probe data is committed per run in `data/results/`, fully reproducible and auditable.

For methodology details, see [docs/methodology.md](docs/methodology.md).
