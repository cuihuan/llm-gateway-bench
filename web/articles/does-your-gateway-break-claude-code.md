The single most-filed complaint about AI gateways in 2025–26 isn't "it's slow" or "it's expensive." It's some version of: _I pointed Claude Code at a cheaper model through gateway X, and the tool calls broke._ "claude code" shows up in 400+ LiteLLM issues alone; the top-commented issues on Portkey, OpenRouter and Bifrost are all format-translation breakage.

Almost nobody measures it. So I built a harness that does — black-box, no API keys, reproducible in CI — and pointed it at the gateways people actually run. Here's what came back, and the two things that surprised me.

## The setup (and why it needs no keys)

The trick to measuring a _gateway's_ fidelity without a real model is to make the model a known quantity. A local mock "upstream" returns spec-correct OpenAI responses: a well-formed tool call, a genuine multi-chunk SSE stream, a final chunk carrying `usage`. Then I send matching requests _through_ each gateway and check what actually arrives at the client. Anything dropped or mangled is the gateway's translation layer — not the model, not the network.

Three checks, each mapping to a real bug category:

- **tool_calls** — send a `tools` definition; does a valid tool call come back with parseable arguments?
- **streaming** — request `stream:true`; do ≥2 chunks arrive and reassemble to the sent text (vs collapsed/buffered "fake streaming")?
- **usage** — does a streamed chunk carry token counts, so billing can be reconciled?

I ran it two ways: **passthrough** (OpenAI in, OpenAI out) and the harder **cross-format** path (an Anthropic client — Claude Code — routed to an OpenAI model).

## Surprise #1: an "OpenAI-compatible" gateway silently dropped streaming

Passthrough, on a neutral CI runner (measured 2026-07):

| Gateway | tool_calls | streaming | usage | Score |
|---|---|---|---|---|
| LiteLLM 1.91.1 | ✅ | ✅ | ✅ | **3/3** |
| Bifrost | ✅ | ✅ | ✅ | **3/3** |
| Portkey Gateway OSS 1.15.2 | ✅ | ❌ | ❌ | **1/3** |

All three relay a tool call intact. But Portkey OSS, in self-host custom-host mode, threw an internal error on _every streaming request_ — the client got zero chunks and no usage — while non-streaming worked fine. That's exactly the kind of thing a "does it run?" smoke test never catches: hello-world passes, and then your agent's streaming tool loop breaks in production. (Fair caveat: this is the OSS gateway's self-host custom-host path; Portkey's hosted product / standard integrations may stream fine.)

## Surprise #2: the same gateway, two different transports

Then the cross-format path — Claude Code → an OpenAI model, the hardest translation and the most-filed complaint:

| Gateway | Cross-format |
|---|---|
| LiteLLM 1.91.1 | **3/3** |
| Bifrost | **3/3** |
| Portkey Gateway OSS 1.15.2 | **not offered** |

LiteLLM and Bifrost both translate cleanly — tool_use, streaming and usage all survive the Anthropic↔OpenAI round trip. Portkey OSS's `/v1/messages` turned out to be Anthropic-provider-only: point it at an OpenAI provider and it rejects the request outright (`messages is not supported by openai`). Not a bug — it just doesn't offer that path in the header-config OSS mode.

The real surprise was inside LiteLLM. Its `/v1/messages` transport **changed across releases**: ≤1.57.x translated to OpenAI _Chat Completions_, but ≥~1.9x rewrote the passthrough to route through the OpenAI _Responses API_ — it POSTs the upstream `/v1/responses`. Against a Responses-capable upstream that's a clean 3/3; against a plain chat-completions-only upstream (which is what a lot of self-hosted and proxied models are), its transformer raises `KeyError('created_at')` and the call dies before any translation happens. Bifrost goes through the Responses API too. Lesson, in bold: **pin your gateway version when you validate cross-format** — the plumbing under `/v1/messages` is not stable across releases.

## Fast isn't the same as faithful

Because this project also measures the _overhead_ each gateway adds (independently, same neutral runner), I could plot the two together — and it's the one chart nobody else can make, because nobody else measures both:

![Gateways by measured overhead (x-axis, lower is better) versus protocol fidelity (y-axis, higher is better): Bifrost is fast and faithful, LiteLLM is faithful but about 10x slower, Portkey OSS is fast-ish but drops streaming](fidelity-scatter.svg)

- **Bifrost** lands in the sweet spot: ~0.62 ms added latency _and_ 3/3.
- **LiteLLM** is just as faithful (3/3) but ~10× heavier (~5.83 ms/request).
- **Portkey OSS** is fast-ish (~2.65 ms) but sits low on fidelity because of the streaming drop.

"Fastest gateway" and "gateway that won't corrupt my agent" are different questions, and the answer isn't the same box.

## The honesty rules (so you can trust the numbers)

A benchmark that names vendors has to be careful, so three verdict classes are kept strictly separate:

- a real **0/3–3/3** score is a fidelity result;
- **not offered / unsupported** means the gateway doesn't expose that path at all (a capability fact — like Portkey's Anthropic endpoint), never scored as a `0/3`;
- **inconclusive** means a setup/compat error yielded no clean measurement — also never a `0/3`.

And only gateways _built to accept an Anthropic client_ can even offer the cross-format path. API-gateway-style gateways (Kong's `ai-proxy` and peers) take OpenAI-format input and translate to whatever upstream you configure — so a Claude-Code client has no door in. The honest answer to "which gateway lets me point Claude Code at an OpenAI model" is the Anthropic-native proxies (LiteLLM, Bifrost, hosted routers with a real `/v1/messages`), not the OpenAI-in API gateways.

## The one takeaway

Before you commit to a gateway for agent work, run _your actual agent_ — tools + streaming — through it, not a hello-world completion. The failures hide exactly where the smoke test doesn't look: in the streaming tool loop, in the format translation, in the version you didn't pin.

Everything here is reproducible with no keys — the harness is [`probe/fidelity.mjs`](https://github.com/cuihuan/llm-gateway-bench/blob/main/probe/fidelity.mjs) and [`probe/xformat.mjs`](https://github.com/cuihuan/llm-gateway-bench/blob/main/probe/xformat.mjs); the raw results are [`fidelity.json`](https://github.com/cuihuan/llm-gateway-bench/blob/main/data/fidelity.json) and [`xformat.json`](https://github.com/cuihuan/llm-gateway-bench/blob/main/data/xformat.json), refreshed by CI and env-stamped. PRs adding gateways are welcome — the mock does the rest. For the full method, see [how we probe and why it's trustworthy](article.html?slug=methodology-trust).
