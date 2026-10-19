import test from 'node:test';
import assert from 'node:assert/strict';
import { firstInputGate, hardGates, integrityReport } from './integrity-report.mjs';
const trial = (evidence = {}, rest = {}) => ({ task: 'regex-log', cacheRead: 80, input: 100, reward: 1, error: null,
  evidence: { complete: true, models: { 'claude-opus-4-8': 1 }, thinkingBlocks: 2, signedBlocks: 2,
    firstInput: 100, firstDigest: 'a'.repeat(64), ...evidence }, ...rest });

test('hard gates fail mismatched models, one unsigned block, or a single trial without cache hits', () => {
  assert.deepEqual(hardGates([trial()], 1, 'claude-opus-4-8'), { model: 'PASS', signature: 'PASS', cache: 'PASS' });
  const bad = hardGates([trial({ models: { 'other-model': 1 }, signedBlocks: 1 }, { cacheRead: 0 })], 1, 'claude-opus-4-8');
  assert.deepEqual(bad, { model: 'FAIL', signature: 'FAIL', cache: 'FAIL' });
  assert.equal(hardGates([trial({ thinkingBlocks: 0, signedBlocks: 0 })], 1, 'claude-opus-4-8').signature.startsWith('UNVERIFIED'), true);
  assert.equal(hardGates([trial()], 2, 'claude-opus-4-8').model, 'UNVERIFIED');
  assert.equal(hardGates([trial({ requestedModels: { different: 1 } })], 1, 'claude-opus-4-8').model, 'FAIL');
});
test('first input equality requires matching tasks and complete identical request digests', () => {
  assert.equal(firstInputGate([trial()], [trial()], 1, 1), 'PASS');
  assert.match(firstInputGate([trial()], [trial({ firstInput: 101 })], 1, 1), /^FAIL/);
  assert.match(firstInputGate([trial()], [trial({ firstInput: 101, firstDigest: 'b'.repeat(64) })], 1, 1), /UNVERIFIED: request digests differ/);
  assert.match(firstInputGate([trial()], [], 1, 1), /UNVERIFIED/);
  assert.match(firstInputGate([trial()], [trial({}, { task: 'other' })], 1, 1), /task mismatch/);
});
test('report preserves all hard gates and statistics without relabeling router baselines official', () => {
  const report = integrityReport([[trial()], [trial()], [trial()]], { model: 'claude-opus-4-8', candidates: [{ name: 'NIBRoute' }] }, 1).join('\n');
  for (const text of ['Response model matches', 'Thinking signature coverage', 'First request total input', 'Message ID prefixes', 'inference_geo', 'API errors no greater', 'Trial exceptions no greater', 'A/A change', 'A/B change', 'Thinking tokens', 'Calls containing thinking']) assert.ok(report.includes(text), text);
  assert.match(report, /NO DIRECT OFFICIAL REFERENCE/);
  assert.match(report, /Hard-gate result: UNVERIFIED/);
  assert.match(report, /Insufficient data/);
  assert.doesNotMatch(report, /[\u3400-\u9fff]/);
  const mismatch = integrityReport([[trial()], [trial()], [trial({ firstInput: 101 })]], { model: 'claude-opus-4-8' }, 1).join('\n');
  assert.match(mismatch, /Hard-gate result: ISSUES DETECTED/);
});
