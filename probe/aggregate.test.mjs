import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyError, rollupGateway, priceIndex } from './aggregate.mjs';

test('classifyError: maps error strings to classes', () => {
  assert.equal(classifyError('HTTP 403 {"error":"model_not_allowed"}'), 'auth');
  assert.equal(classifyError('HTTP 401 unauthorized'), 'auth');
  assert.equal(classifyError('HTTP 429 too many requests'), '429');
  assert.equal(classifyError('HTTP 502 bad gateway'), '5xx');
  assert.equal(classifyError('timeout'), 'timeout');
  assert.equal(classifyError('This operation was aborted'), 'timeout');
  assert.equal(classifyError('ECONNRESET'), 'other');
  assert.equal(classifyError(undefined), 'other');
});

const run = (startedAt, models, conn = { ok: true, latencyMs: 100, modelCount: 10 }) =>
  ({ startedAt, connectivity: conn, models });

test('rollupGateway: auth-only failures are excluded from stability, not counted as downtime', () => {
  const r = rollupGateway([
    run('2026-06-10T06:00:00.000Z', [
      { model: 'a', samples: 3, success: 3, ttftMs: { p50: 1500, p95: 1800 }, tokensPerSec: { avg: 900 }, errors: [] },
      { model: 'b', samples: 3, success: 0, ttftMs: {}, tokensPerSec: {}, errors: ['HTTP 403 model_not_allowed'] },
    ]),
  ], '2026-06-10');
  assert.equal(r.uptimePct, 100);          // model b fully excluded
  assert.equal(r.authExcluded, 3);
  assert.equal(r.probes, 3);
  assert.equal(r.daysArr.at(-1).status, 'g');
  assert.equal(r.speed.ttftP50, 1500);
  assert.equal(r.speed.tps, 900);
  assert.equal(r.connMs, 100);
  assert.equal(r.modelCount, 10);
});

test('rollupGateway: real failures lower uptime and are classified', () => {
  const r = rollupGateway([
    run('2026-06-09T06:00:00.000Z', [
      { model: 'a', samples: 4, success: 2, ttftMs: { p50: 800 }, tokensPerSec: { avg: 50 }, errors: ['HTTP 502 x', 'timeout'] },
    ]),
    run('2026-06-10T06:00:00.000Z', [
      { model: 'a', samples: 4, success: 4, ttftMs: { p50: 700, p95: 900 }, tokensPerSec: { avg: 60 }, errors: [] },
    ]),
  ], '2026-06-10');
  assert.equal(r.uptimePct, 75);           // 6/8
  assert.equal(r.errors['5xx'], 1);
  assert.equal(r.errors.timeout, 1);
  assert.equal(r.daysArr.at(-2).status, 'b'); // 2/4 = 50% < 80%
  assert.equal(r.daysArr.at(-1).status, 'g');
  assert.equal(r.daysArr.length, 30);
  assert.equal(r.daysArr[0].status, 'n');  // no data 30 days ago
  assert.equal(r.speed.trend.length, 2);
  assert.equal(r.speed.ttftP50, 700);      // from latest run only
});

test('rollupGateway: mixed run — auth samples excluded per-sample, successes still count', () => {
  // 4 samples, 3 ok, 1 fails with 401: the auth sample must NOT count as downtime
  // and must NOT make the day an outage, only be disclosed via authExcluded.
  const r = rollupGateway([
    run('2026-06-10T06:00:00.000Z', [
      { model: 'a', samples: 4, success: 3, ttftMs: { p50: 500 }, tokensPerSec: { avg: 80 }, errors: ['HTTP 401 unauthorized'] },
    ]),
  ], '2026-06-10');
  assert.equal(r.uptimePct, 100);
  assert.equal(r.authExcluded, 1);
  assert.equal(r.probes, 3);
  assert.equal(r.daysArr.at(-1).status, 'g');
  assert.deepEqual(r.errors, { '429': 0, '5xx': 0, timeout: 0, other: 0 });
});

test('rollupGateway: auth mixed with real failures — only real ones count against uptime', () => {
  const r = rollupGateway([
    run('2026-06-10T06:00:00.000Z', [
      { model: 'a', samples: 3, success: 0, ttftMs: {}, tokensPerSec: {}, errors: ['HTTP 401 x', 'HTTP 502 y', 'HTTP 401 z'] },
    ]),
  ], '2026-06-10');
  assert.equal(r.authExcluded, 2);
  assert.equal(r.probes, 1);
  assert.equal(r.uptimePct, 0);   // the one counted sample is a real 5xx failure
  assert.equal(r.errors['5xx'], 1);
});

test('rollupGateway: runs older than the 30-day window are excluded from uptime/probes/errors', () => {
  const r = rollupGateway([
    run('2026-01-01T06:00:00.000Z', [
      { model: 'a', samples: 10, success: 0, ttftMs: {}, tokensPerSec: {}, errors: ['HTTP 502 old outage'] },
    ]),
    run('2026-06-10T06:00:00.000Z', [
      { model: 'a', samples: 10, success: 10, ttftMs: { p50: 600, p95: 800 }, tokensPerSec: { avg: 70 }, errors: [] },
    ]),
  ], '2026-06-10');
  assert.equal(r.uptimePct, 100);  // the January outage is outside the window
  assert.equal(r.probes, 10);
  assert.equal(r.errors['5xx'], 0);
  assert.equal(r.lastRun, '2026-06-10T06:00:00.000Z');
});

test('rollupGateway: uptime7dPct only counts the last 7 days', () => {
  const r = rollupGateway([
    run('2026-05-31T06:00:00.000Z', [  // 10 days ago: in 30d window, outside 7d
      { model: 'a', samples: 4, success: 0, ttftMs: {}, tokensPerSec: {}, errors: ['HTTP 502 x'] },
    ]),
    run('2026-06-10T06:00:00.000Z', [
      { model: 'a', samples: 4, success: 4, ttftMs: { p50: 600 }, tokensPerSec: { avg: 70 }, errors: [] },
    ]),
  ], '2026-06-10');
  assert.equal(r.uptimePct, 50);
  assert.equal(r.uptime7dPct, 100);
});

test('rollupGateway: speed snapshot comes from the latest run WITH successes', () => {
  const r = rollupGateway([
    run('2026-06-09T06:00:00.000Z', [
      { model: 'a', samples: 3, success: 3, ttftMs: { p50: 700, p95: 900 }, tokensPerSec: { avg: 60 }, errors: [] },
    ], { ok: true, latencyMs: 90, modelCount: 12 }),
    run('2026-06-10T06:00:00.000Z', [  // full outage: no speed data here
      { model: 'a', samples: 3, success: 0, ttftMs: {}, tokensPerSec: {}, errors: ['HTTP 503 down'] },
    ], { ok: false, latencyMs: null, modelCount: null }),
  ], '2026-06-10');
  assert.equal(r.speed.ttftP50, 700);          // from the 06-09 run
  assert.equal(r.speed.tps, 60);
  assert.equal(r.lastRun, '2026-06-10T06:00:00.000Z'); // current state still latest
  assert.equal(r.uptimePct, 50);
});

test('rollupGateway: tool-call capability snapshot from the latest run', () => {
  const r = rollupGateway([
    run('2026-06-09T06:00:00.000Z', [
      { model: 'a', samples: 1, success: 1, ttftMs: { p50: 700 }, tokensPerSec: { avg: 60 }, errors: [], toolCall: { ok: false, totalMs: 900, error: 'no tool_calls in response' } },
    ]),
    run('2026-06-10T06:00:00.000Z', [
      { model: 'a', samples: 1, success: 1, ttftMs: { p50: 600 }, tokensPerSec: { avg: 70 }, errors: [], toolCall: { ok: true, totalMs: 800 } },
      { model: 'b', samples: 1, success: 1, ttftMs: { p50: 650 }, tokensPerSec: { avg: 65 }, errors: [], toolCall: { ok: false, totalMs: 1200, error: 'arguments not valid JSON' } },
    ]),
  ], '2026-06-10');
  assert.deepEqual(r.toolCalls, { ok: 1, total: 2, nonStreamMs: 1000 }); // latest run only, p50 of [800,1200]
});

test('rollupGateway: stream-burst snapshot counts suspect models from latest run', () => {
  const r = rollupGateway([
    run('2026-06-10T06:00:00.000Z', [
      { model: 'a', samples: 1, success: 1, ttftMs: { p50: 600 }, tokensPerSec: { avg: 70 }, errors: [], burstStreamRate: 1 },
      { model: 'b', samples: 1, success: 1, ttftMs: { p50: 650 }, tokensPerSec: { avg: 65 }, errors: [], burstStreamRate: 0 },
      { model: 'c', samples: 1, success: 1, ttftMs: { p50: 650 }, tokensPerSec: { avg: 65 }, errors: [] }, // 不可判定
    ]),
  ], '2026-06-10');
  assert.deepEqual(r.streamBurst, { suspect: 1, total: 2 });
});

test('rollupGateway: runs without toolCall data yield toolCalls null', () => {
  const r = rollupGateway([
    run('2026-06-10T06:00:00.000Z', [
      { model: 'a', samples: 1, success: 1, ttftMs: { p50: 600 }, tokensPerSec: { avg: 70 }, errors: [] },
    ]),
  ], '2026-06-10');
  assert.equal(r.toolCalls, null);
});

test('rollupGateway: empty input yields nulls, not NaN', () => {
  const r = rollupGateway([], '2026-06-10');
  assert.equal(r.uptimePct, null);
  assert.equal(r.probes, 0);
  assert.equal(r.connMs, null);
  assert.ok(r.daysArr.every((d) => d.status === 'n'));
});

test('priceIndex: geometric mean over comparable models only', () => {
  const models = [
    { model: 'm1', official: [1, 10], cells: { gw: [0.5, 5] } },   // ratio 0.5
    { model: 'm2', official: [2, 20], cells: { gw: [4, 40] } },    // ratio 2.0
    { model: 'm3', official: null, cells: { gw: [1, 1] } },        // skipped: no official
    { model: 'm4', official: [1, 1], cells: {} },                  // skipped: no cell
  ];
  assert.equal(priceIndex(models, 'gw'), 1);                       // sqrt(0.5 × 2.0)
  assert.equal(priceIndex(models, 'absent'), null);
  assert.equal(priceIndex(undefined, 'gw'), null);
});
