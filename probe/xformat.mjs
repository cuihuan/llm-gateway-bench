#!/usr/bin/env node
// CROSS-FORMAT fidelity: the hardest, most-reported gateway failure. A client
// speaks one wire format (Anthropic Messages API) while the upstream speaks
// another (OpenAI Chat Completions). The gateway must translate the request
// down AND the response back up — remapping tool-call ids, streaming event
// shapes, and usage fields between two incompatible schemas. This is where the
// real bugs live: "point Claude Code at an OpenAI model through gateway X and
// tool calls break" is the single most-filed complaint (413+ LiteLLM issues
// mention "claude code"; the top-commented Portkey/OpenRouter issues are all
// cross-format translation breakage).
//
// The OpenAI-passthrough harness (fidelity.mjs) deliberately did NOT test this
// — it was flagged as future work. This is that work.
//
// Method: reuse the same spec-correct mock OpenAI upstream (fidelity.mjs), but
// drive the gateway through its ANTHROPIC endpoint (POST /v1/messages) with an
// Anthropic-shaped request. Then check what arrives back at the Anthropic
// client. Any drop/mangle is the gateway's cross-format translation layer, not
// the model. No API keys, no egress.
//
// Upstream path note (measured 2026-07-09): gateways serve /v1/messages two
// different ways depending on version. LiteLLM <=1.57.x translated Anthropic ->
// OpenAI *Chat Completions* (upstream /v1/chat/completions). LiteLLM >=~1.9x
// rewrote the passthrough to go through the OpenAI *Responses* API — it POSTs the
// upstream /v1/responses (input/input_text/max_output_tokens) and its Responses
// transformer raises KeyError('created_at') if the upstream answers with a
// chat.completion body. So the mock (fidelity.mjs) speaks BOTH endpoints; a
// gateway pointed at a chat-completions-only upstream through the Responses path
// yields no clean measurement and is flagged inconclusive, not a 0/3.
//
// Three checks, each a documented real-world failure:
//   1. tool_use     — OpenAI `tool_calls` must become an Anthropic `tool_use`
//                     content block with name + a PARSED input object (not a
//                     raw JSON string, the classic mistranslation).
//   2. streaming    — the OpenAI SSE stream must become a well-formed Anthropic
//                     event stream (content_block_delta text_delta …) that
//                     reassembles to the original text.
//   3. stream_usage — the upstream's token counts must survive into the final
//                     Anthropic `message_delta` usage (output_tokens > 0), or
//                     billing on the Anthropic path cannot be reconciled.

import { writeFile, readFile } from 'node:fs/promises';
import { startMockUpstream, parseSSE, STREAM_FULL } from './fidelity.mjs';

// ---------- pure cross-format checks (unit-tested) ----------

/** A relayed Anthropic non-stream response: a tool_use block with a real,
 *  PARSED input object (the #1 mistranslation is leaving it a JSON string). */
export function checkAnthropicToolUse(body) {
  const content = body?.content;
  if (!Array.isArray(content)) return { pass: false, note: 'no Anthropic content array in relayed response' };
  const tu = content.find((b) => b && b.type === 'tool_use');
  if (!tu) return { pass: false, note: 'no tool_use content block — tool call lost in translation' };
  if (tu.name !== 'get_weather') return { pass: false, note: `tool name mangled -> ${tu.name}` };
  if (tu.input === null || typeof tu.input !== 'object' || Array.isArray(tu.input)) {
    return { pass: false, note: 'tool_use.input is not a parsed object (left as a raw string?)' };
  }
  if (typeof tu.input.location !== 'string') {
    return { pass: false, note: 'tool_use.input lost its arguments (no location)' };
  }
  return { pass: true, note: 'tool_use translated intact (name + parsed input)' };
}

/** The Anthropic event stream reassembles to the original text over >=2 deltas. */
export function checkAnthropicStreaming(sseText) {
  const events = parseSSE(sseText);
  const deltas = events.filter(
    (e) => e && e.type === 'content_block_delta' && e.delta && e.delta.type === 'text_delta',
  );
  if (deltas.length < 2) {
    return { pass: false, note: `only ${deltas.length} text_delta event(s) — collapsed/buffered`, deltas: deltas.length };
  }
  const text = deltas.map((e) => e.delta.text || '').join('');
  const ok = text === STREAM_FULL;
  return {
    pass: ok,
    note: ok ? `${deltas.length} text_delta events, content intact` : `content mismatch: ${JSON.stringify(text)}`,
    deltas: deltas.length,
  };
}

/** The final Anthropic message_delta must carry a non-zero output_tokens so the
 *  Anthropic-path bill can be reconciled. Anthropic's convention puts cumulative
 *  output_tokens in message_delta usage (input_tokens rides message_start). */
export function checkAnthropicStreamUsage(sseText) {
  const events = parseSSE(sseText);
  const outs = events
    .filter((e) => e && e.type === 'message_delta' && e.usage && typeof e.usage.output_tokens === 'number')
    .map((e) => e.usage.output_tokens);
  const maxOut = outs.length ? Math.max(...outs) : 0;
  if (maxOut > 0) {
    // upstream mock streams completion_tokens=4; note whether it survived exactly
    const exact = maxOut === 4 ? ' (matches upstream)' : ` (upstream was 4, got ${maxOut} — recounted)`;
    return { pass: true, note: `output_tokens=${maxOut} in message_delta${exact}` };
  }
  return { pass: false, note: 'message_delta usage output_tokens=0/absent — Anthropic-path billing cannot be reconciled' };
}

/** Overall verdict from the three cross-format checks. */
export function xverdict(tool, stream, usage) {
  const passed = [tool.pass, stream.pass, usage.pass].filter(Boolean).length;
  return { score: `${passed}/3`, tool_use: tool.pass, streaming: stream.pass, stream_usage: usage.pass };
}

/** Distinguish "the gateway mangled a valid translation" (a real 0-3 fidelity
 *  result) from "we never got a clean measurement" (an HTTP/config/compat error
 *  — e.g. the gateway wrapped the upstream in an APIError, or the endpoint 4xx'd).
 *  The latter must NEVER be published as a fidelity verdict; it's inconclusive.
 *  A response is an error body if it 4xx/5xx'd or its body is a JSON `{error:…}`
 *  envelope rather than an Anthropic message/event. Returns a reason or null. */
export function inconclusiveReason(debug) {
  const isErr = (status, snip) => {
    if (status === 0) return true; // transport failure (unreachable/timeout)
    if (typeof status === 'number' && status >= 400) return true;
    const s = (snip || '').replace(/\s/g, '');
    // an {"error":…} envelope, or a LiteLLM/OpenAI exception string, not an
    // Anthropic {"type":"message"…} / event body
    return /^\{"error"/.test(s) || /APIError|Exception|litellm\./.test(snip || '');
  };
  const toolErr = isErr(debug?.tool_status, debug?.tool_snippet);
  const streamErr = isErr(debug?.stream_status, debug?.stream_snippet);
  if (toolErr && streamErr) return 'both endpoints returned an error/exception body — no clean measurement (setup/compat, not a fidelity verdict)';
  if (toolErr) return 'tool-call endpoint returned an error/exception body — no clean measurement';
  if (streamErr) return 'streaming endpoint returned an error/exception body — no clean measurement';
  return null;
}

// ---------- runner ----------

// Anthropic Messages API tool shape (note: input_schema, not OpenAI's parameters).
const ANTHROPIC_TOOLS = [{
  name: 'get_weather',
  description: 'Get the weather',
  input_schema: { type: 'object', properties: { location: { type: 'string' } }, required: ['location'] },
}];

async function post(url, headers, payload) {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    return { status: res.status, text };
  } catch (e) {
    // unreachable gateway / timeout — a transport failure, not a fidelity result.
    // status 0 + an error snippet flow into inconclusiveReason() as inconclusive.
    return { status: 0, text: `{"error":{"message":"transport failure: ${String(e.message || e).replace(/"/g, "'")}"}}` };
  }
}

/** A short, safe snippet of a response body for diagnosing a 0/3 (config/auth
 *  error vs a genuine translation failure) without dumping a whole stream. */
function snippet(text) {
  return (text ?? '').replace(/\s+/g, ' ').trim().slice(0, 220);
}

export async function runXformat({ gatewayUrl, headers = {}, model = 'mock-model' }) {
  const base = { model, max_tokens: 64, messages: [{ role: 'user', content: 'weather in SF?' }] };
  // 1. tool_use translation
  const t = await post(gatewayUrl, headers, { ...base, tools: ANTHROPIC_TOOLS });
  let tool;
  try { tool = checkAnthropicToolUse(JSON.parse(t.text)); }
  catch { tool = { pass: false, note: `non-JSON response (HTTP ${t.status})` }; }
  // 2 + 3. streaming (+ usage) in one request
  const s = await post(gatewayUrl, headers, { ...base, messages: [{ role: 'user', content: 'hi' }], stream: true });
  const stream = checkAnthropicStreaming(s.text);
  const usage = checkAnthropicStreamUsage(s.text);
  // debug is load-bearing: a 0/3 must be diagnosable as a translation bug vs an
  // endpoint/config error before any vendor-facing claim is published.
  const debug = { tool_status: t.status, tool_snippet: snippet(t.text), stream_status: s.status, stream_snippet: snippet(s.text) };
  return { verdict: xverdict(tool, stream, usage), tool, stream, usage, debug };
}

// ---------- CLI ----------

function arg(name, d) { const i = process.argv.indexOf(`--${name}`); return i > -1 ? process.argv[i + 1] : d; }
function args(name) { const o = []; process.argv.forEach((a, i) => a === `--${name}` && o.push(process.argv[i + 1])); return o; }

async function main() {
  if (process.argv.includes('--help')) {
    console.log(`Usage: node probe/xformat.mjs --gateway <name> --messages-url <anthropic /v1/messages url>
       [--api-key sk-x] [--header 'k: v' ...] [--model mock-model] [--mock-port 9010] [--out data/xformat.json]
Drives the gateway's ANTHROPIC endpoint; the gateway must have the mock upstream
(http://127.0.0.1:<mock-port>/v1) configured as its openai provider.`);
    return;
  }
  const name = arg('gateway');
  if (!name) throw new Error('--gateway <name> required (or --help)');
  const messagesUrl = arg('messages-url');
  if (!messagesUrl) throw new Error('--messages-url required');
  const { server } = await startMockUpstream(Number(arg('mock-port', '9010')));
  const headers = { 'anthropic-version': '2023-06-01' };
  const key = arg('api-key'); if (key) { headers['x-api-key'] = key; headers.authorization = `Bearer ${key}`; }
  for (const h of args('header')) { const i = h.indexOf(':'); if (i > 0) headers[h.slice(0, i).trim().toLowerCase()] = h.slice(i + 1).trim(); }

  console.error(`[xformat] testing ${name} (Anthropic client -> OpenAI upstream) …`);
  const r = await runXformat({ messagesUrl, gatewayUrl: messagesUrl, headers, model: arg('model', 'mock-model') });
  server.close();

  const reason = inconclusiveReason(r.debug);
  const entry = {
    name, version: arg('gateway-version', null), measuredAt: new Date().toISOString(),
    env: { runner: process.env.GITHUB_ACTIONS ? 'github-actions' : 'local', node: process.version, platform: process.platform },
    ...(reason ? { inconclusive: true, inconclusive_reason: reason } : {}),
    ...r,
  };
  const outPath = arg('out', 'data/xformat.json');
  let doc = {
    _comment: 'CROSS-FORMAT fidelity: an Anthropic Messages API client routed through the gateway to an OpenAI-format upstream. Does tool_use / streaming / usage survive the gateway translating one wire format to the other and back? Mock OpenAI upstream, no keys. This is the hardest translation path and the #1 real-world complaint (Claude Code through a gateway). NOTE: an entry marked "inconclusive" is a setup/compat artifact (the gateway returned an error/exception body, so no clean measurement) — NOT a fidelity verdict; do not read it as a score. See docs/methodology.md.',
    results: [],
  };
  try { doc = JSON.parse(await readFile(outPath, 'utf8')); } catch {}
  doc.results = (doc.results ?? []).filter((x) => x.name !== name);
  doc.results.push(entry);
  await writeFile(outPath, JSON.stringify(doc, null, 2) + '\n');
  if (reason) {
    console.log(`[xformat] ${name}: INCONCLUSIVE — ${reason}`);
  } else {
    console.log(`[xformat] ${name}: ${r.verdict.score} — tool_use:${r.verdict.tool_use} streaming:${r.verdict.streaming} stream_usage:${r.verdict.stream_usage}`);
  }
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
