# Research + design: reorganizing the data around "me vs the best gateway, where's the gap"

> 2026-06-23. Responding to the user's core need: **I just added a new gateway — how do I quickly know how far it lags the best gateway online,
> and where (price / performance / cache / stability / compliance)**. This is the top priority; the eval reports for choosing a gateway/
> model are the upper layer. This document first diagnoses the data organization, then gives the reorganization and the "gap check" design as the implementation guide.

## 1. Core user job (JTBD)

> "I plugged in a new gateway. Is it any good? Where does it lag the best — is it pricey, slow, or degraded?"

The one-sentence output: **a gap check card** — per dimension, give "your value / the best value / gap% (ahead or behind)",
so the user grasps "where I lag and by how much" in 5 seconds. This hits the goal more directly than a big side-by-side table.

## 2. Diagnosis: why the status quo feels "messy"

The data assets are organized by different primary keys, **with the main axis being "gateway", while the user's question's main axis is "model × dimension → who's best"**:

| File | Organizing primary key | Serves |
|---|---|---|
| `data/gateways.json` | Gateway | Registry |
| `data/tracked-models.json` | Model (with each gateway's alias) | Price scraping / matrix-target resolution |
| `data/prices.json` | Model × gateway cell | Price |
| `data/results/*.json` | Time (run) → gateway → model | Raw probes |
| `web/data.json` | **Gateway** (aggregated leaderboard) | Gateway-centric ranking |

**The mismatch**: the user wants "**given the model I use, who's best per dimension, and how far do I lag**" (comparison-centric,
model × dimension), while the leaderboard is gateway-centric. A first-class concept is missing: **Best-of (the optimal value and optimal gateway
for each model × each dimension)**, and **Gap (drop your gateway in and compute the gap)**.

## 3. Reorganization plan: introduce two derived views, Best-of and Gap

Without overturning the underlying files (each has its own purpose), add two **derived views** at the aggregation layer to shift the main axis to comparison:

1. **Best-of view** (`bestOf`): for each tracked model × each dimension, compute "the optimal value + optimal gateway".
   - Price: the lowest (in+out) across gateways for that model in `prices.json`; anchor with the official price.
   - Speed/stability: from the public baseline in `web/data.json` (**gateway-level cross-model aggregation**, honestly labeled as such).
   - When sources are mixed, each dimension clearly states whether it's "measured for that model" or a "gateway-level reference".
2. **Gap view** (`buildGap`): given "your gateway"'s measurement on a model + Best-of, compute per dimension
   `{ dimension, your value, best value, best gateway, gap%, verdict (ahead/even/behind) }`, plus a one-sentence overview.

## 4. The gap check card: dimensions and conventions

| Dimension | Source of your value | Source of the best | Lower is better? | Verdict |
|---|---|---|---|---|
| **Price** | Your gateway's price for that model (--price-in/out or cells) | Lowest price across gateways for that model | Yes | Multiplier / Δ% |
| **TTFT** | This run's measured p50 | The baseline's fastest gateway | Yes | Δ% |
| **Throughput tok/s** | This run's measurement | The baseline's highest | No | Δ% |
| **Stability** | This run's success rate / baseline uptime | The baseline's highest uptime | No | Δ percentage points |
| **Cache** | Prompt-cache hit (usage.cache_read_tokens / repeated-prompt TTFT drop) | The best among those supporting cache | — | Supported/unsupported (**to be measured**, see §6) |
| **Compliance fingerprint** | This run (echo/CJK/needle/tool/fake-streaming) | All passing | — | Whether you missed any item |

**Verdict thresholds**: |Δ| < 8% records "even"; otherwise "ahead/behind X%". Price uses the multiplier, performance uses the relative gap.
**Honest labeling**: price is an exact comparison for that model; the "best" for speed/stability is currently a gateway-level aggregated reference, noted on the card.

## 5. Information architecture (three layers, from core to periphery)

- **Layer 0 (core, new) · Gap check**: at the **top** of `compare` / the report, first give the "you vs best" gap card +
  a one-sentence overview ("30% pricier than the best, 40% slower TTFT, even on the rest"). This is the answer the user wants at first glance.
- **Layer 1 · Detailed comparison**: the existing side-by-side table (speed/price/fingerprints/baseline reference) as the supporting expansion.
- **Layer 2 · Selection reports**: the leaderboard, model evals, classic-model × gateway matrix — the upper-level thinking of "which gateway/model to choose".

## 6. The cache dimension (named by the user) — feasibility

Black-box-measurable signals for prompt caching: ① the `cache_read_input_tokens` /
`prompt_tokens_details.cached_tokens` in the response `usage` (OpenAI / Anthropic style); ② send the same long prompt twice,
and the second's TTFT/price drops significantly. **P1**: first collect usage's cached fields in the probe (zero-cost piggyback),
and fold it into the gap card once there are enough samples. This version reserves the dimension slot and labels it "to be measured".

## 7. Implementation plan (this version does the core first)

1. `report.mjs`: pure functions `buildBestOf` + `buildGap`; render the "gap check card" at the top of the compare report. ✅ this version
2. `compare.mjs`: mark the ad-hoc (`--url`) target as "your gateway", pass in `mine`; the baseline is the Best-of speed/stability source. ✅ this version
3. Unit tests covering best-of / gap / rendering. ✅ this version
4. (Later) cache-dimension collection; upgrade Best-of to model-level speed (needs real matrix data).
