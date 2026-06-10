import test from 'node:test';
import assert from 'node:assert/strict';
import { fromLitellm, officialPrice, cheapestSynthorai, fromOpenRouter } from './prices.mjs';

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
