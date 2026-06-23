import test from 'node:test';
import assert from 'node:assert/strict';
import { detectSecrets, indexEntry, upsertIndex } from '../scripts/publish-report.mjs';

test('detectSecrets: flags keys, bearer, authorization; clean report passes', () => {
  assert.ok(detectSecrets('{"k":"sk-abc123"}'));
  assert.ok(detectSecrets('Authorization: Bearer xyz'));
  assert.ok(detectSecrets('{"authorization":"x"}'));
  assert.equal(detectSecrets('{"host":"openrouter.ai","ttftMs":500}'), null);
});

test('indexEntry: compact summary from a report', () => {
  const e = indexEntry({
    kind: 'compare', model: 'gemini-2.5-flash', region: 'local-cn', generatedAt: '2026-06-23T00:00:00Z',
    targets: [{}, {}, {}], comparison: { fastestTtft: 'OpenRouter', flags: [{}, {}] },
  }, 'my-id', 'user');
  assert.equal(e.id, 'my-id');
  assert.equal(e.model, 'gemini-2.5-flash');
  assert.equal(e.targetCount, 3);
  assert.equal(e.fastestTtft, 'OpenRouter');
  assert.equal(e.flagCount, 2);
  assert.equal(e.source, 'user');
  assert.equal(e.demo, false);
});

test('upsertIndex: prepends new entry, dedupes by id, seeds empty index', () => {
  const seeded = upsertIndex(null, { id: 'a' }, '2026-06-23T00:00:00Z');
  assert.equal(seeded.schema, 'gwbench-reports-index/1');
  assert.deepEqual(seeded.reports.map((r) => r.id), ['a']);

  const two = upsertIndex(seeded, { id: 'b' }, '2026-06-23T01:00:00Z');
  assert.deepEqual(two.reports.map((r) => r.id), ['b', 'a']); // newest first

  const replaced = upsertIndex(two, { id: 'a', model: 'updated' }, '2026-06-23T02:00:00Z');
  assert.deepEqual(replaced.reports.map((r) => r.id), ['a', 'b']); // a moved to front, no dup
  assert.equal(replaced.reports.length, 2);
  assert.equal(replaced.reports[0].model, 'updated');
  assert.equal(replaced.updatedAt, '2026-06-23T02:00:00Z');
});
