import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from './server.mjs';

async function fixture(token = '') {
  const run = { id: '11111111-1111-4111-8111-111111111111', status: 'completed' };
  const service = { list: async () => [run], get: async id => id === run.id ? run : null, create: async body => ({ ...run, model: body.model }),
    cancel: async id => id === run.id ? { ...run, status: 'cancelled' } : null, artifact: async id => id === run.id ? Buffer.from('# report') : null };
  const server = createServer({ service, accessToken: token });
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
test('API requires configured access token', async t => {
  const { server, base } = await fixture('secret'); t.after(() => server.close());
  assert.equal((await fetch(`${base}/api/router-bench/runs`)).status, 401);
  assert.equal((await fetch(`${base}/api/router-bench/runs`, { headers: { 'x-benchmark-token': 'secret' } })).status, 200);
});
test('invalid JSON and unknown runs return errors', async t => {
  const { server, base } = await fixture(); t.after(() => server.close());
  assert.equal((await fetch(`${base}/api/router-bench/runs`, { method: 'POST', body: '{' })).status, 400);
  assert.equal((await fetch(`${base}/api/router-bench/runs/22222222-2222-4222-8222-222222222222`)).status, 404);
});

