// Pure calculation functions for model evaluation · measured price/value. Single source of truth:
// the browser (evals.html, imported as an ES module) and the Node unit tests (probe/metrics.test.mjs)
// share this one copy — the shipped algorithm is the tested algorithm.
// Price unit = USD per 1M tokens.

/** taskCost: given input/output token counts, compute the USD cost of one task. */
export function taskCost({ input = 0, output = 0 }, inTokens, outTokens) {
  if (typeof inTokens !== 'number' || typeof outTokens !== 'number') return null;
  return (input * inTokens + output * outTokens) / 1e6;
}

/** tokensForBudget: given a USD budget and a unit price ($/1M), compute how many tokens you can buy; price 0 (local/free) → Infinity */
export function tokensForBudget(pricePerM, budgetUsd) {
  if (typeof pricePerM !== 'number' || typeof budgetUsd !== 'number' || budgetUsd < 0) return null;
  if (pricePerM <= 0) return Infinity;
  return (budgetUsd / pricePerM) * 1e6;
}

/**
 * Quality value-for-money: authoritative benchmark score ÷ unit price ($/1M), i.e. "how many points
 * per dollar" — higher is better value. Price 0 (local/free) → Infinity; missing score or price →
 * null (never fabricated). A rough quality/price ratio, not comparable across benchmarks; use only
 * for ranking within the same benchmark column.
 */
export function valuePerDollar(score, pricePerM) {
  if (typeof score !== 'number' || typeof pricePerM !== 'number' || score < 0) return null;
  if (pricePerM <= 0) return Infinity;
  return score / pricePerM;
}
