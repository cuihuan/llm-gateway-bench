import test from 'node:test';
import assert from 'node:assert/strict';
import { agentForModel, isPrivateAddress, validateCreateInput } from './validation.mjs';

test('private address detection covers loopback and RFC1918', () => {
  assert.equal(isPrivateAddress('127.0.0.1'), true); assert.equal(isPrivateAddress('10.2.3.4'), true);
  assert.equal(isPrivateAddress('8.8.8.8'), false); assert.equal(isPrivateAddress('::1'), true);
});
test('create input pins both routers and selects Claude Code', async () => {
  const input = await validateCreateInput({ synthoraiKey: 'secret-a', nibrouteKey: 'secret-b',
    model: 'claude-opus-4-8', task: 'regex-log', trials: 5 },
  async () => [{ address: '8.8.8.8' }]);
  assert.deepEqual(input.baseline, { name: 'SynthorAI', url: 'https://synthorai.io', key: 'secret-a' });
  assert.deepEqual(input.candidates, [{ name: 'NIBRoute', url: 'https://api.aws.nibroute.xyz', key: 'secret-b' }]);
  assert.equal(input.agent, 'claude-code'); assert.equal(input.trials, 5);
});
test('create input ignores caller URLs and selects Codex for non-Claude models', async () => {
  const input = await validateCreateInput({ baseline: { name: 'Wrong', url: 'https://wrong.example', key: 'a' },
    candidates: [{ name: 'Wrong', url: 'https://wrong.example', key: 'b' }],
    agent: 'claude-code', model: 'gpt-custom', task: 'fix-git', trials: 2 }, async () => [{ address: '8.8.8.8' }]);
  assert.equal(input.baseline.url, 'https://synthorai.io');
  assert.equal(input.candidates[0].url, 'https://api.aws.nibroute.xyz');
  assert.equal(input.agent, 'codex');
});
test('agent selection follows the model family', () => {
  assert.equal(agentForModel('claude-sonnet-4-6'), 'claude-code');
  assert.equal(agentForModel('gpt-custom'), 'codex');
});
test('create input rejects missing router keys', async () => {
  await assert.rejects(() => validateCreateInput({ synthoraiKey: 'a', model: 'claude-opus-4-8' }), /Both router API keys/);
});

