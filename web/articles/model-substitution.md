You topped up at a relay, your request says `claude-sonnet`, and the menu lists `claude-sonnet` too. But you can't see the upstream bill, you can't see the real routing, and the only thing you can verify is that returned text. **Whether the model is right, whether it was quietly swapped for a cheaper one, whether it's running on quantized weights — it all comes down to black-box inference.**

This isn't paranoia. CISPA's audit *Real Money, Fake Models* probed a large number of public endpoints, and the conclusion is striking:

> **45.83% of relay endpoints fail model-identity fingerprint verification**, with performance deviation up to 47.21%; pay $14.84 at official prices and you get back only about 38% of the effective tokens.

## Substitution, downgrade, quantization: three techniques

Their goal is the same — take the money you paid for model A and serve you at model B's cost — but they show up differently:

- **Outright substitution**: you request `gpt-5`, the backend hands it to some open-source substitute. The crudest, and the easiest to catch.
- **Probabilistic downgrade**: most requests route honestly, but **only at peak or a random fraction** get tossed to a cheap model. A single test won't catch it; you need sustained, repeated probing to see the distribution.
- **Silent quantization**: still that model, but running on Int4/FP4 quantized weights to save VRAM. The name doesn't change, the echo doesn't change — **it only slips at the edge of capability**, the classic tell being Chinese (CJK) output degrading into garbage, `\u` literal escapes, or the replacement character `�`.

This is exactly why the platform **does no single-snapshot scoring** but probes continuously every 6 hours, settling a time series: intermittent substitution is only visible on the curve.

## How the platform measures: four kinds of black-box fingerprint

We don't trust claims, we watch behavior. To identify substitution/degradation, we rely on a combination of zero-cost (piggybacking on existing probes) hard signals, not any single metric.

**1. Model echo check** — the cheapest hard evidence. Compare the `model` field in the response against what you requested. Requesting `deepseek-v4-flash` but getting a different family echoed back is direct evidence. The implementation normalizes (lowercase, strip separators and vendor prefixes, tolerate version suffixes like `-0528`) and requires one to be a substring of the other to count as a match; a missing echo is recorded as "indeterminate" — **not evidence, and no presumption of guilt**. The leaderboard reports `modelEchoRate`, and below 1 means some samples echoed a model that didn't match the request.

**2. CJK output integrity** — the tell of quantization degradation. The probe asks the model to output Chinese, then checks:

- the replacement character `�` appears → encoding corruption, fail;
- ≥3 literal `\uXXXX` escapes → not decoded correctly;
- almost no Chinese characters → answered off-topic.

Int4/FP4 quantization often degrades exactly this way on CJK — the name can fool you, but the glyphs can't fool a regex.

**3. Tool-call forwarding check** (approach from [K2 Vendor Verifier](https://github.com/MoonshotAI/K2-Vendor-Verifier)) — send a request with a public `tool` definition and see whether the model returns a **valid JSON call** for that tool. Reverse/resale channels commonly strip the `tools` field outright, a hard signal of channel quality.

**4. Fake streaming and latency signature** — a substituted path often comes with "fake streaming" that buffers the whole reply then dumps it at once. Per-chunk timing identifies it (see [Fake-streaming detection](billing-traps)).

> Channel origin **can't be directly proven**. The platform's stance is a **combination of behavioral fingerprints**: echo, CJK, tool calls, latency signature — multiple black-box signals jointly profile a gateway, without relying on the gateway's self-declaration and without a black-box weighted score.

Further official-API diffing (LLMmap-style 8-question identity fingerprinting, diffing finish_reason / JSON schema against the official API) is on the roadmap; the idea is likewise "compare the distribution against the official gold standard", not guesswork.

## How to read the "behavioral check" panel

These signals are **separate columns** on the leaderboard — don't go looking for a single total score:

- **Model echo**: ideal is 1. Below 1, or showing `echo X ≠ request Y`, blacklist that (gateway, model) outright.
- **CJK integrity**: a failure suggests suspected quantization or non-native weights.
- **Tool calls**: a failure means tools got stripped — don't pick it for Agent work.
- All these columns must be **read against the time series**: a one-off may be network jitter, but **sustained, repeatedly stable anomalies** are categorical evidence. We look at sustained behavior, not a moment's luck.

## Self-check tips for readers

With your own key, you can do a round in five minutes:

1. **Compare the `model` field**: send a request and see whether the `model` in the returned JSON is the one you ordered.
2. **Force it to speak Chinese**: ask for a long Chinese output and eyeball it for `�`, `\uXXXX`, or inexplicable garbage.
3. **Try a tool call**: include a `tools` definition and see whether the model returns valid `tool_calls`, or pretends not to notice.
4. **Hit it several times, off-peak too**: a few rounds at midday peak and a few late at night — probabilistic downgrade only shows up once the sample count rises.
5. **Don't trust the menu name alone**: a model is real only if its capability matches; the name is worthless.

If any one of these consistently fails, don't use it no matter how cheap — the money you save comes back as "38% tokens actually received". Further reading: [usage recomputation: catching inflated tokens](billing-traps), [how the trust rating is assigned](methodology-trust).
