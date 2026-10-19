import test from 'node:test';
import assert from 'node:assert/strict';
import { renderReportMarkdown } from '../web/benchmark/testRouter/report-preview.js';
import { buildReport } from './terminal-report.mjs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('online report renders headings, comparison tables and notes', () => {
  const html = renderReportMarkdown('# Route comparison\n\n| Metric | SynthorAI | NIBRoute |\n|---|---:|---:|\n| Trials | 1 | 1 |\n| Pass rate | 100% | 100% |\n\n> One trial is not statistically significant.');
  assert.match(html, /<h2>Route comparison<\/h2>/);
  assert.match(html, /<th scope="col">SynthorAI<\/th>/);
  assert.match(html, /<td>100%<\/td>/);
  assert.match(html, /<blockquote>One trial/);
  assert.equal((html.match(/<tbody>/g) || []).length, 1);
});

test('online report cannot execute raw HTML, scripts or Markdown URLs', () => {
  const html = renderReportMarkdown('# <img src=x onerror=alert(1)>\n<script>alert(1)</script>\n[click](javascript:alert(1))\n| Metric | Value |\n|---|---|\n| payload | <svg onload=alert(1)> |');
  assert.doesNotMatch(html, /<(?:script|img|svg|a)\b/i);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&lt;svg onload/);
});

test('online report preserves code, lists, CRLF and empty content', () => {
  const html = renderReportMarkdown('- First\r\n- Second\r\n\r\n```\r\n<b>literal</b>\r\n```');
  assert.match(html, /<ul><li>First<\/li><li>Second<\/li><\/ul>/);
  assert.match(html, /<pre><code>&lt;b&gt;literal&lt;\/b&gt;<\/code><\/pre>/);
  assert.equal(renderReportMarkdown(''), '');
});

test('three-dimension report previews every section and its route tables', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'three-dimension-preview-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const html = renderReportMarkdown(await buildReport(root, { trials: 3, candidates: [{ name: 'NIBRoute' }] }));
  assert.match(html, /<h3>1\. Performance<\/h3>/);
  assert.match(html, /<h3>2\. Price &amp; cache<\/h3>/);
  assert.match(html, /<h3>3\. Quality &amp; governance<\/h3>/);
  assert.equal((html.match(/<table>/g) || []).length, 9);
  assert.match(html, /Integrity hard gates/);
  assert.match(html, /Statistical comparison: NIBRoute/);
  assert.match(html, /NO DIRECT OFFICIAL REFERENCE/);
  assert.match(html, /<td>Not collected<\/td>/);
});
