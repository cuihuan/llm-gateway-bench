import test from 'node:test';
import assert from 'node:assert/strict';
import {
  checkAnthropicToolUse, checkAnthropicStreaming, checkAnthropicStreamUsage, xverdict, inconclusiveReason, unsupportedReason,
} from './xformat.mjs';

// ---------- canonical Anthropic fixtures (what a faithful translation emits) ----------

const GOOD_TOOL_USE = {
  id: 'msg_1', type: 'message', role: 'assistant',
  content: [{ type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { location: 'San Francisco', unit: 'celsius' } }],
  stop_reason: 'tool_use',
  usage: { input_tokens: 20, output_tokens: 12 },
};

// A well-formed Anthropic event stream: message_start → content_block_start →
// text_delta ×4 → content_block_stop → message_delta(usage) → message_stop.
function anthropicStream({ usageOut = 4 } = {}) {
  const ev = (type, data) => `event: ${type}\ndata:${JSON.stringify({ type, ...data })}\n\n`;
  let s = '';
  s += ev('message_start', { message: { id: 'msg_1', role: 'assistant', content: [], usage: { input_tokens: 10, output_tokens: 1 } } });
  s += ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
  for (const d of ['Hello', ', ', 'world', '!']) {
    s += ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: d } });
  }
  s += ev('content_block_stop', { index: 0 });
  s += ev('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: usageOut } });
  s += ev('message_stop', {});
  return s;
}

// ---------- tool_use translation ----------

test('checkAnthropicToolUse: intact tool_use with parsed input passes', () => {
  assert.equal(checkAnthropicToolUse(GOOD_TOOL_USE).pass, true);
});

test('checkAnthropicToolUse: no tool_use block fails', () => {
  const noTool = { content: [{ type: 'text', text: 'hi' }] };
  assert.equal(checkAnthropicToolUse(noTool).pass, false);
});

test('checkAnthropicToolUse: input left as a raw JSON string (classic mistranslation) fails', () => {
  const bad = JSON.parse(JSON.stringify(GOOD_TOOL_USE));
  bad.content[0].input = '{"location":"San Francisco"}';
  assert.equal(checkAnthropicToolUse(bad).pass, false);
});

test('checkAnthropicToolUse: input lost its arguments fails', () => {
  const bad = JSON.parse(JSON.stringify(GOOD_TOOL_USE));
  bad.content[0].input = {};
  assert.equal(checkAnthropicToolUse(bad).pass, false);
});

test('checkAnthropicToolUse: no content array fails', () => {
  assert.equal(checkAnthropicToolUse({ choices: [] }).pass, false);
});

// ---------- streaming ----------

test('checkAnthropicStreaming: well-formed event stream reassembles to Hello, world!', () => {
  const r = checkAnthropicStreaming(anthropicStream());
  assert.equal(r.pass, true, r.note);
  assert.ok(r.deltas >= 2);
});

test('checkAnthropicStreaming: a single collapsed delta fails', () => {
  const one =
    'event: content_block_delta\ndata:' +
    JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello, world!' } }) +
    '\n\n';
  assert.equal(checkAnthropicStreaming(one).pass, false);
});

test('checkAnthropicStreaming: content mismatch fails', () => {
  const bad = anthropicStream().replace('world', 'w0rld');
  assert.equal(checkAnthropicStreaming(bad).pass, false);
});

// ---------- streaming usage ----------

test('checkAnthropicStreamUsage: non-zero output_tokens in message_delta passes', () => {
  const r = checkAnthropicStreamUsage(anthropicStream({ usageOut: 4 }));
  assert.equal(r.pass, true, r.note);
});

test('checkAnthropicStreamUsage: dropped usage (output_tokens=0) fails — the real LiteLLM-class bug', () => {
  const r = checkAnthropicStreamUsage(anthropicStream({ usageOut: 0 }));
  assert.equal(r.pass, false);
});

test('checkAnthropicStreamUsage: recounted (non-4) still passes but notes divergence', () => {
  const r = checkAnthropicStreamUsage(anthropicStream({ usageOut: 5 }));
  assert.equal(r.pass, true);
  assert.match(r.note, /recounted/);
});

// ---------- verdict ----------

test('xverdict: aggregates the three cross-format checks', () => {
  const v = xverdict({ pass: true }, { pass: true }, { pass: false });
  assert.equal(v.score, '2/3');
  assert.equal(v.tool_use, true);
  assert.equal(v.stream_usage, false);
});

test('xverdict: full pass on the canonical fixtures end-to-end', () => {
  const tool = checkAnthropicToolUse(GOOD_TOOL_USE);
  const stream = checkAnthropicStreaming(anthropicStream());
  const usage = checkAnthropicStreamUsage(anthropicStream());
  assert.equal(xverdict(tool, stream, usage).score, '3/3');
});

// ---------- inconclusive detection (never publish a config error as a verdict) ----------

test('inconclusiveReason: clean Anthropic bodies are conclusive (null)', () => {
  const debug = { tool_status: 200, tool_snippet: '{"type":"message","content":[{"type":"tool_use"}]}', stream_status: 200, stream_snippet: 'event: message_start data:{"type":"message_start"}' };
  assert.equal(inconclusiveReason(debug), null);
});

test('inconclusiveReason: an APIError-wrapped body is inconclusive, not a 0/3 fail', () => {
  // the real LiteLLM 1.91.1 CI artifact: HTTP 200 but body is an error envelope
  const debug = {
    tool_status: 200, tool_snippet: '{"error":{"message":"litellm.APIError: APIError: OpenAIException - {...}"}}',
    stream_status: 200, stream_snippet: '{"error":{"message":"litellm.APIError: OpenAIException - "}}',
  };
  const r = inconclusiveReason(debug);
  assert.ok(r && /both endpoints/.test(r), r);
});

test('inconclusiveReason: a 4xx status is inconclusive', () => {
  const debug = { tool_status: 404, tool_snippet: 'Not Found', stream_status: 404, stream_snippet: 'Not Found' };
  assert.ok(inconclusiveReason(debug));
});

test('inconclusiveReason: only one side erroring is still inconclusive', () => {
  const debug = { tool_status: 200, tool_snippet: '{"type":"message"}', stream_status: 500, stream_snippet: '{"error":{"message":"boom"}}' };
  assert.ok(/streaming endpoint/.test(inconclusiveReason(debug)));
});

test('unsupportedReason: Portkey-style "not supported by openai" is unsupported, not a score', () => {
  // Portkey OSS /v1/messages with an openai provider rejects the operation (HTTP 500).
  const debug = { tool_status: 500, tool_snippet: '{"status":"failure","message":"messages is not supported by openai"}', stream_status: 500, stream_snippet: '{"status":"failure","message":"messages is not supported by openai"}' };
  const r = unsupportedReason(debug);
  assert.ok(r, 'should be unsupported');
  assert.match(r, /messages is not supported by openai/);
});

test('unsupportedReason: a 404/405 endpoint is unsupported', () => {
  assert.ok(unsupportedReason({ tool_status: 405, tool_snippet: 'Method Not Allowed', stream_status: 405, stream_snippet: 'Method Not Allowed' }));
  assert.ok(unsupportedReason({ tool_status: 404, tool_snippet: 'not found', stream_status: 404, stream_snippet: 'not found' }));
});

test('unsupportedReason: a clean translation (or a plain compat error) is NOT unsupported', () => {
  assert.equal(unsupportedReason({ tool_status: 200, tool_snippet: '{"type":"message"}', stream_status: 200, stream_snippet: 'event: message_start' }), null);
  // an APIError-wrapped body is inconclusive, not "unsupported" (the path exists, it just errored)
  assert.equal(unsupportedReason({ tool_status: 200, tool_snippet: '{"error":{"message":"litellm.APIError"}}', stream_status: 200, stream_snippet: '{"error":{}}' }), null);
});
