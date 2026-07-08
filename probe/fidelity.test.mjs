import test from 'node:test';
import assert from 'node:assert/strict';
import {
  checkToolCall, parseSSE, checkStreaming, checkStreamUsage, verdict,
  streamChunks, STREAM_FULL, TOOL_CALL_RESPONSE, startMockUpstream, runFidelity,
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
