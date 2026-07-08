#!/usr/bin/env node
// Protocol-translation fidelity: does a gateway relay a well-formed upstream
// response to the client WITHOUT corrupting it? This is the #1 gateway failure
// category in real bug trackers (tool-call / streaming / usage-block breakage —
// "claude code" appears in 413+ LiteLLM issues) yet nobody measures it.
//
// Method: a local mock OpenAI upstream returns canonical, spec-correct responses
// (a tool_call, a real SSE stream, usage in the final chunk). We send matching
// requests THROUGH each gateway and check what arrives at the client. Any drop
// or mangle is the gateway's translation layer, not the model. No API keys.
//
// Three checks map to three cited pains:
//   1. tool_calls   — request with a `tools` definition; is a valid tool_call relayed?
//   2. streaming    — request stream:true; do >=2 SSE chunks arrive, reassembling correctly?
//   3. stream_usage — does the final streaming chunk carry usage.total_tokens?
//                     (a gateway that drops it can't have its billing reconciled)
//
// Scope: structural relay fidelity for OpenAI-format passthrough. It does NOT test
// cross-format translation (OpenAI-client <-> Anthropic-upstream id remapping),
// where the hardest bugs live — that's future work, flagged honestly.

import { writeFile, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';

// ---------- canonical upstream responses ----------

export const TOOL_CALL_RESPONSE = {
  id: 'chatcmpl-tool', object: 'chat.completion', created: 0, model: 'mock-model',
  choices: [{
    index: 0,
    message: {
      role: 'assistant', content: null,
      tool_calls: [{
        id: 'call_abc123', type: 'function',
        function: { name: 'get_weather', arguments: '{"location":"San Francisco","unit":"celsius"}' },
      }],
    },
    finish_reason: 'tool_calls',
  }],
  usage: { prompt_tokens: 20, completion_tokens: 12, total_tokens: 32 },
};

// The streamed content, split into content deltas (what a real stream looks like).
export const STREAM_DELTAS = ['Hello', ', ', 'world', '!'];
export const STREAM_FULL = STREAM_DELTAS.join('');

/** Build the SSE chunk lines a spec-correct OpenAI stream emits. */
export function streamChunks() {
  const base = { id: 'chatcmpl-stream', object: 'chat.completion.chunk', created: 0, model: 'mock-model' };
  const out = [];
  out.push({ ...base, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] });
  for (const d of STREAM_DELTAS) {
    out.push({ ...base, choices: [{ index: 0, delta: { content: d }, finish_reason: null }] });
  }
  out.push({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
  // final usage chunk (OpenAI sends this when stream_options.include_usage; we always
  // emit it so the test measures whether the GATEWAY relays it)
  out.push({ ...base, choices: [], usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } });
  return out;
}

// ---------- pure fidelity checks (unit-tested) ----------

/** A relayed non-stream tool response: valid tool_call with a parseable arg JSON? */
export function checkToolCall(body) {
  try {
    const tc = body?.choices?.[0]?.message?.tool_calls?.[0];
    if (!tc || tc.type !== 'function') return { pass: false, note: 'no tool_calls in relayed response' };
    if (!tc.function?.name) return { pass: false, note: 'tool_call missing function.name' };
    JSON.parse(tc.function.arguments); // must be valid JSON
    const ok = tc.function.name === 'get_weather';
    return { pass: ok, note: ok ? 'tool_call relayed intact' : `name mangled -> ${tc.function.name}` };
  } catch (e) {
    return { pass: false, note: `arguments not valid JSON (${e.message})` };
  }
}

/** Parse an SSE body into the JSON objects of its `data:` lines (excluding [DONE]). */
export function parseSSE(text) {
  const out = [];
  for (const line of (text ?? '').split(/\r?\n/)) {
    const m = line.match(/^data:\s*(.+)$/);
    if (!m) continue;
    const payload = m[1].trim();
    if (payload === '[DONE]') continue;
    try { out.push(JSON.parse(payload)); } catch { /* ignore keep-alives */ }
  }
  return out;
}

/** >=2 chunks, and the reassembled content deltas equal the sent content. */
export function checkStreaming(sseText) {
  const chunks = parseSSE(sseText);
  if (chunks.length < 2) return { pass: false, note: `only ${chunks.length} chunk(s) — collapsed/buffered`, chunks: chunks.length };
  const content = chunks.map((c) => c.choices?.[0]?.delta?.content || '').join('');
  const ok = content === STREAM_FULL;
  return { pass: ok, note: ok ? `${chunks.length} chunks, content intact` : `content mismatch: ${JSON.stringify(content)}`, chunks: chunks.length };
}

/** A streamed chunk carries usage token counts? */
export function checkStreamUsage(sseText) {
  const chunks = parseSSE(sseText);
  const u = chunks.map((c) => c.usage).find((x) => x && typeof x.total_tokens === 'number');
  return { pass: !!u, note: u ? `usage relayed (total_tokens=${u.total_tokens})` : 'no usage in stream — billing cannot be reconciled' };
}

/** Overall verdict from the three checks. */
export function verdict(tool, stream, usage) {
  const passed = [tool.pass, stream.pass, usage.pass].filter(Boolean).length;
  return { score: `${passed}/3`, tool_calls: tool.pass, streaming: stream.pass, stream_usage: usage.pass };
}

// ---------- mock upstream ----------

export function startMockUpstream(port = 0) {
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      if (req.url.includes('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-model', object: 'model' }] }));
      }
      let body = {};
      try { body = JSON.parse(raw || '{}'); } catch { /* */ }
      if (body.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        const chunks = streamChunks();
        let i = 0;
        const tick = () => {
          if (i < chunks.length) {
            res.write(`data: ${JSON.stringify(chunks[i++])}\n\n`);
            setTimeout(tick, 5); // genuine inter-chunk gap
          } else {
            res.write('data: [DONE]\n\n');
            res.end();
          }
        };
        return tick();
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(Array.isArray(body.tools) && body.tools.length ? TOOL_CALL_RESPONSE : {
        id: 'chatcmpl-mock', object: 'chat.completion', created: 0, model: 'mock-model',
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 8, completion_tokens: 1, total_tokens: 9 },
      }));
    });
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ server, port: server.address().port })));
}

// ---------- runner ----------

const TOOLS = [{
  type: 'function',
  function: {
    name: 'get_weather',
    description: 'Get the weather',
    parameters: { type: 'object', properties: { location: { type: 'string' } }, required: ['location'] },
  },
}];

async function post(url, headers, payload) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  return { status: res.status, text };
}

export async function runFidelity({ gatewayUrl, headers = {}, model = 'mock-model' }) {
  const base = { model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 16 };
  // 1. tool call
  const t = await post(gatewayUrl, headers, { ...base, tools: TOOLS, tool_choice: 'auto' });
  let tool;
  try { tool = checkToolCall(JSON.parse(t.text)); } catch { tool = { pass: false, note: `non-JSON response (HTTP ${t.status})` }; }
  // 2 + 3. streaming (+ usage) — one streamed request covers both
  const s = await post(gatewayUrl, headers, { ...base, stream: true, stream_options: { include_usage: true } });
  const stream = checkStreaming(s.text);
  const usage = checkStreamUsage(s.text);
  return { verdict: verdict(tool, stream, usage), tool, stream, usage };
}

// ---------- CLI ----------

function arg(name, d) { const i = process.argv.indexOf(`--${name}`); return i > -1 ? process.argv[i + 1] : d; }
function args(name) { const o = []; process.argv.forEach((a, i) => a === `--${name}` && o.push(process.argv[i + 1])); return o; }

async function main() {
  if (process.argv.includes('--help')) {
    console.log(`Usage: node probe/fidelity.mjs --gateway <name> --gateway-url <chat-completions-url>
       [--api-key sk-x] [--header 'k: v' ...] [--model mock-model] [--mock-port 9020] [--out data/fidelity.json]
The gateway must be configured with the mock upstream (http://127.0.0.1:<mock-port>/v1) as its openai provider.`);
    return;
  }
  const name = arg('gateway');
  if (!name) throw new Error('--gateway <name> required (or --help)');
  const { server, port } = await startMockUpstream(Number(arg('mock-port', '9020')));
  const gatewayUrl = name === 'self-test' ? `http://127.0.0.1:${port}/v1/chat/completions` : arg('gateway-url');
  if (!gatewayUrl) throw new Error('--gateway-url required');
  const headers = {};
  const key = arg('api-key'); if (key) headers.authorization = `Bearer ${key}`;
  for (const h of args('header')) { const i = h.indexOf(':'); if (i > 0) headers[h.slice(0, i).trim().toLowerCase()] = h.slice(i + 1).trim(); }

  console.error(`[fidelity] testing ${name} …`);
  const r = await runFidelity({ gatewayUrl, headers, model: arg('model', 'mock-model') });
  server.close();

  const entry = {
    name, version: arg('gateway-version', null), measuredAt: new Date().toISOString(),
    env: { runner: process.env.GITHUB_ACTIONS ? 'github-actions' : 'local', node: process.version, platform: process.platform },
    ...r,
  };
  const outPath = arg('out', 'data/fidelity.json');
  let doc = { _comment: 'Protocol-translation fidelity: does the gateway relay a spec-correct upstream response (tool_calls / real streaming / usage) to the client without corruption? Mock OpenAI upstream, no keys. Structural OpenAI-format passthrough only — cross-format (Anthropic id-remapping) translation is future work. See docs/methodology.md.', results: [] };
  try { doc = JSON.parse(await readFile(outPath, 'utf8')); } catch {}
  doc.results = (doc.results ?? []).filter((x) => x.name !== name);
  doc.results.push(entry);
  await writeFile(outPath, JSON.stringify(doc, null, 2) + '\n');
  console.log(`[fidelity] ${name}: ${r.verdict.score} — tool_calls:${r.verdict.tool_calls} streaming:${r.verdict.streaming} stream_usage:${r.verdict.stream_usage}`);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
