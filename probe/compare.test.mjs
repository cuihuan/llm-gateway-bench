import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveTargets } from './compare.mjs';

const gateways = [
  { id: 'openrouter', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api', authEnv: 'OPENROUTER_API_KEY' },
  { id: 'aihubmix', name: 'AiHubMix', baseUrl: 'https://aihubmix.com', authEnv: 'AIHUBMIX_API_KEY' },
];
const tracked = [
  { id: 'gemini-2.5-flash', aliases: { openrouter: 'google/gemini-2.5-flash', aihubmix: 'gemini-2.5-flash' } },
];

test('resolveTargets: ad-hoc target uses defaults (alias=model, env=PROBE_KEY)', () => {
  const { targets } = resolveTargets({
    model: 'gemini-2.5-flash', adhoc: { url: 'https://my-gw.com/' }, withIds: [], gateways, tracked,
  });
  const adhoc = targets.find((t) => t.source === 'adhoc');
  assert.equal(adhoc.name, 'my-gw.com');         // host fallback
  assert.equal(adhoc.baseUrl, 'https://my-gw.com'); // trailing slash stripped
  assert.equal(adhoc.alias, 'gemini-2.5-flash'); // defaults to --model
  assert.equal(adhoc.authEnv, 'PROBE_KEY');
});

test('resolveTargets: ad-hoc honors explicit name/alias/auth-env', () => {
  const { targets } = resolveTargets({
    model: 'gemini-2.5-flash',
    adhoc: { url: 'https://my-gw.com', name: 'My Gateway', alias: 'gemini-flash', authEnv: 'MY_KEY' },
    gateways, tracked,
  });
  const adhoc = targets[0];
  assert.equal(adhoc.name, 'My Gateway');
  assert.equal(adhoc.alias, 'gemini-flash');
  assert.equal(adhoc.authEnv, 'MY_KEY');
});

test('resolveTargets: default registry = all gateways with an alias for the model', () => {
  const { targets, notes } = resolveTargets({
    model: 'gemini-2.5-flash', adhoc: null, withIds: null, gateways, tracked,
  });
  assert.deepEqual(targets.map((t) => t.id).sort(), ['aihubmix', 'openrouter']);
  assert.equal(targets.find((t) => t.id === 'openrouter').alias, 'google/gemini-2.5-flash');
  assert.equal(notes.length, 0);
});

test('resolveTargets: --with filters to explicit ids', () => {
  const { targets } = resolveTargets({
    model: 'gemini-2.5-flash', adhoc: null, withIds: ['openrouter'], gateways, tracked,
  });
  assert.deepEqual(targets.map((t) => t.id), ['openrouter']);
});

test('resolveTargets: unknown gateway and missing-alias produce notes, not targets', () => {
  const { targets, notes } = resolveTargets({
    model: 'gemini-2.5-flash', adhoc: null, withIds: ['nope', 'aihubmix'], gateways,
    tracked: [{ id: 'gemini-2.5-flash', aliases: { openrouter: 'google/gemini-2.5-flash' } }], // aihubmix has no alias
  });
  assert.deepEqual(targets.map((t) => t.id), []); // nope unknown, aihubmix no alias
  assert.equal(notes.length, 2);
  assert.ok(notes.some((n) => n.includes('nope')));
  assert.ok(notes.some((n) => n.includes('aihubmix')));
});

test('resolveTargets: ad-hoc + registry combine in one comparison', () => {
  const { targets } = resolveTargets({
    model: 'gemini-2.5-flash', adhoc: { url: 'https://mine.io', name: 'Mine' },
    withIds: ['openrouter'], gateways, tracked,
  });
  assert.deepEqual(targets.map((t) => t.name), ['Mine', 'OpenRouter']);
});
