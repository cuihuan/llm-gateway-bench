A relay API that's half the price sits in front of you, and before you nod, the question you really should ask isn't "which models does it support" but four harder ones. CISPA's audit *Real Money, Fake Models* offers a set of cold numbers: **45.83% of relay endpoints fail model-identity fingerprint verification**, and paying official prices gets you only about **38% of the tokens**; of the 92+ relay products surveyed, most have no company registration and no ICP filing. Anyone can write a claim, so this framework asks only one thing — **does the behavior match?**

We break selection into four questions, each of which maps to a concrete column on the leaderboard.

## Question 1: is it giving you the real model?

A relay's most common move is selling a cheap model under the Claude/GPT name, or "probabilistic downgrading" — quietly routing a fraction of requests to a cheaper or quantized version. This **can't be proven by claims**; it can only be profiled with a combination of black-box fingerprints:

- **Model echo check**: does the `model` field in the response match what you requested?
- **Tool-call forwarding**: for a request carrying a `tools` definition, does the model return a valid JSON call, or were the fields quietly stripped (the K2 Vendor Verifier approach)?
- **CJK output integrity**: is the Chinese corrupted, escaped as `\u` literals, or full of replacement characters — the classic tell of quantization degradation?
- **Context-truncation needle**: bury a UUID in long filler and ask for it back verbatim; a tail cut drops it.

These map to the **Trust & integrity** and **Behavioral check** column groups on the leaderboard. See [Model substitution and degradation: how to detect it black-box](model-substitution).

> Red line: when multiple behavioral-check items go red (tools stripped + CJK corrupted + needle lost all at once), you can basically conclude it isn't a direct connection to the official upstream.

## Question 2: is it overcharging you?

A cheap price isn't the same as good value; look at it in two layers. The **list-price** layer is measured by the price index: gateway price ÷ official price for the same model (official price from the litellm open price library), with input/output ratios averaged arithmetically and then geometric-mean'd across models — `<1` is cheaper, `>1` is pricier. The **actual-pay** layer looks at the usage-recomputation fingerprint:

- `charsPerToken` (characters per token) unusually low = suspected inflated token usage;
- `promptTokens` far above baseline = suspected secret injection of a hidden system prompt;
- whether streaming carries usage at all, which determines whether you can even audit the bill.

These map to the **Price index** column and the usage fingerprint. See [How the price index is computed and read](price-index) and [Billing traps: inflated tokens, fake streaming, context truncation](billing-traps).

> Red line: **suspiciously cheap (price index < 0.5×)**. A direct official connection can't sustainably sell at a loss; below 0.5× either means inflating tokens to claw back the difference, or swapping in a cheaper model.

## Question 3: is it stable, and will it vanish?

This is the long-term value of accumulated data — **a new shop can't fake history**. Look at three kinds of signal:

- **30/7-day rolling success rate** (with the probe key's 401/403 auth failures already excluded);
- **Error breakdown**: 429 rate-limits, 5xx outages, and timeouts read separately — they mean completely different things;
- **TTFT trend** and **time-of-day profile**: aggregated by UTC hour, peak drift = slowest-hour ÷ fastest-hour TTFT; `≥2×` means you get throttled at peak.

These map to the **Stability** panel. See [Stability and exit risk: the time series is the moat](stability-and-exit-risk).

> Red line: **a new shop with no history**. A two-week-old site, however pretty its success-rate curve, is unconvincing — stability is about sustained behavior over many runs, not a single snapshot.

## Question 4: is it compliant?

Exit scams, no invoices, prompts logged for training — these all live in this layer. This part can't be auto-probed; the platform uses **manual annotation + evidence links**: channel origin, data-retention policy, and legal-entity qualifications each carry a link to the original text and an annotation date, and corrections are accepted via PR. Ratings have only three tiers — `verified` / `claimed but unverified` / `unverified` — and anything missing an evidence link never gets `verified`. See [How we probe, and why it's trustworthy](methodology-trust).

## A decision flow

Walk it in this order; stop at any step that hits a red line:

1. **Start with the price index** — below 0.5× is an immediate warning; proceed to step 2 for a closer look.
2. **Check the behavioral panel** — tool calling / streaming authenticity / CJK / needle multiple reds → eliminate.
3. **Inspect the usage fingerprint** — `charsPerToken` low or `promptTokens` above baseline → the actual pay isn't trustworthy.
4. **Look at the stability history** — without 30 days of data, wait and watch; with data, read the error breakdown and peak drift.
5. **Check the trust annotations** — legal-entity qualifications / data retention are a veto against your own compliance requirements.
6. **Canary at low volume** — even if all the above pass, run a week of real traffic before switching your main path over.

This framework does no black-box weighted score and presumes no guilt — you sort and weigh each column yourself. It insists on only one thing: **don't read the claims, read sustained, repeatedly stable behavior.**
