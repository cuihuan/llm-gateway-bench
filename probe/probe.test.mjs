import test from 'node:test';
import assert from 'node:assert/strict';
import { adhocGateway, usage } from './probe.mjs';

test('adhocGateway: builds gateway from --url + --model', () => {
  const gw = adhocGateway({ url: 'https://api.example.com/', model: 'gpt-4o-mini' });
  assert.equal(gw.id, 'adhoc');
  assert.equal(gw.baseUrl, 'https://api.example.com'); // trailing slash stripped
  assert.equal(gw.name, 'api.example.com');            // defaults to host
  assert.equal(gw.authEnv, 'PROBE_KEY');               // default key env var
  assert.deepEqual(gw.probeModels, ['gpt-4o-mini']);
});

test('adhocGateway: comma-separated models, custom name and auth-env', () => {
  const gw = adhocGateway({ url: 'https://x.io', model: 'a, b ,c', name: 'MyGW', authEnv: 'MY_KEY' });
  assert.deepEqual(gw.probeModels, ['a', 'b', 'c']);   // split and trimmed
  assert.equal(gw.name, 'MyGW');
  assert.equal(gw.authEnv, 'MY_KEY');
});

test('adhocGateway: no url → null; no model → empty probeModels', () => {
  assert.equal(adhocGateway({}), null);
  assert.equal(adhocGateway({ model: 'x' }), null);
  assert.deepEqual(adhocGateway({ url: 'https://x.io' }).probeModels, []);
});

test('usage: documents every CLI flag', () => {
  const u = usage();
  for (const flag of ['--gateway', '--url', '--model', '--auth-env', '--name', '--samples', '--out', '--help']) {
    assert.ok(u.includes(flag), `help should include ${flag}`);
  }
  assert.ok(u.includes('PROBE_KEY') && u.includes('PROBE_REGION'), 'should document key env vars');
});
