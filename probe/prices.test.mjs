import test from 'node:test';
import assert from 'node:assert/strict';
import { fromLitellm, officialPrice, cheapestSynthorai, fromOpenRouter, fromModelsDev, buildModels } from './prices.mjs';

test('fromLitellm: converts per-token to per-1M and rejects malformed entries', () => {
  assert.deepEqual(fromLitellm({ input_cost_per_token: 3e-6, output_cost_per_token: 1.5e-5 }), [3, 15]);
  assert.equal(fromLitellm({ input_cost_per_token: 'x' }), null);
  assert.equal(fromLitellm(undefined), null);
});

test('officialPrice: first matching key wins, missing keys skipped', () => {
  const table = { 'gemini/gemini-2.5-flash': { input_cost_per_token: 3e-7, output_cost_per_token: 2.5e-6 } };
  assert.deepEqual(officialPrice(table, ['gemini-2.5-flash', 'gemini/gemini-2.5-flash']), [0.3, 2.5]);
  assert.equal(officialPrice(table, ['nope']), null);
  assert.equal(officialPrice(undefined, ['a']), null);
});

test('cheapestSynthorai: picks cheapest duplicate channel row', () => {
  const rows = [
    { model: 'claude-haiku-4-5', input_per_m: 1.2, output_per_m: 6 },
    { model: 'claude-haiku-4-5', input_per_m: 1, output_per_m: 5 },
    { model: 'other', input_per_m: 0.1, output_per_m: 0.1 },
  ];
  assert.deepEqual(cheapestSynthorai(rows, 'claude-haiku-4-5'), [1, 5]);
  assert.equal(cheapestSynthorai(rows, 'absent'), null);
  assert.equal(cheapestSynthorai(null, 'x'), null);
});

test('fromOpenRouter: parses per-token string pricing', () => {
  const models = [{ id: 'anthropic/claude-sonnet-4.5', pricing: { prompt: '0.000003', completion: '0.000015' } }];
  assert.deepEqual(fromOpenRouter(models, 'anthropic/claude-sonnet-4.5'), [3, 15]);
  assert.equal(fromOpenRouter(models, 'missing/model'), null);
  assert.equal(fromOpenRouter([{ id: 'a', pricing: { prompt: 'NaN?', completion: '1' } }], 'a'), null);
});

test('fromModelsDev: reads provider/id cost (already per-1M) and rejects malformed refs', () => {
  const api = { anthropic: { models: { 'claude-sonnet-4-5': { cost: { input: 3, output: 15, cache_read: 0.3 } } } } };
  assert.deepEqual(fromModelsDev(api, 'anthropic/claude-sonnet-4-5'), [3, 15]);
  assert.equal(fromModelsDev(api, 'anthropic/missing'), null);
  assert.equal(fromModelsDev(api, 'noslash'), null);      // ref must be provider/id
  assert.equal(fromModelsDev(api, 'anthropic/x'), null);  // no cost
  assert.equal(fromModelsDev(null, 'a/b'), null);
});

const TRACKED = [{ id: 'm1', litellm: ['m1'], aliases: { synthorai: 'm1', openrouter: 'v/m1', modelsdev: 'v/m1' } }];
const PREV = [{ model: 'm1', official: [1, 2], cells: { synthorai: [0.9, 1.8], openrouter: [1, 2], modelsdev: [1.1, 2.2] } }];

test('buildModels: failed source falls back to previous snapshot column', () => {
  const fresh = [{ model: 'm1', input_per_m: 0.8, output_per_m: 1.6 }];
  const out = buildModels(TRACKED, { litellm: null, synthorai: fresh, openrouter: null, modelsdev: null }, PREV);
  assert.deepEqual(out, [{
    model: 'm1',
    official: [1, 2],                 // litellm failed → kept from prev
    cells: { synthorai: [0.8, 1.6],   // fetched → fresh value wins
             openrouter: [1, 2],      // failed → kept from prev
             modelsdev: [1.1, 2.2] }, // failed → kept from prev
  }]);
});

test('buildModels: fetched source overwrites even when the model is delisted there', () => {
  const out = buildModels(TRACKED, { litellm: null, synthorai: [], openrouter: null, modelsdev: null }, PREV);
  assert.equal(out[0].cells.synthorai, null); // fetched but model gone → null, not stale prev
});

test('buildModels: models.dev cell resolves from provider/id ref', () => {
  const api = { v: { models: { m1: { cost: { input: 0.5, output: 1.5 } } } } };
  const out = buildModels(TRACKED, { litellm: null, synthorai: null, openrouter: null, modelsdev: api }, PREV);
  assert.deepEqual(out[0].cells.modelsdev, [0.5, 1.5]);
});

test('buildModels: no previous snapshot → nulls for failed sources', () => {
  const out = buildModels(TRACKED, { litellm: null, synthorai: null, openrouter: null, modelsdev: null }, undefined);
  assert.deepEqual(out, [{ model: 'm1', official: null, cells: { synthorai: null, openrouter: null, modelsdev: null } }]);
});
