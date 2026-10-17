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
