import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RunStore } from './store.mjs';

test('store persists runs without introducing credentials', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'router-store-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new RunStore(root); const run = { id: '11111111-1111-4111-8111-111111111111', createdAt: '2026-01-01T00:00:00Z', model: 'm' };
  await store.save(run); assert.deepEqual(await store.get(run.id), run); assert.deepEqual(await store.list(), [run]);
  assert.doesNotMatch(await fs.readFile(path.join(root, run.id, 'run.json'), 'utf8'), /apiKey|secret/i);
});

