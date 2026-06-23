import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTarget, buildComparison, buildReport, renderReportHtml, priceIdxFor, buildBaselineRef, buildPriceMatrixReport, buildGap } from './report.mjs';

// 一个典型的 probeGateway 产出（含 summarize 的字段形状）。
const okRaw = {
  name: 'OpenRouter', host: 'openrouter.ai', connectivity: { ok: true, latencyMs: 120 },
  models: [{
    model: 'google/gemini-2.5-flash', samples: 3, success: 3, successRate: 1,
    ttftMs: { avg: 510, p50: 500, p95: 880 }, tokensPerSec: { avg: 47.2, p50: 46 },
    burstStreamRate: 0, modelEchoRate: 1,
    toolCall: { ok: true, totalMs: 900 }, cjk: { ok: true }, needle: { ok: true },
    usage: { promptTokens: 21, charsPerToken: 3.8 }, errors: [],
  }],
};

test('buildTarget: flattens a healthy probe result, no key/baseUrl leak', () => {
  const t = buildTarget(okRaw);
  assert.equal(t.name, 'OpenRouter');
  assert.equal(t.host, 'openrouter.ai');
  assert.equal(t.connMs, 120);
  assert.equal(t.ttftMs.p50, 500);
  assert.equal(t.ttftMs.p95, 880);
  assert.equal(t.tokensPerSec, 47.2);
  assert.equal(t.successRate, 1);
  assert.equal(t.toolCall, true);
  assert.equal(t.burstStream, false);
  assert.equal(t.modelEcho, true);
  assert.equal(t.cjk, true);
  assert.equal(t.needle, true);
  assert.equal(t.error, null);
  // 隐私红线：序列化后不得出现 key / baseUrl / Authorization
  const s = JSON.stringify(t);
  assert.ok(!/sk-|Bearer|https?:\/\//.test(s), 'target must not embed secrets or full URLs');
});

test('buildTarget: tri-state nulls when a probe has no verdict', () => {
  const t = buildTarget({ name: 'X', host: 'x.io', models: [{
    samples: 2, success: 2, successRate: 1, ttftMs: { p50: 200, p95: 300 },
    tokensPerSec: { avg: 10 }, burstStreamRate: null, modelEchoRate: null, errors: [],
    // no toolCall / cjk / needle / usage
  }] });
  assert.equal(t.toolCall, null);
  assert.equal(t.burstStream, null);
  assert.equal(t.modelEcho, null);
  assert.equal(t.cjk, null);
  assert.equal(t.needle, null);
  assert.equal(t.usage, null);
});

test('buildTarget: failed target surfaces first error, metrics null', () => {
  const t = buildTarget({ name: 'Dead', host: 'dead.io', models: [{
    samples: 3, success: 0, successRate: 0, ttftMs: { p50: null, p95: null },
    tokensPerSec: { avg: null }, errors: ['HTTP 502 bad gateway'],
  }] });
  assert.equal(t.error, 'HTTP 502 bad gateway');
  assert.equal(t.successRate, 0);
});

test('buildTarget: no model probed → safe empty target with error', () => {
  const t = buildTarget({ name: 'NoModel', host: 'n.io', models: [] });
  assert.equal(t.ttftMs.p50, null);
  assert.equal(t.error, 'no model probed');
});

test('priceIdxFor: averages in/out ratios vs official; null on missing/zero', () => {
  assert.equal(priceIdxFor([2, 8], [1, 4]), 2); // (2/1 + 8/4)/2 = 2
  assert.equal(priceIdxFor([0.5, 2], [1, 4]), 0.5);
  assert.equal(priceIdxFor([1, 4], null), null);
  assert.equal(priceIdxFor(null, [1, 4]), null);
  assert.equal(priceIdxFor([1, 4], [0, 4]), null); // zero official
});

test('buildTarget: carries price + computes priceIdx vs official', () => {
  const t = buildTarget({ ...okRaw, price: [0.15, 0.6], official: [0.3, 1.2] });
  assert.deepEqual(t.price, [0.15, 0.6]);
  assert.equal(t.priceIdx, 0.5); // half of official
  const noPrice = buildTarget(okRaw);
  assert.equal(noPrice.price, null);
  assert.equal(noPrice.priceIdx, null);
});

test('buildComparison: picks cheapest by in+out and flags <0.5x as reverse-channel', () => {
  const cmp = buildComparison([
    { name: 'Official', ttftMs: { p50: 500 }, tokensPerSec: 40, successRate: 1, price: [1, 4], priceIdx: 1 },
    { name: 'Cheap', ttftMs: { p50: 500 }, tokensPerSec: 40, successRate: 1, price: [0.2, 0.8], priceIdx: 0.2 },
  ]);
  assert.equal(cmp.cheapest, 'Cheap');
  const cheapFlag = cmp.flags.find((f) => f.target === 'Cheap' && f.flag === 'cheapPrice');
  assert.ok(cheapFlag, 'sub-0.5x price raises reverse-channel flag');
  assert.equal(cheapFlag.severity, 'warn');
});

test('buildTarget + buildGap: cache dimension (supported/none/unknown)', () => {
  const withCache = buildTarget({ name: 'C', host: 'c.io', models: [{
    samples: 2, success: 2, successRate: 1, ttftMs: { p50: 300 }, tokensPerSec: { avg: 50 }, errors: [],
    cache: { ok: true, reported: true, supported: true, cachedTokens: 1200 },
  }] });
  assert.equal(withCache.cache, true);
  const noCache = buildTarget({ name: 'N', host: 'n.io', models: [{ samples: 1, success: 1, successRate: 1, ttftMs: { p50: 300 }, tokensPerSec: { avg: 50 }, errors: [], cache: { ok: true, reported: true, supported: false } }] });
  assert.equal(noCache.cache, false);
  assert.equal(buildTarget(okRaw).cache, null); // okRaw has no cache field
  const gap = buildGap([withCache], [{ name: 'X', ttftP50: 500, tps: 40, uptimePct: 99 }], 'C');
  assert.equal(gap.cache.mine, true);
  assert.ok(gap.summary.includes('缓存命中'));
});

test('buildComparison: picks fastest TTFT and highest throughput', () => {
  const cmp = buildComparison([
    { name: 'A', ttftMs: { p50: 800 }, tokensPerSec: 30, successRate: 1 },
    { name: 'B', ttftMs: { p50: 300 }, tokensPerSec: 60, successRate: 1 },
    { name: 'C', ttftMs: { p50: 200 }, tokensPerSec: 20, successRate: 0 }, // no success → excluded
  ]);
  assert.equal(cmp.fastestTtft, 'B');
  assert.equal(cmp.highestThroughput, 'B');
});

test('buildComparison: raises flags with severity (substitution=alert)', () => {
  const cmp = buildComparison([
    { name: 'Sketchy', ttftMs: { p50: 400 }, tokensPerSec: 40, successRate: 1,
      modelEcho: false, burstStream: true, needle: false, cjk: false, toolCall: false, error: null },
    { name: 'Clean', ttftMs: { p50: 400 }, tokensPerSec: 40, successRate: 1,
      modelEcho: true, burstStream: false, needle: true, cjk: true, toolCall: true, error: null },
  ]);
  const sketchy = cmp.flags.filter((f) => f.target === 'Sketchy');
  assert.equal(sketchy.length, 5);
  assert.equal(sketchy.find((f) => f.flag === 'modelEcho').severity, 'alert');
  assert.equal(sketchy.find((f) => f.flag === 'burstStream').severity, 'warn');
  assert.equal(cmp.flags.filter((f) => f.target === 'Clean').length, 0);
});

test('buildReport: assembles schema, tool, comparison; generatedAt injected', () => {
  const r = buildReport({
    model: 'gemini-2.5-flash', region: 'local-cn', samplesPerTarget: 3,
    generatedAt: '2026-06-23T00:00:00Z', version: '0.2.0',
    targets: [buildTarget(okRaw)],
  });
  assert.equal(r.schema, 'gwbench-report/1');
  assert.equal(r.kind, 'compare');
  assert.equal(r.tool.name, 'gwbench');
  assert.equal(r.tool.version, '0.2.0');
  assert.equal(r.model, 'gemini-2.5-flash');
  assert.equal(r.generatedAt, '2026-06-23T00:00:00Z');
  assert.equal(r.comparison.fastestTtft, 'OpenRouter');
});

test('renderReportHtml: self-contained, embeds data, escapes, no secret leak', () => {
  const r = buildReport({
    model: 'gemini-2.5-flash', region: 'local-cn', samplesPerTarget: 3,
    generatedAt: '2026-06-23T00:00:00Z', version: '0.2.0',
    targets: [buildTarget(okRaw)],
  });
  const html = renderReportHtml(r);
  assert.ok(html.startsWith('<!DOCTYPE html>'));
  assert.ok(html.includes('OpenRouter'));
  assert.ok(html.includes('gwbench-report'));         // embedded JSON block id
  assert.ok(html.includes('gemini-2.5-flash'));
  assert.ok(!/sk-|Bearer/.test(html), 'rendered report must not contain secrets');
});

test('renderReportHtml: renders price + multiplier columns and cheapest winner', () => {
  const r = buildReport({ model: 'm', generatedAt: 't', version: '0.2.0', targets: [
    buildTarget({ ...okRaw, name: 'Cheap', price: [0.15, 0.6], official: [0.3, 1.2] }),
  ] });
  const html = renderReportHtml(r);
  assert.ok(html.includes('价格 入/出'), 'price column header');
  assert.ok(html.includes('0.15/0.6'), 'per-target price shown');
  assert.ok(html.includes('0.5×'), 'price multiplier shown');
  assert.ok(html.includes('最便宜'), 'cheapest winner shown');
});

test('buildBaselineRef: extracts gateway headline, sorts by uptime, skips empty', () => {
  const ref = buildBaselineRef({ gateways: [
    { name: 'A', host: 'a.io', uptimePct: 98.2, speed: { ttftP50: 600 }, priceIdx: 1.1, region: 'gh-us', lastRun: 't1' },
    { name: 'B', host: 'b.io', uptimePct: 99.9, speed: { ttftP50: 500 }, priceIdx: 0.9, region: 'gh-us' },
    { name: 'Empty', host: 'e.io' }, // no data → skipped
  ] });
  assert.equal(ref.length, 2);
  assert.equal(ref[0].name, 'B'); // higher uptime first
  assert.equal(ref[0].ttftP50, 500);
  assert.equal(ref[1].name, 'A');
});

test('buildReport: attaches baseline only when non-empty', () => {
  const withBase = buildReport({ model: 'm', generatedAt: 't', targets: [], baseline: [{ name: 'X', uptimePct: 99 }] });
  assert.equal(withBase.baseline.length, 1);
  const noBase = buildReport({ model: 'm', generatedAt: 't', targets: [], baseline: [] });
  assert.ok(!('baseline' in noBase), 'empty baseline omitted');
});

test('buildGap: 你 vs 最好——逐维度差距，含基线作为最优候选', () => {
  const mineT = buildTarget({ name: '我的网关', host: 'mine.io', price: [0.4, 1.6], official: [0.3, 1.2], models: [{
    samples: 3, success: 3, successRate: 1, ttftMs: { p50: 700, p95: 900 }, tokensPerSec: { avg: 40 },
    modelEchoRate: 1, burstStreamRate: 0, toolCall: { ok: true }, cjk: { ok: true }, needle: { ok: false }, errors: [],
  }] });
  const baseline = [{ name: 'OpenRouter', ttftP50: 500, tps: 50, uptimePct: 99.8 }];
  const gap = buildGap([mineT], baseline, '我的网关');
  assert.equal(gap.mine, '我的网关');
  const ttft = gap.dims.find((d) => d.key === 'ttft');
  assert.equal(ttft.best, 500); assert.equal(ttft.bestName, 'OpenRouter');
  assert.equal(ttft.verdict, '落后'); // 700 vs 500 = 40% slower
  assert.equal(ttft.behindPct, 40);
  const tps = gap.dims.find((d) => d.key === 'tps');
  assert.equal(tps.verdict, '落后'); // 40 vs 50 = 20% below
  // 价格按倍率对标官方：mine [0.4,1.6] vs official [0.3,1.2] → idx 1.33，best=官方价 1.0× → 落后
  const price = gap.dims.find((d) => d.key === 'price');
  assert.equal(price.yours, 1.33);
  assert.equal(price.best, 1); assert.equal(price.bestName, '官方价');
  assert.equal(price.verdict, '落后');
  assert.equal(gap.integrity.ok, false);
  assert.deepEqual(gap.integrity.failed, ['长文本']); // needle failed
  assert.ok(gap.summary.includes('TTFT落后40%'));
});

test('buildGap: 你最优的维度标 最优；mine 不存在 → null', () => {
  const mineT = buildTarget({ name: 'Fast', host: 'f.io', models: [{
    samples: 2, success: 2, successRate: 1, ttftMs: { p50: 300 }, tokensPerSec: { avg: 80 }, errors: [],
  }] });
  const gap = buildGap([mineT], [{ name: 'Slower', ttftP50: 600, tps: 40, uptimePct: 99 }], 'Fast');
  assert.equal(gap.dims.find((d) => d.key === 'ttft').verdict, '最优');
  assert.equal(gap.dims.find((d) => d.key === 'tps').verdict, '最优');
  assert.equal(buildGap([mineT], [], '不存在的'), null);
});

test('buildReport: mine 给定时附 gap；renderReportHtml 顶部出差距体检卡', () => {
  const mineT = buildTarget({ name: '我的', host: 'm.io', models: [{ samples: 2, success: 2, successRate: 1, ttftMs: { p50: 800 }, tokensPerSec: { avg: 30 }, errors: [] }] });
  const r = buildReport({ model: 'm', generatedAt: 't', version: '0.2.0', targets: [mineT],
    baseline: [{ name: 'Best', ttftP50: 400, tps: 60, uptimePct: 99.9 }], mine: '我的' });
  assert.ok(r.gap, 'report 带 gap');
  const html = renderReportHtml(r);
  assert.ok(html.includes('差距体检'), '渲染差距体检卡');
  assert.ok(html.includes('最好'), '显示最好的值');
});

test('buildPriceMatrixReport: real public pricing → model×gateway matrix, cheapest per row', () => {
  const prices = {
    fetchedAt: '2026-06-13T12:55:33Z',
    sources: { official: 'litellm', synthorai: 'https://synthorai.io/api/pricing', openrouter: 'https://openrouter.ai/api/v1/models' },
    models: [
      { model: 'gemini-2.5-flash', official: [0.3, 2.5], cells: { synthorai: [0.3, 2.5], openrouter: [0.3, 2.5] } },
      { model: 'deepseek-v4-flash', official: null, cells: { synthorai: [0.138, 0.275], openrouter: [0.098, 0.196] } },
    ],
  };
  const pm = buildPriceMatrixReport(prices, { gateways: [{ id: 'synthorai', name: 'Synthorai' }, { id: 'openrouter', name: 'OpenRouter' }], generatedAt: 't', version: '0.2.0' });
  assert.equal(pm.kind, 'pricematrix');
  assert.deepEqual(pm.gateways.map((g) => g.name), ['Synthorai', 'OpenRouter']);
  assert.equal(pm.rows.length, 2);
  // deepseek: openrouter cheaper (0.098+0.196 < 0.138+0.275)
  assert.equal(pm.rows.find((r) => r.model === 'deepseek-v4-flash').cheapest, 'openrouter');
  // gemini: idx vs official = 1.0
  assert.equal(pm.rows[0].cells.synthorai.idx, 1);
  // no official → idx null but price still present
  assert.equal(pm.rows[1].cells.openrouter.idx, null);
  assert.deepEqual(pm.rows[1].cells.openrouter.price, [0.098, 0.196]);
});

test('renderReportHtml: renders pricematrix table, no-key caption, cheapest highlight', () => {
  const prices = { fetchedAt: '2026-06-13T12:55:33Z', sources: { official: 'litellm' },
    models: [{ model: 'deepseek-v4-flash', official: null, cells: { synthorai: [0.138, 0.275], openrouter: [0.098, 0.196] } }] };
  const pm = buildPriceMatrixReport(prices, { gateways: [{ id: 'synthorai', name: 'Synthorai' }, { id: 'openrouter', name: 'OpenRouter' }], generatedAt: 't', version: '0.2.0' });
  const html = renderReportHtml(pm);
  assert.ok(html.includes('价格横评'), 'pricematrix title');
  assert.ok(html.includes('无需 key'), 'no-key honesty caption');
  assert.ok(html.includes('class="r cheap"'), 'cheapest cell highlighted');
  assert.ok(html.includes('deepseek-v4-flash'));
  assert.ok(!/sk-|Bearer/.test(html));
});

test('renderReportHtml: renders public-baseline reference section when present', () => {
  const r = buildReport({ model: 'm', generatedAt: 't', version: '0.2.0',
    targets: [buildTarget(okRaw)],
    baseline: [{ name: 'OpenRouter', host: 'openrouter.ai', uptimePct: 99.8, ttftP50: 510, priceIdx: 1.0, region: 'gh-us' }] });
  const html = renderReportHtml(r);
  assert.ok(html.includes('公共基线参照'), 'baseline section heading');
  assert.ok(html.includes('99.8%'), 'baseline uptime shown');
  assert.ok(html.includes('没有别家 key 也能对个大概'), 'honest caption');
});

test('renderReportHtml: includes serverless share affordance (download + share link)', () => {
  const r = buildReport({ model: 'm', generatedAt: 't', version: '0.2.0', targets: [buildTarget(okRaw)] });
  const html = renderReportHtml(r);
  assert.ok(html.includes('id="gw-dl"'), 'has download button');
  assert.ok(html.includes('下载报告 JSON'));
  assert.ok(html.includes('分享到报告广场'), 'has share-to-gallery link');
  assert.ok(html.includes('createObjectURL'), 'download wired from embedded JSON');
});

test('renderReportHtml: escapes HTML-injection in target names', () => {
  const r = buildReport({ model: 'm', generatedAt: 't', targets: [
    buildTarget({ name: '<script>alert(1)</script>', host: 'x.io', models: [okRaw.models[0]] }),
  ] });
  const html = renderReportHtml(r);
  assert.ok(!html.includes('<script>alert(1)</script>'), 'raw script tag must be escaped');
  assert.ok(html.includes('&lt;script&gt;'), 'name should appear escaped');
});
