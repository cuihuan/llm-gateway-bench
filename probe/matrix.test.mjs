import test from 'node:test';
import assert from 'node:assert/strict';
import { matrixSlug, mergeMatrixIndex, matrixIndexEntry } from './matrix.mjs';

test('matrixSlug: filename-safe, prefixed', () => {
  assert.equal(matrixSlug('gemini-2.5-flash'), 'matrix-gemini-2-5-flash');
  assert.equal(matrixSlug('anthropic/Claude Sonnet'), 'matrix-anthropic-claude-sonnet');
  assert.equal(matrixSlug(''), 'matrix-model');
});

test('matrixIndexEntry: baseline source, summary fields from report', () => {
  const e = matrixIndexEntry({
    kind: 'compare', model: 'gemini-2.5-flash', region: 'gh-us', generatedAt: 't', title: 'X · benchmarked across 3 gateways',
    targets: [{}, {}, {}], comparison: { fastestTtft: 'A', cheapest: 'B', flags: [{}, {}] },
  }, 'matrix-gemini-2-5-flash');
  assert.equal(e.id, 'matrix-gemini-2-5-flash');
  assert.equal(e.source, 'baseline');
  assert.equal(e.demo, false);
  assert.equal(e.targetCount, 3);
  assert.equal(e.fastestTtft, 'A');
  assert.equal(e.cheapest, 'B');
  assert.equal(e.flagCount, 2);
});

test('mergeMatrixIndex: replaces all matrix-* entries, keeps demo/user reports', () => {
  const existing = { schema: 'gwbench-reports-index/1', reports: [
    { id: 'matrix-old-a' }, { id: 'demo-gemini-flash', demo: true }, { id: 'matrix-old-b' }, { id: 'user-xyz', source: 'user' },
  ] };
  const fresh = [{ id: 'matrix-gemini-2-5-flash' }, { id: 'matrix-deepseek' }];
  const merged = mergeMatrixIndex(existing, fresh, '2026-06-23T05:00:00Z');
  const ids = merged.reports.map((r) => r.id);
  assert.deepEqual(ids, ['matrix-gemini-2-5-flash', 'matrix-deepseek', 'demo-gemini-flash', 'user-xyz']);
  assert.ok(!ids.includes('matrix-old-a') && !ids.includes('matrix-old-b'), 'old matrix entries removed');
  assert.equal(merged.updatedAt, '2026-06-23T05:00:00Z');
});

test('mergeMatrixIndex: seeds schema when index missing', () => {
  const merged = mergeMatrixIndex(null, [{ id: 'matrix-a' }], 't');
  assert.equal(merged.schema, 'gwbench-reports-index/1');
  assert.deepEqual(merged.reports.map((r) => r.id), ['matrix-a']);
});
