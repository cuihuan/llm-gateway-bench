import test from 'node:test';
import assert from 'node:assert/strict';
import { joinMetrics, buildScatterSvg } from './make_scatter.mjs';

const OVERHEAD = [
  { name: 'litellm', version: '1.91.1', verdict: { overhead_ms: 5.83 } },
  { name: 'bifrost', version: 'docker', verdict: { overhead_ms: 0.62 } },
  { name: 'portkey-oss', version: '1.15.2', verdict: { overhead_ms: 2.65 } },
  { name: 'no-fidelity', verdict: { overhead_ms: 9 } }, // only overhead → dropped
];
const FIDELITY = [
  { name: 'litellm', verdict: { tool_calls: true, streaming: true, stream_usage: true } },   // 3
  { name: 'bifrost', verdict: { tool_calls: true, streaming: true, stream_usage: true } },   // 3
  { name: 'portkey-oss', verdict: { tool_calls: true, streaming: false, stream_usage: false } }, // 1
  { name: 'no-overhead', verdict: { tool_calls: true, streaming: true, stream_usage: true } }, // only fidelity → dropped
];

test('joinMetrics: keeps only gateways on BOTH axes, scores 0..3, sorted by overhead', () => {
  const pts = joinMetrics(OVERHEAD, FIDELITY);
  assert.deepEqual(pts.map((p) => p.name), ['bifrost', 'portkey-oss', 'litellm']); // sorted by ms asc
  assert.equal(pts.find((p) => p.name === 'portkey-oss').score, 1);
  assert.equal(pts.find((p) => p.name === 'litellm').score, 3);
  assert.ok(!pts.some((p) => p.name === 'no-fidelity' || p.name === 'no-overhead'));
});

test('joinMetrics: missing verdicts are ignored, never throw', () => {
  assert.deepEqual(joinMetrics([{ name: 'x' }], [{ name: 'x' }]), []);
  assert.deepEqual(joinMetrics(null, null), []);
});

test('buildScatterSvg: returns a well-formed SVG naming every plotted gateway', () => {
  const svg = buildScatterSvg(joinMetrics(OVERHEAD, FIDELITY), { asOf: '2026-07-11' });
  assert.match(svg, /^<svg[\s\S]*<\/svg>$/);
  for (const name of ['litellm', 'bifrost', 'portkey-oss']) assert.ok(svg.includes(name), `missing ${name}`);
  assert.ok(svg.includes('fast &amp; faithful'));
  assert.ok(svg.includes('5.83 ms') && svg.includes('0.62 ms'));
});

test('buildScatterSvg: escapes gateway names (no raw injection)', () => {
  const svg = buildScatterSvg([{ name: '<script>x', version: '', overhead_ms: 1, score: 3 }]);
  assert.ok(!svg.includes('<script>x'));
  assert.ok(svg.includes('&lt;script&gt;x'));
});
