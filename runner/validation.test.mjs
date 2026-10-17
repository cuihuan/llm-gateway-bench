import test from 'node:test';
import assert from 'node:assert/strict';
import { isPrivateAddress, validateCreateInput } from './validation.mjs';

test('private address detection covers loopback and RFC1918', () => {
  assert.equal(isPrivateAddress('127.0.0.1'), true); assert.equal(isPrivateAddress('10.2.3.4'), true);
  assert.equal(isPrivateAddress('8.8.8.8'), false); assert.equal(isPrivateAddress('::1'), true);
});
test('create input validates and normalizes public endpoints', async () => {
  const input = await validateCreateInput({ officialUrl: 'https://official.example/', newUrl: 'https://new.example',
    officialKey: 'secret-a', newKey: 'secret-b', model: 'claude-opus-4-8', task: 'regex-log', trials: 5 },
  async () => [{ address: '8.8.8.8' }]);
  assert.equal(input.baseline.url, 'https://official.example');
  assert.equal(input.candidates[0].url, 'https://new.example');
  assert.equal(input.agent, 'claude-code'); assert.equal(input.trials, 5);
});
test('create input accepts multiple candidates and Codex', async () => {
  const input = await validateCreateInput({ baseline: { name: 'Official', url: 'https://official.example', key: 'a' },
    candidates: [{ name: 'Relay A', url: 'https://a.example', key: 'b' }, { name: 'Relay B', url: 'https://b.example', key: 'c' }],
    agent: 'codex', model: 'gpt-6.1-sol', task: 'fix-git', trials: 2 }, async () => [{ address: '8.8.8.8' }]);
  assert.equal(input.candidates.length, 2); assert.equal(input.agent, 'codex');
});
test('create input rejects a private endpoint', async () => {
  await assert.rejects(() => validateCreateInput({ officialUrl: 'https://private.example', newUrl: 'https://new.example',
    officialKey: 'a', newKey: 'b', model: 'model', trials: 5 }, async (host) => [{ address: host.startsWith('private') ? '10.0.0.2' : '8.8.8.8' }]), /private network/);
});

