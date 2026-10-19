import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readClaudeEvidence } from './claude-evidence.mjs';

const usage = { input_tokens: 2, cache_creation_input_tokens: 20, cache_read_input_tokens: 80, output_tokens: 8,
  output_tokens_details: { thinking_tokens: 6 }, inference_geo: '' };
const response = (overrides = {}) => ({ type: 'assistant', timestamp: '2026-01-01T00:00:04Z', requestRef: 'req', apiBlockIndex: 0,
  requestedModel: 'claude-opus-4-8', message: { id: 'msg_bdrk_unique', model: 'claude-opus-4-8', usage,
    content: [{ type: 'thinking', thinking: 'PRIVATE_THINKING', signature: 'PRIVATE_SIGNATURE' }] }, ...overrides });
async function fixture(t, records, extraFiles = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-evidence-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'main.jsonl'), records.map((r) => typeof r === 'string' ? r : JSON.stringify(r)).join('\n'));
  for (const [file, entries] of Object.entries(extraFiles)) {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.writeFile(path.join(root, file), entries.map(JSON.stringify).join('\n'));
  }
  return root;
}

test('deduplicates split/replayed response blocks and keeps usage once per message', async t => {
  const r = response();
  const tool = response({ apiBlockIndex: 2, timestamp: '2026-01-01T00:00:06Z', message: { ...r.message, content: [{ type: 'tool_use', id: 'tool', input: { key: 'PRIVATE_KEY' } }] } });
  const root = await fixture(t, [{ type: 'api-request', id: 'req', timestamp: '2026-01-01T00:00:01Z', requestDigest: 'a'.repeat(64) },
    r, r, response({ apiBlockIndex: 1, message: { ...r.message, content: [{ type: 'thinking', signature: '' }] } }), tool, tool]);
  const e = await readClaudeEvidence(root);
  assert.equal(e.complete, true);
  assert.equal(e.calls, 1); assert.equal(e.input, 102); assert.equal(e.output, 8);
  assert.equal(e.thinkingBlocks, 2); assert.equal(e.signedBlocks, 1); assert.equal(e.tools, 1);
  assert.equal(e.callSeconds, 5); assert.equal(e.firstDigest, 'a'.repeat(64));
  assert.equal(e.firstInput, 102); assert.deepEqual(e.geo, { '(empty)': 1 });
  assert.doesNotMatch(JSON.stringify(e), /PRIVATE_|msg_bdrk_unique/);
});

test('counts error messages but excludes synthetic responses and unpaired attempts from response calls', async t => {
  const root = await fixture(t, [{ type: 'api-request', id: 'failed', timestamp: '2026-01-01T00:00:00Z' },
    { type: 'api-request', id: 'req', timestamp: '2026-01-01T00:00:01Z', requestDigest: 'b'.repeat(64) },
    { ...response(), uuid: 'error', isApiErrorMessage: true, message: { model: '<synthetic>', content: [] } }, response()]);
  const e = await readClaudeEvidence(root);
  assert.equal(e.apiErrors, 1); assert.equal(e.requestAttempts, 2); assert.equal(e.unpairedRequests, 1);
  assert.equal(e.calls, 1); assert.equal(e.firstDigest, 'b'.repeat(64));
});

test('subagent data contributes to counts but cannot become the first main request', async t => {
  const r = response();
  const root = await fixture(t, [r], { 'subagents/early.jsonl': [response({ timestamp: '2025-12-31T23:00:00Z',
    message: { ...r.message, id: 'msg_011_sub', usage: { ...usage, input_tokens: 999 } } })] });
  const e = await readClaudeEvidence(root);
  assert.equal(e.calls, 2); assert.equal(e.firstInput, 102);
  assert.equal(e.callSeconds, null); assert.equal(e.firstDigest, null);
  assert.deepEqual(e.prefixes, { msg_011: 1, msg_bdrk: 1 });
});

test('missing usage, missing files, and malformed records stay unknown; zero thinking is not signed thinking', async t => {
  const r = response();
  const root = await fixture(t, [response({ message: { ...r.message, content: [{ type: 'redacted_thinking', data: 'PRIVATE_DATA' }], usage: { input_tokens: 0, output_tokens: 0 } } })]);
  const e = await readClaudeEvidence(root);
  assert.equal(e.thinkingBlocks, 0); assert.equal(e.signedBlocks, 0);
  assert.equal(e.redactedBlocks, 1); assert.equal(e.redactedWithData, 1);
  assert.equal(e.thinkingTokens, null); assert.equal(e.firstInput, null);
  assert.deepEqual(e.geo, { '(missing)': 1 });
  await fs.appendFile(path.join(root, 'main.jsonl'), '\n{broken');
  const malformed = await readClaudeEvidence(root);
  assert.equal(malformed.complete, false); assert.equal(malformed.apiErrors, null); assert.equal(malformed.thinkingShare, null);
  const missing = await readClaudeEvidence(path.join(root, 'absent'));
  assert.equal(missing.complete, false); assert.equal(missing.calls, null); assert.equal(missing.apiErrors, null);
});
