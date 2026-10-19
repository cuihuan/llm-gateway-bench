import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from './server.mjs';
import { BenchmarkService } from './service.mjs';
import { RunStore } from './store.mjs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from './config.mjs';

async function fixture() {
  const run = { id: '11111111-1111-4111-8111-111111111111', status: 'completed' };
  const service = { list: async () => [run], get: async id => id === run.id ? run : null, create: async body => ({ ...run, model: body.model }),
    cancel: async id => id === run.id ? { ...run, status: 'cancelled' } : null, artifact: async id => id === run.id ? Buffer.from('# report') : null };
  const server = createServer({ service });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}`, run };
}
test('all API lifecycle routes respond', async t => {
  const { server, base, run } = await fixture(); t.after(() => server.close());
  let response = await fetch(`${base}/api/router-bench/runs`); assert.equal(response.status, 200); assert.equal((await response.json()).runs.length, 1);
  response = await fetch(`${base}/api/router-bench/runs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'm' }) }); assert.equal(response.status, 202);
  response = await fetch(`${base}/api/router-bench/runs/${run.id}`); assert.equal(response.status, 200);
  response = await fetch(`${base}/api/router-bench/runs/${run.id}/cancel`, { method: 'POST' }); assert.equal(response.status, 200);
  response = await fetch(`${base}/api/router-bench/runs/${run.id}/report`); assert.equal(response.status, 200); assert.equal(await response.text(), '# report');
});
test('API accepts the router-key workflow without a separate operator token', async t => {
  const { server, base } = await fixture(); t.after(() => server.close());
  const response = await fetch(`${base}/api/router-bench/runs`);
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).runs.map((run) => run.status), ['completed']);
});
test('invalid JSON and unknown runs return errors', async t => {
  const { server, base } = await fixture(); t.after(() => server.close());
  let response = await fetch(`${base}/api/router-bench/runs`, { method: 'POST', body: '{' });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'The request body contains invalid JSON.' });
  response = await fetch(`${base}/api/router-bench/runs/22222222-2222-4222-8222-222222222222`);
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: 'Benchmark run not found.' });
});

test('report preview module is served as JavaScript and missing reports return JSON errors', async t => {
  const { server, base } = await fixture(); t.after(() => server.close());
  let response = await fetch(`${base}/benchmark/testRouter/report-preview.js?v=20261018-3`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/javascript/);
  assert.match(await response.text(), /export function renderReportMarkdown/);
  response = await fetch(`${base}/api/router-bench/runs/22222222-2222-4222-8222-222222222222/report`);
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: 'The report is not available yet.' });
});

test('failed run retains its downloadable evidence report through the real service and API', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'failed-report-api-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new RunStore(root);
  const service = new BenchmarkService({ store, lookup: async () => [{ address: '8.8.8.8' }], executor: {
    async run(id) {
      await fs.writeFile(path.join(root, id, 'report.md'), '# Integrity hard gates\n\nFAIL: trial exception\n');
      throw new Error('Benchmark job failed validation.');
    },
  } });
  const server = createServer({ service });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const created = await fetch(`${base}/api/router-bench/runs`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'claude-opus-4-8', synthoraiKey: 'SENTINEL_A', nibrouteKey: 'SENTINEL_B', trials: 1 }) });
  assert.equal(created.status, 202);
  const { run } = await created.json();
  await service.active.get(run.id);
  const current = await fetch(`${base}/api/router-bench/runs/${run.id}`);
  assert.equal((await current.json()).run.status, 'failed');
  const report = await fetch(`${base}/api/router-bench/runs/${run.id}/report`);
  assert.equal(report.status, 200);
  assert.match(report.headers.get('content-type'), /text\/markdown/);
  assert.match(await report.text(), /FAIL: trial exception/);
  assert.doesNotMatch(await fs.readFile(path.join(root, run.id, 'run.json'), 'utf8'), /SENTINEL/);
});

test('report visibility configuration is opt-in and reversible', () => {
  assert.equal(loadConfig({}).reportsHidden, false);
  assert.equal(loadConfig({ BENCHMARK_REPORTS_HIDDEN: 'true' }).reportsHidden, true);
  assert.equal(loadConfig({ BENCHMARK_REPORTS_HIDDEN: 'false' }).reportsHidden, false);
});

test('hidden reports disappear from history and direct links while active work remains available', async t => {
  const statuses = ['completed', 'failed', 'cancelled', 'running', 'queued'];
  const runs = statuses.map((status, i) => ({ id: `${i + 1}1111111-1111-4111-8111-111111111111`, status }));
  let artifactReads = 0;
  const service = { list: async () => runs, get: async id => runs.find(run => run.id === id),
    artifact: async () => { artifactReads++; return Buffer.from('PRIVATE_REPORT'); } };
  const hidden = createServer({ service, reportsHidden: true });
  const visible = createServer({ service });
  for (const server of [hidden, visible]) {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => server.close());
  }
  const base = `http://127.0.0.1:${hidden.address().port}`;
  const response = await fetch(`${base}/api/router-bench/runs`);
  assert.match(response.headers.get('cache-control'), /no-store/);
  assert.deepEqual(await response.json(), { runs: runs.slice(3), reportsHidden: true });
  for (const run of runs) {
    const detail = await fetch(`${base}/api/router-bench/runs/${run.id}`);
    assert.equal(detail.status, ['queued', 'running'].includes(run.status) ? 200 : 404);
    const report = await fetch(`${base}/api/router-bench/runs/${run.id}/report`);
    assert.equal(report.status, 404);
    assert.match(report.headers.get('cache-control'), /no-store/);
    assert.deepEqual(await report.json(), { error: 'Reports are temporarily hidden.' });
  }
  assert.equal(artifactReads, 0);
  const restored = await fetch(`http://127.0.0.1:${visible.address().port}/api/router-bench/runs/${runs[0].id}/report`);
  assert.equal(restored.status, 200);
  assert.match(restored.headers.get('cache-control'), /no-store/);
  assert.equal(await restored.text(), 'PRIVATE_REPORT');
  assert.equal(runs.length, 5);
});

