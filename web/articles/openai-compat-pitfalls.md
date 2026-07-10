"OpenAI-compatible" is a relay's standard selling point — swap the `baseUrl`, reuse the same SDK, and it looks seamless. But **what's compatible is the interface shape, not the behavior**. That a request goes out and a chunk of JSON comes back doesn't mean the field semantics, streaming timing, and billing conventions match the official API. Many "voodoo bugs" — Agent tool calls that work sometimes and not others, usage that doesn't reconcile, streaming that stalls — are all rooted in these inconspicuous differences at the protocol layer.

This piece breaks down the most common protocol pitfalls and how they map to metrics the platform already measures.

## Pitfall 1: tool_calls stripped or non-conformant IDs

OpenAI's tool-calling contract is specific: `finish_reason` must equal `tool_calls`, each call must have a valid `function.name` and `arguments` that `JSON.parse`, and `tool_call_id` has a fixed prefix format. Relay/reverse channels commonly have two kinds of problem:

- **Swallowing tools outright**: you passed a `tools` definition, but the gateway dropped it when forwarding upstream, the model acts as if it never saw it and returns plain text — the Agent chain breaks on the spot.
- **Non-conformant IDs or schema**: it returned `tool_calls`, but `arguments` isn't valid JSON, or the ID prefix doesn't match, and the client SDK throws a parse error.

The platform's **tool-call forwarding check** targets exactly this: send a request with a public `tool` definition and judge whether the model returns a valid JSON call for that tool (approach from [K2 Vendor Verifier](https://github.com/MoonshotAI/K2-Vendor-Verifier)). If you're building Agents, eliminate any gateway that fails this column. See [Model substitution and degradation: how to detect it black-box](model-substitution).

## Pitfall 2: usage field missing or untrustworthy

Under `stream_options.include_usage`, an OpenAI streaming response gives a final chunk carrying `usage`. Many relays **don't return usage when streaming** — the consequence is you **can't reconcile billing**, and throughput tok/s can only be roughly estimated from chunk counts, which is inaccurate.

Worse is usage that **is returned but untrustworthy**: a privately tweaked multiplier inflating tokens, or a system prompt secretly injected before your prompt to bloat `prompt_tokens`. The platform watches two metrics: the **usage report rate** (whether streaming carries usage at all) and the **usage-recomputation fingerprint** (`charsPerToken` unusually low = suspected inflation, `promptTokens` far above baseline = suspected injection). See [Billing traps: inflated tokens, fake streaming, context truncation](billing-traps).

## Pitfall 3: non-conformant streaming — fake streaming and chunk timing

SSE streaming is meant to emit text as it's generated. The most typical non-conformant implementation is **fake streaming**: the gateway buffers the whole reply in the background, then slices it into chunks and dumps them at once, disguised as a stream. The tell is that TTFT (time-to-first-token) almost equals the total latency, with all content arriving in a single instant.

This isn't just an experience issue — it hides the truth about "slow upstream / queuing" and makes you think it's fast. The platform timestamps each chunk and uses the relationship between TTFT and the first-to-last chunk window to judge fake streaming (`isBurstStream`); neither fast-but-real streaming nor slow-but-real streaming gets misfired. For the principle see [Billing traps: inflated tokens, fake streaming, context truncation](billing-traps).

## Pitfall 4: model echo and context window

Two quiet pitfalls:

- **`model` echo doesn't match**: the `model` field in the response JSON should echo the model you requested. A mismatch (request A, echo B) is direct hard evidence of substitution — the platform's **model echo check** catches it at zero cost, piggybacking on the stream.
- **A context window in name only**: claims 128K but silently truncates to save upstream cost. The platform verifies this with needle detection (bury a unique marker in a long text and ask for it back verbatim); tail truncation makes the marker deterministically disappear.

## Pitfall 5: cross-format translation — the hardest path (Claude Code → an OpenAI model)

Pitfalls 1–4 assume the client and the upstream speak the same wire format and the gateway just relays. The bugs that actually eat a weekend come from **cross-format translation**: the client speaks one format (the Anthropic Messages API — what Claude Code and the Anthropic SDK emit) while the upstream speaks another (OpenAI). The gateway has to translate the request down *and* the response back up — remapping tool-call ids, streaming event shapes, and usage fields between two incompatible schemas. "Point Claude Code at an OpenAI model through gateway X and the tool calls break" is the single most-filed version of this complaint.

The platform measures it the same black-box way (`probe/xformat.mjs`): drive the gateway's **Anthropic** endpoint (`POST /v1/messages`) against a mock OpenAI upstream, then check what comes back as Anthropic events — a `tool_use` block with a **parsed `input` object** (not a raw JSON string), a `content_block_delta` stream that reassembles to the sent text, and a final `message_delta` carrying `usage.output_tokens` so the Anthropic-path bill can be reconciled.

**Measured across three self-hostable OSS gateways (2026-07-10, neutral CI runner).** Each was driven through its own Anthropic endpoint against the same mock OpenAI upstream:

| Gateway | Cross-format | What happened |
|---|---|---|
| **LiteLLM** 1.91.1 | **3/3** | `/v1/messages` → tool_use, streaming and usage all survive the translation |
| **Bifrost** (latest) | **3/3** | `/anthropic/v1/messages` → all three survive |
| **Portkey Gateway OSS** 1.15.2 | **not offered** | its `/v1/messages` is Anthropic-provider-only — with an OpenAI provider it rejects the request outright (`messages is not supported by openai`) |

So if you point Claude Code / the Anthropic SDK at an OpenAI-format model, **LiteLLM and Bifrost both do the translation cleanly**; Portkey OSS doesn't expose that path in the header-config self-host mode (you'd route through its OpenAI endpoint instead, giving up native Anthropic-client compatibility — and its hosted product may differ).

**One finding worth pinning your version for:** which code path a gateway takes for `/v1/messages` can change between releases. LiteLLM ≤ 1.57.x translated Anthropic → OpenAI **Chat Completions** (that path scores **2/3** — it silently drops streaming `usage`); LiteLLM ≥ ~1.9x rewrote the passthrough to route through the OpenAI **Responses API** (upstream `/v1/responses`), which is 3/3 against a Responses-capable upstream but raises `KeyError('created_at')` against a **chat-completions-only** one — so the call fails before any translation is attempted. Bifrost likewise goes through the Responses API. Pin the gateway version when you validate cross-format; the transport underneath `/v1/messages` is not stable.

A note on fairness: a gateway that **doesn't offer** the path (Portkey's explicit rejection, or an absent endpoint) is recorded as *unsupported*, and a **setup/compat error** that yields no clean measurement as *inconclusive* — neither is ever published as a `0/3`, which is reserved for a gateway that genuinely mangles a valid translation.

## How to use this piece

Next time you onboard a new gateway, don't just verify "does it run" — go through the protocol layer item by item:

1. **Tool calls**: send a request with `tools` and check whether `finish_reason` and `arguments` are conformant;
2. **usage**: turn on `include_usage`, confirm the streaming tail really has usage, and check it against a local token estimate;
3. **Streaming timing**: timestamp each chunk and see whether TTFT roughly equals total latency (a fake-streaming signal);
4. **model echo**: verify the `model` field in the response;
5. **Context**: bury a random string near the front of a long text and have it read it back;
6. **Cross-format** (if you route Claude Code / the Anthropic SDK to a non-Anthropic model): hit the gateway's `/v1/messages` and confirm `tool_use.input` is a parsed object, the stream is real Anthropic events, and the final `message_delta` carries `usage.output_tokens` — pinning the gateway version as you do.

The platform measures all six automatically, mapping to the columns of the **behavioral check** panel — but you can absolutely reproduce them with your own key; see [Open-source tooling and self-hosted probing: bring this into your own environment](self-host-probing). Back to the selection big picture: [The complete analysis framework for choosing an LLM gateway](choosing-a-gateway).
