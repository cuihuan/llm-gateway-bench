What you top up isn't tokens — it's the gateway's "right to interpret" tokens. For the same request, the official API charges you 1,200 prompt tokens while some relay charges 1,900; the streaming endpoint reports a 90ms TTFT while the first character actually takes 6 seconds; a 128K window swallows your input and silently drops the opening section. None of these three throw an error, the bill gets paid, the job gets done — except what you paid and what you got don't match.

CISPA's paper *Real Money, Fake Models* quantified that gap: pay $14.84 at official prices, and the tokens you actually receive are worth only $5.70–7.77 — **about 38% of what you paid**. The problem isn't that one particular shop is crooked; it's that this OpenAI-compatible proxy layer is by nature a man-in-the-middle that can rewrite both billing and content. Below we break down the three most common billing/quality traps and how to expose them with black-box probing.

## Trap 1: inflated token usage and hidden system-prompt injection

Billing is per token, and the token count is reported by the gateway — whatever it says, goes, and you can rarely verify it on the spot. Two moves both make you pay more:

- **Privately tweaked multiplier**: one Chinese character should be roughly 0.6 tokens, but gets counted as 1.5, doubling `completion_tokens` out of thin air.
- **Hidden system-prompt injection**: a large system prompt is secretly prepended to your request, inflating `prompt_tokens` and charging extra on every call.

The platform catches both with a **usage-recomputation fingerprint** — not by trusting claims, but with two cross-checkable numbers:

- `charsPerToken` (characters per token) = actual response body characters ÷ reported `completion_tokens`. Under a fixed prompt, this value should stay relatively stable for the same model. An **unusually low** value at some gateway means it counted more tokens for the same text = suspected inflation.
- `promptTokens`: the median `prompt_tokens` the gateway reports under a fixed prompt. **Far above the baseline for the same model** means something you didn't write got stuffed into your request = suspected hidden injection.

In implementation, the probe sends a fixed task ("list the words for one through fifty in English", with a random request id to defeat caching), accumulates `outputChars` chunk by chunk, then cross-checks against `usage.completion_tokens` to compute `charsPerToken` (taking the median; see `probe/metrics.mjs`).

> This is a fingerprint, not a verdict: a single gateway's absolute value tells you little — it's meaningful only **compared horizontally against other gateways for the same model, and vertically against the official baseline**. The platform first settles the raw signals into data, and leaves the judgment to you.

## Trap 2: fake streaming

Real streaming is the model emitting text as it generates: small TTFT (time-to-first-token), with content arriving steadily across the whole generation. **Fake streaming** is the gateway buffering the entire reply in the background, then slicing it into chunks and dumping them on you all at once, disguised as an SSE stream — the goal is to hide the truth about queuing and a slow upstream.

Its behavioral fingerprint is unmistakable: **the first character takes a long time, but all the content arrives in a single instant**. The platform times each chunk and records two quantities: `ttftMs` (the arrival time of the first content chunk) and `streamWindowMs` (the window from the last chunk minus the first chunk). The decision thresholds (`isBurstStream`):

- chunk count ≥ 5 (too few and we don't judge, to avoid noise)
- `streamWindowMs` ≤ 250ms (content dumped within a tiny window)
- `ttftMs` ≥ 800ms **and** ≥ 4 × the window (the wait for the first character far exceeds the time spent emitting)

These thresholds won't misfire on the extremes: **fast but real streaming** (e.g. LPU inference) has tiny TTFT and never reaches the threshold; **slow but real streaming** has a naturally large window so the ratio doesn't hold. Only "buffer then dump" satisfies all three at once.

## Trap 3: silent context truncation

Long context burns the most upstream cost, so some gateways quietly trim it — keeping a tail window and dropping the opening section outright. The request doesn't error, the model answers as usual — it just never saw what you wrote earlier.

The platform catches this with **needle detection**: it buries a unique UUID (e.g. `NDL-XXXXXXXX-XXXX`) at the **12% mark** of roughly 3.5K tokens of filler text, then asks the model to read that marker back verbatim. If the gateway truncates from the tail, this needle falls before the cut point and is **deterministically lost** — the answer won't contain it (`evalNeedle`). Burying it near the front is precisely to trigger the most common form of truncation: keeping the tail window.

## Reading the matching columns on the leaderboard

| What you're worried about | Which column | How to read it |
|---|---|---|
| Inflated tokens | `charsPerToken` | **Clearly lower than peers** for the same model = suspected inflation; click in to see the two raw columns |
| Hidden injection | `promptTokens` | **Clearly higher than baseline** for the same model = suspected hidden system-prompt injection |
| Fake streaming | `streamBurst` (suspect/total) | A high suspect ratio = repeated probes all look like buffer-then-dump |
| Billing verifiability | `usageReportedRate` | If a gateway streams without usage, you can't even recompute |
| Context truncation | `needle` (ok/total) | ok < total = some samples can't read the needle back, suspected truncation |

The reading matches the platform's consistent stance: **don't look at a single run, look at sustained behavior over many runs**; presume nothing, but keep "verified" and "unverified" clearly apart. For the dimension breakdown see [Evaluation methodology](methodology-trust).

## Reproduce it with your own key

The whole logic is open source, the decision functions are pure functions with unit tests, and you can replicate it directly:

1. **Inflated tokens**: send a fixed prompt, divide the response body's character count by the reported `completion_tokens`, then hit your gateway and the official API with the same prompt and compare `charsPerToken`.
2. **Fake streaming**: under `stream: true`, timestamp each chunk and compute TTFT and the first-to-last chunk window — buffer-then-dump shows TTFT almost equal to total latency at a glance.
3. **Truncation**: bury a random string near the front of a long text, ask the model to read it back verbatim; if it can't, you got truncated.

The action plan is simple: attach your own key to any gateway you plan to rely on long-term, run it for a few days, and watch the **sustained behavior** of the three columns `charsPerToken`, `streamBurst`, and `needle` rather than any single number. For channels that are absurdly cheap, what they save is usually carved out of exactly these three places. Read it alongside [Behavioral fingerprints and channel profiling](methodology-trust) to ground "can I trust it?" in reproducible evidence.
