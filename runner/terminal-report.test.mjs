import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildReport, readJob, summarizeTrials } from './terminal-report.mjs';

test('report summarizes all three jobs', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'router-report-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const name of ['baseline-a', 'baseline-b', 'candidate-1']) { const dir = path.join(root, name, 'trial'); await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'result.json'), JSON.stringify({ task_name: 'legacy/regex-log', verifier_result: { rewards: { reward: 1 } }, agent_execution: { started_at: '2026-01-01T00:00:00Z', finished_at: '2026-01-01T00:00:10Z' } })); }
  const report = await buildReport(root, { agent: 'codex', model: 'gpt-6.1-sol', candidates: [{ name: 'Relay A' }] });
  assert.match(report, /Task pass rate.*100.0%.*100.0%/); assert.match(report, /Relay A/);
});

test('report excludes Harbor aggregate result files from trial counts', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'router-report-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const name of ['baseline-a', 'baseline-b', 'candidate-1']) {
    const dir = path.join(root, name); await fs.mkdir(path.join(dir, 'trial'), { recursive: true });
    await fs.writeFile(path.join(dir, 'result.json'), JSON.stringify({ n_total_trials: 1 }));
    await fs.writeFile(path.join(dir, 'trial', 'result.json'), JSON.stringify({ task_name: 'legacy/regex-log', verifier_result: { rewards: { reward: 1 } } }));
  }
  const report = await buildReport(root, { candidates: [{ name: 'NIBRoute' }] });
  assert.match(report, /\| Trials \| 2 \/ 2 \| 1 \/ 1 \|/);
});

const trial = (overrides = {}) => ({ task: 'regex-log', reward: 1, error: null, seconds: 10,
  input: 100, cacheRead: 80, cacheWrite: 10, output: 20, cost: 0.2,
  costSource: 'Agent-reported estimate', toolCalls: 2, checks: 1, checksPassed: 1, ...overrides });

test('cache rate is token-weighted and costs include failed attempts', () => {
  const summary = summarizeTrials([trial(), trial({ input: 900, cacheRead: 90, seconds: 30, cost: 0.4, reward: 0 })]);
  assert.equal(summary.cacheRate, 0.17);
  assert.ok(Math.abs(summary.cost - 0.6) < 1e-10);
  assert.ok(Math.abs(summary.costPerTrial - 0.3) < 1e-10);
  assert.ok(Math.abs(summary.costPerSuccess - 0.6) < 1e-10);
  assert.equal(summary.passRate, 0.5);
  assert.equal(summary.reward, 0.5);
  assert.equal(summary.medianSeconds, 20);
});

test('missing accounting stays unknown; genuine zeros remain zero', () => {
  const summary = summarizeTrials([trial(), trial({ cost: null, cacheRead: null })]);
  assert.equal(summary.cost, null);
  assert.equal(summary.costPerTrial, null);
  assert.equal(summary.successesPerDollar, null);
  assert.equal(summary.cacheRate, null);
  assert.equal(summary.costCoverage, 1);
  const zero = summarizeTrials([trial({ input: 0, cacheRead: 0, cacheWrite: 0, cost: 0 })]);
  assert.equal(zero.cost, 0);
  assert.equal(zero.cacheRate, null);
  assert.equal(zero.successesPerDollar, null);
});

test('exceptions and missing verifier rewards cannot count as intelligence passes', () => {
  const summary = summarizeTrials([trial({ error: 'AgentAuthenticationError' }), trial({ reward: null })], 3);
  assert.equal(summary.passed, 0);
  assert.equal(summary.errors, 1);
  assert.equal(summary.missing, 1);
  assert.equal(summary.reward, null);
  assert.equal(summary.costPerSuccess, null);
  const invalidUsage = summarizeTrials([trial({ cacheRead: 110 })]);
  assert.equal(invalidUsage.cacheRate, null);
  assert.equal(invalidUsage.accountingErrors, 1);
});

test('reader joins result, trajectory usage, tool calls and independent verifier checks', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'router-metrics-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'agent'));
  await fs.mkdir(path.join(root, 'verifier'));
  await fs.writeFile(path.join(root, 'result.json'), JSON.stringify({ task_name: 'legacy/regex-log',
    verifier_result: { rewards: { reward: 0 } }, agent_result: { cost_usd: 0, n_input_tokens: 100, n_cache_tokens: 60, n_output_tokens: 12 } }));
  await fs.writeFile(path.join(root, 'agent', 'trajectory.json'), JSON.stringify({ final_metrics: {
    total_cost_usd: 99, extra: { cost_source: 'litellm_estimate', total_cache_creation_input_tokens: 30 } },
    steps: [{ tool_calls: [{}, {}] }, { tool_calls: [{}] }] }));
  await fs.writeFile(path.join(root, 'verifier', 'ctrf.json'), JSON.stringify({ results: { summary: { tests: 5, passed: 3 } } }));
  const [result] = await readJob(root);
  assert.equal(result.cost, 0);
  assert.equal(result.cacheWrite, 30);
  assert.equal(result.toolCalls, 3);
  assert.equal(result.checksPassed, 3);
  assert.equal(result.checks, 5);
  assert.equal(result.reward, 0);
  assert.equal(result.costSource, 'Harbor pricing estimate');
});

test('report pools A/B, compares normalized costs, and includes all three dimensions', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'router-dimensions-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const name of ['baseline-a', 'baseline-b', 'candidate-1']) {
    const dir = path.join(root, name, 'trial'); await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'result.json'), JSON.stringify({ task_name: 'legacy/regex-log',
      verifier_result: { rewards: { reward: 1 } }, agent_result: { cost_usd: 0.2, n_input_tokens: 100, n_cache_tokens: 80, n_output_tokens: 20 } }));
  }
  const report = await buildReport(root, { model: 'claude-opus-4-8', trials: 1, candidates: [{ name: 'NIBRoute' }] });
  assert.match(report, /## 1\. Performance/);
  assert.match(report, /## 2\. Price & cache/);
  assert.match(report, /## 3\. Quality & governance/);
  assert.match(report, /Total cost \(USD, estimate\) \| \$0.4000 \| \$0.2000/);
  assert.match(report, /Cost per trial \(USD, estimate\) \| \$0.2000 \| \$0.2000/);
  assert.match(report, /Cache hit rate \(input tokens\) \| 80.0% \| 80.0%/);
  assert.match(report, /not verified router charges/);
  assert.doesNotMatch(report, /session JSONL/);
});
