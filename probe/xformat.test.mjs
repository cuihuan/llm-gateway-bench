import test from 'node:test';
import assert from 'node:assert/strict';
import {
  checkAnthropicToolUse, checkAnthropicStreaming, checkAnthropicStreamUsage, xverdict,
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
