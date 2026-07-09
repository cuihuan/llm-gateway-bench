import test from 'node:test';
import assert from 'node:assert/strict';
import {
  percentile, summarize, roundMedians, overheadVerdict,
  startMockUpstream, MOCK_COMPLETION, measure,
} from './overhead.mjs';

test('percentile: median of odd/even lists, interpolation, edges', () => {
  assert.equal(percentile([3, 1, 2], 50), 2);
  assert.equal(percentile([1, 2, 3, 4], 50), 2.5);
  assert.equal(percentile([10], 99), 10);
  assert.equal(percentile([], 50), null);
  assert.equal(percentile([1, 2, 3, 4, 5], 0), 1);
  assert.equal(percentile([1, 2, 3, 4, 5], 100), 5);
});

test('summarize reports n/p50/p90/p99/min/max rounded to 0.01', () => {
  const s = summarize([1.111, 2.222, 3.333]);
  assert.equal(s.n, 3);
  assert.equal(s.p50, 2.22);
  assert.equal(s.min, 1.11);
  assert.equal(s.max, 3.33);
});

test('roundMedians maps rounds to their medians', () => {
  assert.deepEqual(roundMedians([[1, 2, 3], [10, 20, 30]]), [2, 20]);
});

test('overheadVerdict: median-of-medians delta with IQR', () => {
  // 3 rounds: direct medians 10,10,10; gateway medians 12,13,14 -> deltas 2,3,4
  const direct = [[10, 10, 10], [10, 10, 10], [10, 10, 10]];
  const gw = [[12, 12, 12], [13, 13, 13], [14, 14, 14]];
  const v = overheadVerdict(direct, gw);
  assert.equal(v.rounds, 3);
  assert.equal(v.direct_ms, 10);
  assert.equal(v.gateway_ms, 13);
  assert.equal(v.overhead_ms, 3);
  assert.deepEqual(v.overhead_iqr_ms, [2.5, 3.5]);
});

test('mock upstream answers chat/completions with canned OpenAI shape', async () => {
  const { server, port } = await startMockUpstream(0);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'mock-model', messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.model, MOCK_COMPLETION.model);
    assert.equal(body.choices[0].message.content, 'ok');
    // /v1/models also answers (gateways often health-check it)
    const models = await (await fetch(`http://127.0.0.1:${port}/v1/models`)).json();
    assert.equal(models.data[0].id, 'mock-model');
  } finally {
    server.close();
  }
});

test('measure self-test: direct-vs-direct overhead ~0 (sanity of the harness)', async () => {
  const { server, port } = await startMockUpstream(0);
  try {
    const url = `http://127.0.0.1:${port}/v1/chat/completions`;
    const m = await measure({ directUrl: url, gatewayUrl: url, rounds: 5, perRound: 10, warmup: 5 });
    const v = overheadVerdict(m.directRounds, m.gatewayRounds);
    // same endpoint on both arms: |overhead| must be small. This guards against
    // systematic harness bias (which shows up as a large persistent offset), not
    // scheduler noise — shared CI runners have been observed to jitter past 2ms
    // (-2.19ms, 2026-07-08 run), so the bound is 5ms.
    assert.ok(Math.abs(v.overhead_ms) < 5, `self-test overhead ${v.overhead_ms}ms too large`);
    assert.equal(m.directAll.length, 50);
  } finally {
    server.close();
  }
});
