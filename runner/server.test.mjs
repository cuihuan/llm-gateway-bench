import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from './server.mjs';

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

