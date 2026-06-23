import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTarget, buildComparison, buildReport, renderReportHtml } from './report.mjs';

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
