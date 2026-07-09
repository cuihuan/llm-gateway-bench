import test from 'node:test';
import assert from 'node:assert/strict';
import {
  checkToolCall, parseSSE, checkStreaming, checkStreamUsage, verdict,
  streamChunks, STREAM_FULL, STREAM_DELTAS, TOOL_CALL_RESPONSE, startMockUpstream, runFidelity,
  responsesObject, responsesStreamEvents,
} from './fidelity.mjs';

test('checkToolCall: intact tool call passes', () => {
  const r = checkToolCall(TOOL_CALL_RESPONSE);
  assert.equal(r.pass, true);
});

test('checkToolCall: missing tool_calls fails', () => {
  assert.equal(checkToolCall({ choices: [{ message: { content: 'hi' } }] }).pass, false);
});

test('checkToolCall: mangled arguments (invalid JSON) fails', () => {
  const bad = JSON.parse(JSON.stringify(TOOL_CALL_RESPONSE));
  bad.choices[0].message.tool_calls[0].function.arguments = '{not json';
  assert.equal(checkToolCall(bad).pass, false);
});

test('parseSSE: extracts data JSON lines, skips [DONE] and keep-alives', () => {
  const text = 'data: {"a":1}\n\n: keepalive\n\ndata: {"b":2}\n\ndata: [DONE]\n\n';
  assert.deepEqual(parseSSE(text), [{ a: 1 }, { b: 2 }]);
});

test('checkStreaming: real multi-chunk stream reassembles', () => {
  const sse = streamChunks().map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';
  const r = checkStreaming(sse);
  assert.equal(r.pass, true);
  assert.ok(r.chunks >= 2);
});

test('checkStreaming: single collapsed chunk fails', () => {
  const one = `data: ${JSON.stringify({ choices: [{ delta: { content: STREAM_FULL } }] })}\n\ndata: [DONE]\n\n`;
  assert.equal(checkStreaming(one).pass, false);
});

test('checkStreamUsage: present vs absent', () => {
  const withU = streamChunks().map((c) => `data: ${JSON.stringify(c)}\n\n`).join('');
  assert.equal(checkStreamUsage(withU).pass, true);
  const noU = `data: ${JSON.stringify({ choices: [{ delta: { content: 'x' } }] })}\n\n`;
  assert.equal(checkStreamUsage(noU).pass, false);
});

test('verdict: aggregates 3 checks', () => {
  const v = verdict({ pass: true }, { pass: true }, { pass: false });
  assert.equal(v.score, '2/3');
  assert.equal(v.stream_usage, false);
});

test('self-test through the mock: all three checks pass (harness sanity)', async () => {
  const { server, port } = await startMockUpstream(0);
  try {
    const r = await runFidelity({ gatewayUrl: `http://127.0.0.1:${port}/v1/chat/completions` });
    assert.equal(r.verdict.score, '3/3', JSON.stringify(r));
  } finally {
    server.close();
  }
});

// ---------- OpenAI Responses API (/v1/responses) mock ----------

test('responsesObject: with tools -> function_call, created_at present, args parseable', () => {
  const o = responsesObject(true);
  assert.equal(o.object, 'response');
  assert.equal(typeof o.created_at, 'number'); // the field LiteLLM's transformer needs
  const fc = o.output.find((x) => x.type === 'function_call');
  assert.equal(fc.name, 'get_weather');
  assert.equal(JSON.parse(fc.arguments).location, 'San Francisco');
  assert.equal(o.usage.output_tokens, 12);
});

test('responsesObject: without tools -> text message reassembling to STREAM_FULL', () => {
  const o = responsesObject(false);
  const msg = o.output.find((x) => x.type === 'message');
  assert.equal(msg.content[0].type, 'output_text');
  assert.equal(msg.content[0].text, STREAM_FULL);
  assert.equal(o.usage.output_tokens, 4);
});

test('responsesStreamEvents: deltas reassemble, completed carries usage', () => {
  const evts = responsesStreamEvents();
  const deltas = evts.filter((e) => e.event === 'response.output_text.delta');
  assert.equal(deltas.length, STREAM_DELTAS.length);
  assert.equal(deltas.map((e) => e.data.delta).join(''), STREAM_FULL);
  const done = evts.find((e) => e.event === 'response.completed');
  assert.equal(done.data.response.usage.output_tokens, 4);
  assert.equal(done.data.response.created_at, 0);
  // monotonically increasing sequence_number (Responses API contract)
  const seqs = evts.map((e) => e.data.sequence_number);
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
});

test('mock /v1/responses: serves function_call (non-stream) and SSE deltas (stream)', async () => {
  const { server, port } = await startMockUpstream(0);
  try {
    const base = `http://127.0.0.1:${port}/v1/responses`;
    // non-stream with tools -> Responses function_call
    const nr = await fetch(base, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'mock-model', input: [], tools: [{ type: 'function', name: 'get_weather' }] }),
    });
    const nb = await nr.json();
    assert.equal(nb.object, 'response');
    assert.equal(nb.output[0].type, 'function_call');
    // stream -> Responses SSE with output_text deltas
    const sr = await fetch(base, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'mock-model', input: [], stream: true }),
    });
    const text = await sr.text();
    assert.match(text, /response\.output_text\.delta/);
    assert.match(text, /response\.completed/);
  } finally {
    server.close();
  }
});
