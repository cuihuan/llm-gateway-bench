import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const userFacingFiles = [
  'web/benchmark/testRouter/index.html',
  'web/benchmark/testRouter/app.js',
  'web/benchmark/testRouter/report-preview.js',
  'runner/server.mjs',
  'runner/service.mjs',
  'runner/validation.mjs',
  'runner/terminal-report.mjs',
];

test('benchmark UI, API errors and reports contain no CJK copy', async () => {
  for (const relativePath of userFacingFiles) {
    const source = await fs.readFile(path.join(repositoryRoot, relativePath), 'utf8');
    assert.doesNotMatch(source, /[\u3400-\u9fff]/u, `${relativePath} contains CJK copy`);
  }
});

test('benchmark form exposes fixed routers and no endpoint or agent controls', async () => {
  const html = await fs.readFile(path.join(repositoryRoot, 'web/benchmark/testRouter/index.html'), 'utf8');
  assert.match(html, /SynthorAI/);
  assert.match(html, /NIBRoute/);
  assert.doesNotMatch(html, /name="(?:baselineUrl|officialUrl|newUrl|agent)"/);
  assert.doesNotMatch(html, /accessToken|Operator access token|Unlock the runner/);
  const script = await fs.readFile(path.join(repositoryRoot, 'web/benchmark/testRouter/app.js'), 'utf8');
  assert.doesNotMatch(script, /benchmarkToken|x-benchmark-token|accessToken/);
});
