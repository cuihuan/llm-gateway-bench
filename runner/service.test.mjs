import test from 'node:test';
import assert from 'node:assert/strict';
import { BenchmarkService } from './service.mjs';

test('cancellation remains cancelled after executor rejects', async () => {
  let saved; let rejectRun;
  const store = { save: async run => { saved = structuredClone(run); }, get: async () => saved };
  const executor = { run: () => new Promise((_, reject) => { rejectRun = reject; }), cancel: () => rejectRun(new Error('terminated')) };
  const service = new BenchmarkService({ store, executor, lookup: async () => [{ address: '8.8.8.8' }] });
  const run = await service.create({ officialUrl: 'https://official.example', newUrl: 'https://new.example', officialKey: 'a', newKey: 'b', model: 'model', trials: 1 });
  await service.cancel(run.id); await service.active.get(run.id);
  assert.equal(saved.status, 'cancelled'); assert.equal(saved.error, undefined);
});

test('create never persists or returns API keys', async () => {
  const writes = [];
  const store = { save: async run => writes.push(JSON.stringify(run)), get: async () => JSON.parse(writes.at(-1)) };
  const executor = { run: async () => ({}), cancel: () => {} };
  const service = new BenchmarkService({ store, executor, lookup: async () => [{ address: '8.8.8.8' }] });
  const publicResult = await service.create({ officialUrl: 'https://official.example', newUrl: 'https://new.example',
    officialKey: 'OFFICIAL_SENTINEL_SECRET', newKey: 'NEW_SENTINEL_SECRET', model: 'model', trials: 1 });
  await service.active.get(publicResult.id);
  const serialized = `${JSON.stringify(publicResult)}\n${writes.join('\n')}`;
  assert.doesNotMatch(serialized, /OFFICIAL_SENTINEL_SECRET|NEW_SENTINEL_SECRET/);
});

test('create exposes the safe multi-route history shape', async () => {
  let saved;
  const store = { save: async run => { saved = structuredClone(run); }, get: async () => saved };
  const executor = { run: async () => ({}), cancel: () => {} };
  const service = new BenchmarkService({ store, executor, lookup: async () => [{ address: '8.8.8.8' }] });
  const run = await service.create({
    agent: 'codex', model: 'gpt-6.1-sol', task: 'fix-git', trials: 2,
    baseline: { name: 'OpenAI', url: 'https://api.openai.com/v1', key: 'baseline-secret' },
    candidates: [
      { name: 'Runix A', url: 'https://a.example/v1', key: 'candidate-a-secret' },
      { name: 'Runix B', url: 'https://b.example/v1', key: 'candidate-b-secret' },
    ],
  });
  await service.active.get(run.id);
  assert.equal(run.agent, 'codex');
  assert.deepEqual(run.baseline, { name: 'OpenAI', host: 'api.openai.com' });
  assert.deepEqual(run.candidates, [
    { id: 'candidate-1', name: 'Runix A', host: 'a.example' },
    { id: 'candidate-2', name: 'Runix B', host: 'b.example' },
  ]);
  assert.deepEqual(Object.keys(run.progress), ['baseline-a', 'baseline-b', 'candidate-1', 'candidate-2']);
  assert.doesNotMatch(JSON.stringify(run), /secret|\"url\"/i);
});
