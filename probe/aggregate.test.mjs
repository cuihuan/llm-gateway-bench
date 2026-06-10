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
