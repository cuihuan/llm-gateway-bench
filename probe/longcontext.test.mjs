import test from 'node:test';
import assert from 'node:assert/strict';
import { buildHaystack, summarizeGrid, buildLongContextTarget, buildLongContextComparison, buildLongContextReport } from './longcontext.mjs';
import { renderReportHtml } from './report.mjs';

test('buildHaystack: embeds needle at depth, scales with token budget', () => {
  const { content, lines, markerAt } = buildHaystack(11000, 0.5, 'NDL-ABC-XY');
  assert.ok(content.includes('NDL-ABC-XY'), 'needle present');
  assert.ok(lines >= 900 && lines <= 1100, `~1000 filler lines, got ${lines}`);
  assert.ok(markerAt > lines * 0.4 && markerAt < lines * 0.6, 'marker near middle');
  assert.ok(content.includes('IMPORTANT MARKER'));
});

test('buildHaystack: tiny budget still produces a floor of filler', () => {
  const { lines } = buildHaystack(10, 0.1, 'N');
  assert.ok(lines >= 8, 'minimum 8 lines');
});

test('summarizeGrid: maxReliableLen is the largest all-depths-pass length', () => {
  const cells = [
    { lengthTokens: 4000, depthPct: 10, ok: true }, { lengthTokens: 4000, depthPct: 90, ok: true },
    { lengthTokens: 16000, depthPct: 10, ok: true }, { lengthTokens: 16000, depthPct: 90, ok: true },
    { lengthTokens: 64000, depthPct: 10, ok: true }, { lengthTokens: 64000, depthPct: 90, ok: false },
  ];
  const s = summarizeGrid(cells);
  assert.deepEqual(s.lengthsTested, [4000, 16000, 64000]);
  assert.equal(s.maxReliableLen, 16000); // 64K had a failure
});

test('summarizeGrid: failure at the smallest length → null reliable len', () => {
  const s = summarizeGrid([{ lengthTokens: 4000, depthPct: 50, ok: false }]);
  assert.equal(s.maxReliableLen, null);
});

test('buildLongContextComparison: best context + truncators', () => {
  const targets = [
    buildLongContextTarget({ name: 'Solid', host: 's.io', cells: [
      { lengthTokens: 64000, depthPct: 50, ok: true }] }),
    buildLongContextTarget({ name: 'Truncates', host: 't.io', cells: [
      { lengthTokens: 4000, depthPct: 50, ok: true }, { lengthTokens: 64000, depthPct: 50, ok: false }] }),
  ];
  const cmp = buildLongContextComparison(targets);
  assert.equal(cmp.bestContext, 'Solid');
  assert.deepEqual(cmp.truncators, ['Truncates']);
});

test('buildLongContextReport: longcontext schema + comparison', () => {
  const report = buildLongContextReport({
    model: 'gemini-2.5-flash', region: 'local-cn', lengths: [4000, 64000], depths: [10, 90],
    version: '0.2.0', generatedAt: '2026-06-23T00:00:00Z',
    targets: [buildLongContextTarget({ name: 'X', host: 'x.io', cells: [
      { lengthTokens: 4000, depthPct: 10, ok: true }, { lengthTokens: 64000, depthPct: 90, ok: false }] })],
  });
  assert.equal(report.schema, 'gwbench-report/1');
  assert.equal(report.kind, 'longcontext');
  assert.equal(report.comparison.truncators[0], 'X');
  assert.deepEqual(report.lengths, [4000, 64000]);
});

test('renderReportHtml: renders a longcontext heatmap, no secret leak', () => {
  const report = buildLongContextReport({
    model: 'gemini-2.5-flash', region: 'local-cn', lengths: [4000, 64000], depths: [10, 90],
    version: '0.2.0', generatedAt: '2026-06-23T00:00:00Z',
    targets: [buildLongContextTarget({ name: '我的网关', host: 'my.io', cells: [
      { lengthTokens: 4000, depthPct: 10, ok: true }, { lengthTokens: 4000, depthPct: 90, ok: true },
      { lengthTokens: 64000, depthPct: 10, ok: true }, { lengthTokens: 64000, depthPct: 90, ok: false }] })],
  });
  const html = renderReportHtml(report);
  assert.ok(html.includes('长文本上下文留存报告'), 'longcontext title');
  assert.ok(html.includes('64K'), 'length formatted as K');
  assert.ok(html.includes('可靠上限'), 'reliable-cap label');
  assert.ok(html.includes('我的网关'));
  assert.ok(!/sk-|Bearer/.test(html));
});
