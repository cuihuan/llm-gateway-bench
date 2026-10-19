import test from 'node:test';
import assert from 'node:assert/strict';
import { comparison, permutationP } from './comparison-stats.mjs';
const trials = (values, task = 'regex-log') => values.map((v) => ({ task, v }));

test('small-sample permutation p is exact, two-sided, and handles ties', () => {
  assert.equal(permutationP(trials([0, 0]), trials([1, 1]), 'v'), 1 / 3);
  assert.equal(permutationP(trials([1, 1]), trials([0, 0]), 'v'), 1 / 3);
  assert.equal(permutationP(trials([1, 1]), trials([1, 1]), 'v'), 1);
});
test('permutations preserve task strata and reject missing/unmatched measurements', () => {
  const a = [...trials([0, 0], 'a'), ...trials([100, 100], 'b')];
  const b = [...trials([0, 0], 'a'), ...trials([100, 100], 'b')];
  assert.equal(permutationP(a, b, 'v'), 1);
  assert.equal(permutationP(trials([null, 1]), trials([1, 1]), 'v'), null);
  assert.equal(permutationP(trials([0, 0], 'a'), trials([0, 0], 'b'), 'v'), null);
  assert.equal(permutationP(trials([1]), trials([1, 1]), 'v'), null);
});
test('large-sample Monte Carlo is reproducible and exposes strong differences', () => {
  const a = trials(Array(20).fill(0)), b = trials(Array(20).fill(1));
  assert.equal(permutationP(a, b, 'v'), permutationP(a, b, 'v'));
  assert.ok(permutationP(a, b, 'v') < 0.05);
});
test('comparison uses pooled baseline and A/A variation without inventing missing p values', () => {
  const a = trials(Array(5).fill(10)), b = trials(Array(5).fill(12)), n = trials(Array(5).fill(30));
  const c = comparison(a, b, n, 'v');
  assert.equal(c.aa, 0.2); assert.equal(c.ab, 19 / 11);
  assert.equal(c.verdict, 'Difference detected');
  const pp = comparison(trials([0, 0]), trials([0, 0]), trials([1, 1]), 'v', true);
  assert.equal(pp.ab, 1); assert.equal(pp.aa, 0);
  assert.equal(comparison(trials([null, null]), b, n, 'v').verdict, 'Insufficient data');
  const zero = comparison(trials(Array(5).fill(0)), trials(Array(5).fill(0)), trials(Array(5).fill(1)), 'v');
  assert.equal(zero.ab, null);
  assert.equal(zero.verdict, 'Difference detected');
});
