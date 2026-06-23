import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyError, rollupGateway, priceIndex, pickPrimaryRegion } from './aggregate.mjs';

test('classifyError: maps error strings to classes', () => {
  assert.equal(classifyError('HTTP 403 {"error":"model_not_allowed"}'), 'auth');
  assert.equal(classifyError('HTTP 401 unauthorized'), 'auth');
  assert.equal(classifyError('HTTP 429 too many requests'), '429');
  assert.equal(classifyError('HTTP 400 bad request'), 'user');     // 其余 4xx = 用户/配置侧
  assert.equal(classifyError('HTTP 404 model not found'), 'user');
  assert.equal(classifyError('HTTP 422 unprocessable'), 'user');
  assert.equal(classifyError('HTTP 502 bad gateway'), '5xx');
  assert.equal(classifyError('timeout'), 'timeout');
  assert.equal(classifyError('This operation was aborted'), 'timeout');
  assert.equal(classifyError('ECONNRESET'), 'other');
  assert.equal(classifyError(undefined), 'other');
});

test('rollupGateway: non-auth 4xx (model absent / bad request) excluded from uptime like auth', () => {
  // 404「该网关没有这个模型」是配置问题,不是宕机——对齐 OpenRouter 口径,排除出分母
  const r = rollupGateway([
    run('2026-06-10T06:00:00.000Z', [
      { model: 'a', samples: 3, success: 3, ttftMs: { p50: 600 }, tokensPerSec: { avg: 70 }, errors: [] },
      { model: 'b', samples: 3, success: 0, ttftMs: {}, tokensPerSec: {}, errors: ['HTTP 404 model not found'] },
    ]),
  ], '2026-06-10');
  assert.equal(r.uptimePct, 100);          // model b 全部排除,不算宕机
  assert.equal(r.authExcluded, 3);         // 3 个样本计入"排除出可用率"
  assert.equal(r.probes, 3);
  assert.deepEqual(r.errors, { '429': 0, '5xx': 0, timeout: 0, other: 0 }); // user 不进 errors
});

test('rollupGateway: 4xx-user mixed with real 5xx — only the 5xx counts against uptime', () => {
  const r = rollupGateway([
    run('2026-06-10T06:00:00.000Z', [
      { model: 'a', samples: 3, success: 0, ttftMs: {}, tokensPerSec: {}, errors: ['HTTP 400 bad', 'HTTP 502 down', 'HTTP 404 absent'] },
    ]),
  ], '2026-06-10');
  assert.equal(r.authExcluded, 2);   // 400 + 404 排除
  assert.equal(r.probes, 1);         // 只剩 1 个真实样本
  assert.equal(r.uptimePct, 0);      // 那个样本是真实 5xx 故障
  assert.equal(r.errors['5xx'], 1);
});

test('rollupGateway: 429 stays counted as a real availability signal (not excluded)', () => {
  const r = rollupGateway([
    run('2026-06-10T06:00:00.000Z', [
      { model: 'a', samples: 4, success: 2, ttftMs: { p50: 600 }, tokensPerSec: { avg: 70 }, errors: ['HTTP 429 rate limited', 'HTTP 429 rate limited'] },
    ]),
  ], '2026-06-10');
  assert.equal(r.authExcluded, 0);   // 429 不排除
  assert.equal(r.probes, 4);
  assert.equal(r.uptimePct, 50);     // 2/4
  assert.equal(r.errors['429'], 2);
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

test('rollupGateway: usageByModel from latest run carries per-model fingerprint', () => {
  const r = rollupGateway([
    run('2026-06-10T06:00:00.000Z', [
      { model: 'a', samples: 1, success: 1, ttftMs: { p50: 600 }, tokensPerSec: { avg: 70 }, errors: [], usage: { promptTokens: 30, charsPerToken: 3.8 } },
      { model: 'b', samples: 1, success: 1, ttftMs: { p50: 650 }, tokensPerSec: { avg: 65 }, errors: [], usage: { promptTokens: 31, charsPerToken: null } },
      { model: 'c', samples: 1, success: 0, ttftMs: {}, tokensPerSec: {}, errors: ['HTTP 502'] }, // no usage
    ]),
  ], '2026-06-10');
  assert.deepEqual(r.usageByModel, [
    { model: 'a', charsPerToken: 3.8, promptTokens: 30 },
    { model: 'b', charsPerToken: null, promptTokens: 31 },
  ]);
});

test('rollupGateway: usageByModel null when no usage data', () => {
  const r = rollupGateway([
    run('2026-06-10T06:00:00.000Z', [
      { model: 'a', samples: 1, success: 1, ttftMs: { p50: 600 }, tokensPerSec: { avg: 70 }, errors: [] },
    ]),
  ], '2026-06-10');
  assert.equal(r.usageByModel, null);
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

test('rollupGateway: integrity snapshot counts pass/total per check from latest run', () => {
  const r = rollupGateway([
    run('2026-06-10T06:00:00.000Z', [
      { model: 'a', samples: 1, success: 1, ttftMs: { p50: 600 }, tokensPerSec: { avg: 70 }, errors: [],
        modelEchoRate: 1, cjk: { ok: true }, needle: { ok: true } },
      { model: 'b', samples: 1, success: 1, ttftMs: { p50: 650 }, tokensPerSec: { avg: 65 }, errors: [],
        modelEchoRate: 0, cjk: { ok: false }, needle: { ok: true } },
    ]),
  ], '2026-06-10');
  assert.deepEqual(r.integrity.modelEcho, { ok: 1, total: 2 });
  assert.deepEqual(r.integrity.cjk, { ok: 1, total: 2 });
  assert.deepEqual(r.integrity.needle, { ok: 2, total: 2 });
});

test('rollupGateway: integrity checks null when no judgeable models', () => {
  const r = rollupGateway([
    run('2026-06-10T06:00:00.000Z', [
      { model: 'a', samples: 1, success: 1, ttftMs: { p50: 600 }, tokensPerSec: { avg: 70 }, errors: [] },
    ]),
  ], '2026-06-10');
  assert.equal(r.integrity.modelEcho, null);
  assert.equal(r.integrity.cjk, null);
  assert.equal(r.integrity.needle, null);
});

test('rollupGateway: hourly profile and peakDrift expose time-of-day slowdown', () => {
  const mk = (ttft, ok, samples) => ({ model: 'a', samples, success: ok, ttftMs: { p50: ttft }, tokensPerSec: { avg: 60 }, errors: ok < samples ? ['timeout'] : [] });
  const r = rollupGateway([
    run('2026-06-10T07:00:00.000Z', [mk(500, 3, 3)]),   // 07 UTC: fast, healthy
    run('2026-06-10T19:00:00.000Z', [mk(1500, 2, 3)]),  // 19 UTC: 3x slower, degraded
    run('2026-06-09T19:00:00.000Z', [mk(1300, 3, 3)]),  // 19 UTC another day
  ], '2026-06-10');
  const h07 = r.hourly.find((h) => h.hour === 7);
  const h19 = r.hourly.find((h) => h.hour === 19);
  assert.equal(h07.ttftP50, 500);
  assert.equal(h07.okRate, 100);
  assert.equal(h19.ttftP50, 1400);      // median of [1500,1300]
  assert.equal(h19.okRate, 83.3);       // 5/6 ok
  assert.equal(r.peakDrift.ratio, 2.8);  // 1400/500
  assert.equal(r.peakDrift.slowHour, 19);
  assert.equal(r.peakDrift.fastHour, 7);
  assert.equal(r.peakDrift.worstOkRateHour, 19);
});

test('rollupGateway: peakDrift null with fewer than 2 hours of TTFT data', () => {
  const r = rollupGateway([
    run('2026-06-10T07:00:00.000Z', [
      { model: 'a', samples: 3, success: 3, ttftMs: { p50: 500 }, tokensPerSec: { avg: 60 }, errors: [] },
    ]),
  ], '2026-06-10');
  assert.equal(r.peakDrift, null);
  assert.equal(r.hourly.length, 1);
});

test('rollupGateway: empty input yields nulls, not NaN', () => {
  const r = rollupGateway([], '2026-06-10');
  assert.equal(r.uptimePct, null);
  assert.equal(r.probes, 0);
  assert.equal(r.connMs, null);
  assert.ok(r.daysArr.every((d) => d.status === 'n'));
});

test('pickPrimaryRegion: region of the most recent entry; null/unknown handled', () => {
  assert.equal(pickPrimaryRegion([
    { region: 'gh-us', startedAt: '2026-06-10T06:00:00Z' },
    { region: 'local-cn', startedAt: '2026-06-11T06:00:00Z' },  // 最近 → 主地域
  ]), 'local-cn');
  assert.equal(pickPrimaryRegion([{ startedAt: '2026-06-11T06:00:00Z' }]), 'unknown'); // 无 region 标注
  assert.equal(pickPrimaryRegion([]), null);
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
