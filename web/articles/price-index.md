When picking a gateway, the pricing page is the column easiest to compare — and easiest to misread. One site lists only "Claude Sonnet 4.5 input $1.5", half the official price, and you think you scored; another cuts input to 30% but raises output, and a single number tells you nothing about overall cheap-vs-pricey. Never mind that the same name can hide a cache price, tiered multipliers, and hidden discounts.

We want a **single comparable number**: compress this gateway's overall deviation from official prices into one multiplier you can compare across models and across gateways. That's the price index.

## How it's computed

Three steps, all inside `priceIndex()` in `probe/aggregate.mjs`, reproducible:

**Step 1: anchor.** Official prices come from [litellm](https://github.com/BerriAI/litellm)'s open price library (`model_prices_and_context_window.json`), unified to `USD / 1M tokens`, split into input and output numbers. litellm is community-maintained and third-party neutral; we never use any gateway's self-reported "official price" as the denominator.

**Step 2: per-model multiplier = the arithmetic mean of the input ratio and the output ratio.**

> per-model multiplier = (gateway input price ÷ official input price + gateway output price ÷ official output price) ÷ 2

Why an arithmetic mean rather than summing input and output and then comparing? Because many channels deliberately use **asymmetric pricing**: slash input, quietly raise output. The arithmetic mean normalizes each side first and then combines, so one side's absolute amount (output is usually several times pricier) doesn't dominate the whole ratio.

**Step 3: geometric mean across models.** A gateway carries several models at once; each model yields a multiplier, and the geometric mean of them gives this gateway's price index:

> price index = exp( Σ ln(per-model multiplier) / model count )

We use the geometric rather than arithmetic mean because the multipliers are **ratios**: one model at 0.5× (half price) and another at 2.0× (double) would give an inflated 1.25× by arithmetic mean, while the geometric mean gives `sqrt(0.5 × 2.0) = 1.0`, correctly reflecting "even overall". Cheap and pricey are symmetric in log space, so no single outlier model skews it.

Only models for which we have both the official price (litellm has this model) and the gateway price enter the calculation; if one side is missing the model is skipped, never padding it with incomparable models.

## How to read the number

- **= 1**: on par with official prices.
- **< 1**: cheaper than official overall (0.8 is about 20% off).
- **> 1**: pricier than official overall — an enterprise channel doing compliance, invoices, and SLAs being a bit pricier is reasonable.

The price index answers "is it cheap", **not "is it worth it"**. That's where it's most easily abused.

## Suspiciously cheap, be wary

Below **0.5×** (under half the official price) should set off a red light. The official upstream's cost is what it is; anything that can sustainably do under half price long-term is either burning money on subsidies or isn't running on official routing: account pools, reverse interfaces, multi-layer resale, free-tier farming. Such channels often come with model substitution, stripped tools, quantization degradation, and inflated tokens.

> CISPA's audit *Real Money, Fake Models* gives the quantitative footnote: among sampled endpoints, **45.83% fail model-fingerprint verification**, and paid usage actually delivers only about **38%** of the claimed tokens. However low the list price, getting 38% of the tokens means the real price per effective token is actually higher.

So the price index **must be read alongside the behavioral check** — never place an order on a single number. Cross-reference it with these columns:

- model echo, CJK integrity, context truncation — see [behavior-fingerprint](model-substitution), to confirm whether you're buying the real model;
- usage-recomputation fingerprint (`charsPerToken` unusually low = suspected inflated tokens) — see [usage-fingerprint](billing-traps), to confirm the cheapness isn't from under-counting tokens;
- 30/7-day rolling success rate and error breakdown — see [stability](stability-and-exit-risk), to confirm the price of cheapness isn't daily 429s.

A 0.45× with an all-green behavioral check and a long-term stable success rate may be a genuine subsidy; a 0.45× with mismatched model echo and low token counts is a fake bargain.

## Two more numbers that can deceive you

- **Cache price**: many gateways set the most prominent number on the pricing page to the post-cache-hit price, billing the full price or even higher on a miss. litellm's official price is the standard price, so a cache discount makes the gateway's column look anomalously low. The price index takes the gateway's published standard price, but you still need to go to the pricing page and confirm whether that low price is the cache price.
- **Hidden multipliers**: a few channels show a low face price but scale it up by a factor at settlement, or set separate multipliers for long context or specific models. This black box can't be read from a price API and falls under the manual-annotation category of "billing transparency".

## Your action plan

1. **Use the index to locate the band first**: > 1 pricey, 0.5–1 normal, < 0.5 anomalous.
2. **For anything anomalous, immediately flip to the three behavioral-check columns**: echo, CJK, token fingerprint — if any one isn't green, the cheapness isn't trustworthy.
3. **Go back to the pricing page to verify the cache price/multiplier**: confirm the standard price the index used is the price you'll actually pay.
4. **Don't sort by the price index to pick a gateway**: it's one reference column, not a total score. We do no black-box weighted score, and **cheapest ≠ best**.
