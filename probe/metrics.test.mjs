import test from 'node:test';
import assert from 'node:assert/strict';
import { percentile, summarize, stabilityOverTime } from './metrics.mjs';

test('percentile: empty and basic cases', () => {
  assert.equal(percentile([], 50), null);
  assert.equal(percentile([42], 50), 42);
  assert.equal(percentile([1, 2, 3, 4], 50), 2.5);
  assert.equal(percentile([3, 1, 2], 0), 1); // unsorted input
  assert.equal(percentile([3, 1, 2], 100), 3);
  assert.throws(() => percentile([1], 101), RangeError);
});

test('summarize: mixed success and failure samples', () => {
  const s = summarize([
    { ok: true, ttftMs: 100, tokensPerSec: 50, totalMs: 1000 },
    { ok: true, ttftMs: 300, tokensPerSec: 30, totalMs: 2000 },
    { ok: false, error: 'HTTP 502' },
    { ok: false, error: 'timeout' },
  ]);
  assert.equal(s.samples, 4);
  assert.equal(s.success, 2);
  assert.equal(s.successRate, 0.5);
  assert.equal(s.ttftMs.avg, 200);
  assert.equal(s.ttftMs.p50, 200);
  assert.equal(s.tokensPerSec.avg, 40);
  assert.deepEqual(s.errors, ['HTTP 502', 'timeout']);
});

test('summarize: all failures yields null metrics, not NaN', () => {
  const s = summarize([{ ok: false, error: 'ECONNREFUSED' }]);
  assert.equal(s.successRate, 0);
  assert.equal(s.ttftMs.avg, null);
  assert.equal(s.tokensPerSec.p50, null);
});

test('summarize: empty input', () => {
  const s = summarize([]);
  assert.equal(s.samples, 0);
  assert.equal(s.successRate, null);
});

test('stabilityOverTime: averages daily success rates equally', () => {
  const r = stabilityOverTime([
    { date: '2026-06-01', successRate: 1, ttftP50: 100 },
    { date: '2026-06-02', successRate: 0.5, ttftP50: 200 },
    { date: '2026-06-03', successRate: null },
  ]);
  assert.equal(r.days, 2);
  assert.equal(r.uptimePct, 75);
  assert.deepEqual(r.ttftP50TrendMs.map((d) => d.ttftP50), [100, 200]);
});

test('stabilityOverTime: no valid days', () => {
  assert.deepEqual(stabilityOverTime([]), { days: 0, uptimePct: null, ttftP50TrendMs: [] });
});
