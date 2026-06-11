import test from 'node:test';
import assert from 'node:assert/strict';
import { percentile, summarize, stabilityOverTime, evalToolCall, isBurstStream } from './metrics.mjs';

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

test('summarize: usageReportedRate over successful samples only', () => {
  const s = summarize([
    { ok: true, ttftMs: 100, usageReported: true },
    { ok: true, ttftMs: 100, usageReported: false },
    { ok: false, error: 'HTTP 502' },
  ]);
  assert.equal(s.usageReportedRate, 0.5);
  assert.equal(summarize([{ ok: false, error: 'x' }]).usageReportedRate, null);
});

test('isBurstStream: fake-stream fingerprint vs legit fast/slow streaming', () => {
  // 假流式：等 3s 才出首 token，然后 30 个 chunk 在 50ms 内 dump 完
  assert.equal(isBurstStream({ chunks: 30, ttftMs: 3000, streamWindowMs: 50 }), true);
  // 快但真流式（LPU 类）：ttft 很小 → 不误伤
  assert.equal(isBurstStream({ chunks: 30, ttftMs: 90, streamWindowMs: 60 }), false);
  // 慢但真流式：窗口大 → 不误伤
  assert.equal(isBurstStream({ chunks: 30, ttftMs: 1500, streamWindowMs: 2400 }), false);
  // 窗口在阈值内但 ttft 不足窗口 4 倍（900 < 960）→ 证据不足，不判假
  assert.equal(isBurstStream({ chunks: 10, ttftMs: 900, streamWindowMs: 240 }), false);
  // chunk 太少不可判定
  assert.equal(isBurstStream({ chunks: 3, ttftMs: 3000, streamWindowMs: 10 }), null);
  assert.equal(isBurstStream({ chunks: 8, ttftMs: undefined, streamWindowMs: 10 }), null);
});

test('summarize: burstStreamRate over judgeable ok samples only', () => {
  const s = summarize([
    { ok: true, ttftMs: 3000, chunks: 20, streamWindowMs: 40 },   // 假流式
    { ok: true, ttftMs: 200, chunks: 20, streamWindowMs: 1500 },  // 真流式
    { ok: true, ttftMs: 500, chunks: 2, streamWindowMs: 5 },      // 不可判定（chunk 少）
    { ok: false, error: 'HTTP 502' },
  ]);
  assert.equal(s.burstStreamRate, 0.5);
  assert.equal(summarize([{ ok: true, ttftMs: 100, chunks: 1 }]).burstStreamRate, null);
});

test('evalToolCall: valid call passes, wrong tool / bad args / missing rejected', () => {
  const body = (call) => ({ choices: [{ message: { tool_calls: call ? [call] : undefined } }] });
  assert.equal(evalToolCall(body({ function: { name: 'get_time', arguments: '{"city":"Tokyo"}' } }), 'get_time').ok, true);
  assert.equal(evalToolCall(body({ function: { name: 'other_fn', arguments: '{}' } }), 'get_time').ok, false);
  assert.equal(evalToolCall(body({ function: { name: 'get_time', arguments: '{broken' } }), 'get_time').ok, false);
  assert.equal(evalToolCall(body(null), 'get_time').ok, false);
  assert.equal(evalToolCall(undefined, 'get_time').ok, false);
  assert.equal(evalToolCall({ choices: [{ message: { content: 'plain text answer' } }] }, 'get_time').ok, false);
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
