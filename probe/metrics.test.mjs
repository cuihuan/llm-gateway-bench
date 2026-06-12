import test from 'node:test';
import assert from 'node:assert/strict';
import { percentile, summarize, stabilityOverTime, evalToolCall, isBurstStream, evalModelEcho, evalCjkIntegrity, evalNeedle } from './metrics.mjs';
// 模型层价格价值计算的单一来源（浏览器与单测共用同一份）
import { taskCost, tokensForBudget, valuePerDollar } from '../web/calc.mjs';

test('percentile: empty and basic cases', () => {
  assert.equal(percentile([], 50), null);
  assert.equal(percentile([42], 50), 42);
  assert.equal(percentile([1, 2, 3, 4], 50), 2.5);
  assert.equal(percentile([3, 1, 2], 0), 1); // unsorted input
  assert.equal(percentile([3, 1, 2], 100), 3);
  assert.throws(() => percentile([1], 101), RangeError);
});

test('summarize: mixed success and failure samples', () => {
  const s = summarize([
    { ok: true, ttftMs: 100, tokensPerSec: 50, totalMs: 1000 },
    { ok: true, ttftMs: 300, tokensPerSec: 30, totalMs: 2000 },
    { ok: false, error: 'HTTP 502' },
    { ok: false, error: 'timeout' },
  ]);
  assert.equal(s.samples, 4);
  assert.equal(s.success, 2);
  assert.equal(s.successRate, 0.5);
  assert.equal(s.ttftMs.avg, 200);
  assert.equal(s.ttftMs.p50, 200);
  assert.equal(s.tokensPerSec.avg, 40);
  assert.deepEqual(s.errors, ['HTTP 502', 'timeout']);
});

test('summarize: all failures yields null metrics, not NaN', () => {
  const s = summarize([{ ok: false, error: 'ECONNREFUSED' }]);
  assert.equal(s.successRate, 0);
  assert.equal(s.ttftMs.avg, null);
  assert.equal(s.tokensPerSec.p50, null);
});

test('summarize: empty input', () => {
  const s = summarize([]);
  assert.equal(s.samples, 0);
  assert.equal(s.successRate, null);
});

test('summarize: usageReportedRate over successful samples only', () => {
  const s = summarize([
    { ok: true, ttftMs: 100, usageReported: true },
    { ok: true, ttftMs: 100, usageReported: false },
    { ok: false, error: 'HTTP 502' },
  ]);
  assert.equal(s.usageReportedRate, 0.5);
  assert.equal(summarize([{ ok: false, error: 'x' }]).usageReportedRate, null);
});

test('isBurstStream: fake-stream fingerprint vs legit fast/slow streaming', () => {
  // 假流式：等 3s 才出首 token，然后 30 个 chunk 在 50ms 内 dump 完
  assert.equal(isBurstStream({ chunks: 30, ttftMs: 3000, streamWindowMs: 50 }), true);
  // 快但真流式（LPU 类）：ttft 很小 → 不误伤
  assert.equal(isBurstStream({ chunks: 30, ttftMs: 90, streamWindowMs: 60 }), false);
  // 慢但真流式：窗口大 → 不误伤
  assert.equal(isBurstStream({ chunks: 30, ttftMs: 1500, streamWindowMs: 2400 }), false);
  // 窗口在阈值内但 ttft 不足窗口 4 倍（900 < 960）→ 证据不足，不判假
  assert.equal(isBurstStream({ chunks: 10, ttftMs: 900, streamWindowMs: 240 }), false);
  // chunk 太少不可判定
  assert.equal(isBurstStream({ chunks: 3, ttftMs: 3000, streamWindowMs: 10 }), null);
  assert.equal(isBurstStream({ chunks: 8, ttftMs: undefined, streamWindowMs: 10 }), null);
});

test('summarize: modelEchoRate over judgeable samples only', () => {
  const s = summarize([
    { ok: true, ttftMs: 1, modelEcho: { ok: true } },
    { ok: true, ttftMs: 1, modelEcho: { ok: false } },
    { ok: true, ttftMs: 1, modelEcho: null },        // 无回显，不计
    { ok: false, error: 'x' },
  ]);
  assert.equal(s.modelEchoRate, 0.5);
  assert.equal(summarize([{ ok: true, ttftMs: 1 }]).modelEchoRate, null);
});

test('summarize: usage fingerprint — median promptTokens and charsPerToken', () => {
  const s = summarize([
    { ok: true, ttftMs: 100, promptTokens: 30, completionTokens: 50, outputChars: 200 }, // 4.0 cpt
    { ok: true, ttftMs: 100, promptTokens: 32, completionTokens: 40, outputChars: 120 }, // 3.0 cpt
    { ok: true, ttftMs: 100, promptTokens: 31, completionTokens: 0, outputChars: 10 },   // cpt skipped (0 tokens)
    { ok: false, error: 'x' },
  ]);
  assert.equal(s.usage.promptTokens, 31);          // median of [30,32,31]
  assert.equal(s.usage.charsPerToken, 3.5);        // median of [4.0, 3.0]
});

test('summarize: usage fingerprint null when no usage reported', () => {
  const s = summarize([{ ok: true, ttftMs: 100, chunks: 5 }]);
  assert.equal(s.usage.promptTokens, null);
  assert.equal(s.usage.charsPerToken, null);
});

test('summarize: burstStreamRate over judgeable ok samples only', () => {
  const s = summarize([
    { ok: true, ttftMs: 3000, chunks: 20, streamWindowMs: 40 },   // 假流式
    { ok: true, ttftMs: 200, chunks: 20, streamWindowMs: 1500 },  // 真流式
    { ok: true, ttftMs: 500, chunks: 2, streamWindowMs: 5 },      // 不可判定（chunk 少）
    { ok: false, error: 'HTTP 502' },
  ]);
  assert.equal(s.burstStreamRate, 0.5);
  assert.equal(summarize([{ ok: true, ttftMs: 100, chunks: 1 }]).burstStreamRate, null);
});

test('evalToolCall: valid call passes, wrong tool / bad args / missing rejected', () => {
  const body = (call) => ({ choices: [{ message: { tool_calls: call ? [call] : undefined } }] });
  assert.equal(evalToolCall(body({ function: { name: 'get_time', arguments: '{"city":"Tokyo"}' } }), 'get_time').ok, true);
  assert.equal(evalToolCall(body({ function: { name: 'other_fn', arguments: '{}' } }), 'get_time').ok, false);
  assert.equal(evalToolCall(body({ function: { name: 'get_time', arguments: '{broken' } }), 'get_time').ok, false);
  assert.equal(evalToolCall(body(null), 'get_time').ok, false);
  assert.equal(evalToolCall(undefined, 'get_time').ok, false);
  assert.equal(evalToolCall({ choices: [{ message: { content: 'plain text answer' } }] }, 'get_time').ok, false);
});

test('evalModelEcho: matches normalized, flags family mismatch, null on missing', () => {
  assert.equal(evalModelEcho('deepseek-v4-flash', 'deepseek-v4-flash').ok, true);
  assert.equal(evalModelEcho('deepseek/deepseek-v4-flash', 'deepseek-v4-flash').ok, true); // 供应商前缀
  assert.equal(evalModelEcho('deepseek-v4-flash-0528', 'deepseek-v4-flash').ok, true);     // 版本后缀
  assert.equal(evalModelEcho('gpt-4o-mini', 'deepseek-v4-flash').ok, false);               // 偷换
  assert.equal(evalModelEcho(null, 'deepseek-v4-flash'), null);                            // 无回显
  assert.equal(evalModelEcho('', 'x'), null);
});

test('evalCjkIntegrity: real Chinese passes, corruption/escapes/no-CJK fail', () => {
  assert.equal(evalCjkIntegrity('今天天气晴朗，适合出门。').ok, true);
  assert.equal(evalCjkIntegrity('today the weather is nice').ok, false);          // 无中文
  assert.equal(evalCjkIntegrity('\\u4eca\\u5929\\u5929\\u6c14').ok, false);       // 字面量转义
  assert.equal(evalCjkIntegrity('今�天�气�').ok, false);                          // 替换符
  assert.equal(evalCjkIntegrity('').ok, false);
});

test('taskCost: input+output token cost in USD', () => {
  // Claude Fable 5 $10/$50；10 万 token 全输出 → 50/1M * 1e5 = $5
  assert.equal(taskCost({ input: 10, output: 50 }, 0, 100000), 5);
  // DeepSeek-V3 $0.27/$1.10；2万输入+8万输出
  assert.equal(taskCost({ input: 0.27, output: 1.10 }, 20000, 80000), (0.27*20000+1.10*80000)/1e6);
  assert.equal(taskCost({ input: 0, output: 0 }, 99999, 99999), 0); // 本地免费
  assert.equal(taskCost({ input: 10, output: 50 }, 'x', 1), null);
});

test('tokensForBudget: tokens buyable for a USD budget; free → Infinity', () => {
  assert.equal(tokensForBudget(10, 100), 1e7);         // $100 / $10per1M = 1000 万
  assert.equal(tokensForBudget(0, 100), Infinity);     // 本地/免费
  assert.equal(tokensForBudget(5, 0), 0);
  assert.equal(tokensForBudget('x', 10), null);
  assert.equal(tokensForBudget(5, -1), null);
});

test('valuePerDollar: benchmark points per $; free → Infinity, missing → null', () => {
  assert.equal(valuePerDollar(75.9, 1.10), 75.9 / 1.10);  // DeepSeek-V3 MMLU-Pro / 输出价
  assert.equal(valuePerDollar(84.8, 4.5), 84.8 / 4.5);    // Qwen3-235B
  assert.equal(valuePerDollar(80, 0), Infinity);          // 本地/免费
  assert.equal(valuePerDollar(null, 5), null);            // 无分数不臆造
  assert.equal(valuePerDollar(80, 'x'), null);
});

test('evalNeedle: finds embedded needle, flags truncation', () => {
  assert.equal(evalNeedle('The code is ABC-12345-XYZ as requested.', 'ABC-12345-XYZ').ok, true);
  assert.equal(evalNeedle('the code is abc-12345-xyz', 'ABC-12345-XYZ').ok, true); // 大小写无关
  assert.equal(evalNeedle('I could not find any code.', 'ABC-12345-XYZ').ok, false);
  assert.equal(evalNeedle('x', '').ok, false);
});

test('stabilityOverTime: averages daily success rates equally', () => {
  const r = stabilityOverTime([
    { date: '2026-06-01', successRate: 1, ttftP50: 100 },
    { date: '2026-06-02', successRate: 0.5, ttftP50: 200 },
    { date: '2026-06-03', successRate: null },
  ]);
  assert.equal(r.days, 2);
  assert.equal(r.uptimePct, 75);
  assert.deepEqual(r.ttftP50TrendMs.map((d) => d.ttftP50), [100, 200]);
});

test('stabilityOverTime: no valid days', () => {
  assert.deepEqual(stabilityOverTime([]), { days: 0, uptimePct: null, ttftP50TrendMs: [] });
});
