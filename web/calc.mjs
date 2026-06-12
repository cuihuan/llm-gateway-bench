// 模型评测 · 价格价值实测的纯计算函数。单一来源：浏览器（evals.html，ES module
// 导入）与 Node 单测（probe/metrics.test.mjs）共用同一份——上线的算法就是被测的算法。
// 价格单位 = USD per 1M tokens。

/** taskCost: 给定输入/输出 token 数，算一次任务的美元成本。 */
export function taskCost({ input = 0, output = 0 }, inTokens, outTokens) {
  if (typeof inTokens !== 'number' || typeof outTokens !== 'number') return null;
  return (input * inTokens + output * outTokens) / 1e6;
}

/** tokensForBudget: 给定美元预算与单价（$/1M），算能买多少 token；单价 0（本地/免费）→ Infinity */
export function tokensForBudget(pricePerM, budgetUsd) {
  if (typeof pricePerM !== 'number' || typeof budgetUsd !== 'number' || budgetUsd < 0) return null;
  if (pricePerM <= 0) return Infinity;
  return (budgetUsd / pricePerM) * 1e6;
}

/**
 * 质量性价比：权威 benchmark 分 ÷ 单价（$/1M），即"每美元买到多少分"——越高越值。
 * 价格 0（本地/免费）→ Infinity；分数或价格缺失 → null（不臆造）。粗糙质量/价比，
 * 跨基准不可比，仅在同一基准列内排序参考。
 */
export function valuePerDollar(score, pricePerM) {
  if (typeof score !== 'number' || typeof pricePerM !== 'number' || score < 0) return null;
  if (pricePerM <= 0) return Infinity;
  return score / pricePerM;
}
