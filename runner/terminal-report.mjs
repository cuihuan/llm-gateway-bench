import fs from 'node:fs/promises';
import path from 'node:path';
import { readClaudeEvidence } from './claude-evidence.mjs';
import { integrityReport } from './integrity-report.mjs';

const number = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const safeText = (value) => String(value ?? '').replace(/[\r\n|]/g, ' ');
const percent = (value) => value === null ? 'N/A' : `${(value * 100).toFixed(1)}%`;
const money = (value) => value === null ? 'N/A' : `$${value.toFixed(4)}`;
const decimal = (value) => value === null ? 'N/A' : value.toFixed(1);
const integer = (value) => value === null ? 'N/A' : value.toLocaleString('en-US');
const mean = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
const ratio = (numerator, denominator) => numerator !== null && denominator > 0 ? numerator / denominator : null;

async function walk(directory) {
  const output = [];
  let entries;
  try { entries = await fs.readdir(directory, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  for (const entry of entries) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!['agent', 'verifier'].includes(entry.name)) output.push(...await walk(file));
    } else output.push(file);
  }
  return output;
}

async function optionalJson(file) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export async function readJob(directory) {
  const files = (await walk(directory)).filter((file) => path.basename(file) === 'result.json');
  return Promise.all(files.map(async (file) => {
    const result = JSON.parse(await fs.readFile(file, 'utf8'));
    if (!result.task_name) return null;
    const trialDirectory = path.dirname(file);
    const [trajectory, verifier, evidence] = await Promise.all([
      optionalJson(path.join(trialDirectory, 'agent', 'trajectory.json')),
      optionalJson(path.join(trialDirectory, 'verifier', 'ctrf.json')),
      readClaudeEvidence(path.join(trialDirectory, 'agent', 'sessions')),
    ]);
    const execution = result.agent_execution || {};
    const agent = result.agent_result || {};
    const metrics = trajectory?.final_metrics || {};
    return {
      id: path.basename(trialDirectory),
      task: String(result.task_name).split('/').at(-1),
      reward: number(result.verifier_result?.rewards?.reward),
      error: result.exception_info ? result.exception_info.exception_type || 'TrialError' : null,
      seconds: execution.started_at && execution.finished_at
        ? number((new Date(execution.finished_at) - new Date(execution.started_at)) / 1000) : null,
      input: number(agent.n_input_tokens) ?? number(metrics.total_prompt_tokens),
      cacheRead: number(agent.n_cache_tokens) ?? number(metrics.total_cached_tokens),
      cacheWrite: number(metrics.extra?.total_cache_creation_input_tokens),
      output: number(agent.n_output_tokens) ?? number(metrics.total_completion_tokens),
      cost: number(agent.cost_usd) ?? number(metrics.total_cost_usd),
      costSource: metrics.extra?.cost_source === 'litellm_estimate' ? 'Harbor pricing estimate' : 'Agent-reported estimate',
      toolCalls: trajectory?.steps ? trajectory.steps.reduce((sum, step) => sum + (Array.isArray(step.tool_calls) ? step.tool_calls.length : 0), 0) : null,
      checks: number(verifier?.results?.summary?.tests),
      checksPassed: number(verifier?.results?.summary?.passed),
      evidence,
    };
  })).then((results) => results.filter(Boolean));
}

export function summarizeTrials(trials, expectedTrials = trials.length) {
  const completeSum = (key) => trials.length && trials.every((trial) => number(trial[key]) !== null)
    ? trials.reduce((sum, trial) => sum + trial[key], 0) : null;
  const durations = trials.map((trial) => number(trial.seconds)).filter((value) => value !== null).sort((a, b) => a - b);
  const passed = trials.filter((trial) => !trial.error && trial.reward === 1).length;
  const verified = trials.filter((trial) => !trial.error && number(trial.reward) !== null);
  const input = completeSum('input');
  const cacheRead = completeSum('cacheRead');
  const accountingErrors = trials.filter((trial) => number(trial.input) !== null && number(trial.cacheRead) !== null &&
    (trial.cacheRead > trial.input || (number(trial.cacheWrite) !== null && trial.cacheRead + trial.cacheWrite > trial.input))).length;
  const cost = completeSum('cost');
  return {
    trials: trials.length, expectedTrials, passed, passRate: ratio(passed, expectedTrials),
    reward: mean(verified.map((trial) => trial.reward)),
    errors: trials.filter((trial) => trial.error).length,
    failures: verified.filter((trial) => trial.reward < 1).length,
    missing: Math.max(0, expectedTrials - trials.length),
    validExecutions: trials.filter((trial) => !trial.error).length,
    verified: verified.length, tasks: new Set(trials.map((trial) => trial.task)).size,
    meanSeconds: durations.length === trials.length ? mean(durations) : null,
    medianSeconds: durations.length === trials.length && durations.length
      ? (durations[Math.floor((durations.length - 1) / 2)] + durations[Math.floor(durations.length / 2)]) / 2 : null,
    minSeconds: durations.length ? durations[0] : null, maxSeconds: durations.length ? durations.at(-1) : null,
    toolCallsPerTrial: ratio(completeSum('toolCalls'), trials.length),
    input, cacheRead, cacheWrite: completeSum('cacheWrite'), output: completeSum('output'),
    cacheRate: accountingErrors ? null : ratio(cacheRead, input), accountingErrors,
    cost, costPerTrial: ratio(cost, trials.length), costPerSuccess: ratio(cost, passed),
    successesPerDollar: cost === null ? null : ratio(passed, cost),
    costCoverage: trials.filter((trial) => number(trial.cost) !== null).length,
    cacheCoverage: trials.filter((trial) => number(trial.input) !== null && number(trial.cacheRead) !== null).length,
    checks: completeSum('checks'), checksPassed: completeSum('checksPassed'),
    costSources: [...new Set(trials.filter((trial) => number(trial.cost) !== null).map((trial) => trial.costSource))],
  };
}

export async function buildReport(jobsDirectory, input = {}) {
  const candidates = input.candidates || [{ name: 'Candidate 1' }];
  const names = ['baseline-a', 'baseline-b', ...candidates.map((_, index) => `candidate-${index + 1}`)];
  const jobs = await Promise.all(names.map((name) => readJob(path.join(jobsDirectory, name))));
  const perJob = input.trials ?? Math.max(...jobs.map((job) => job.length), 0);
  const labels = [input.baseline?.name || 'SynthorAI', ...candidates.map((candidate) => candidate.name)];
  const groups = [[...jobs[0], ...jobs[1]], ...jobs.slice(2)];
  const routes = groups.map((group, index) => summarizeTrials(group, perJob * (index === 0 ? 2 : 1)));
  const lines = ['# Router Comparison Report', '',
    `Model: ${safeText(input.model || '-')} · Task: ${safeText(input.task || groups[0][0]?.task || '-')} · Agent: ${safeText(input.agent || 'claude-code')}`, '',
    'SynthorAI A and B are pooled. Compare cost per trial and per successful task because the baseline runs twice as many trials.', ''];
  if (input.runId) lines.splice(2, 0, `Run: ${safeText(input.runId)} · Generated (UTC): ${safeText(input.generatedAt || '-')}`, '');
  const table = (rows) => {
    lines.push(`| Metric | ${labels.map(safeText).join(' | ')} |`, `|---|${labels.map(() => '---:').join('|')}|`);
    for (const [label, cell] of rows) lines.push(`| ${label} | ${routes.map(cell).join(' | ')} |`);
    lines.push('');
  };
  lines.push('## Overview', '');
  table([
    ['Trials', (route) => `${route.trials} / ${route.expectedTrials}`],
    ['Task pass rate', (route) => `${percent(route.passRate)} (${route.passed}/${route.expectedTrials})`],
    ['Mean agent time (s)', (route) => decimal(route.meanSeconds)],
    ['Total cost (USD, estimate)', (route) => money(route.cost)],
    ['Cost per trial (USD, estimate)', (route) => money(route.costPerTrial)],
    ['Cache hit rate (input tokens)', (route) => percent(route.cacheRate)],
  ]);
  if (routes.length === 2) {
    const [baseline, candidate] = routes;
    lines.push('## Findings', '');
    if (baseline.meanSeconds > 0 && candidate.meanSeconds !== null) {
      const delta = (candidate.meanSeconds / baseline.meanSeconds - 1) * 100;
      lines.push(`- Performance: ${safeText(labels[1])} used ${decimal(candidate.meanSeconds)} s per trial versus ${decimal(baseline.meanSeconds)} s for ${safeText(labels[0])}; ${Math.abs(delta).toFixed(1)}% ${delta >= 0 ? 'slower' : 'faster'} in this sample.`);
    }
    if (baseline.costPerTrial > 0 && candidate.costPerTrial !== null) {
      const delta = (candidate.costPerTrial / baseline.costPerTrial - 1) * 100;
      lines.push(`- Price: ${safeText(labels[1])} cost ${money(candidate.costPerTrial)} per trial versus ${money(baseline.costPerTrial)}; the estimate is ${Math.abs(delta).toFixed(1)}% ${delta >= 0 ? 'higher' : 'lower'}. Actual billed charges were not collected.`);
    }
    if (baseline.cacheRate !== null && candidate.cacheRate !== null) lines.push(`- Cache: ${safeText(labels[0])} ${percent(baseline.cacheRate)}; ${safeText(labels[1])} ${percent(candidate.cacheRate)}. This is token reuse, not a dollar discount.`);
    lines.push(`- Quality: ${safeText(labels[0])} passed ${baseline.passed}/${baseline.expectedTrials}; ${safeText(labels[1])} passed ${candidate.passed}/${candidate.expectedTrials}. These results apply to this task only.`, '');
  }
  lines.push('## 1. Performance', '');
  table([
    ['Mean agent time (s)', (route) => decimal(route.meanSeconds)],
    ['Median agent time (s)', (route) => decimal(route.medianSeconds)],
    ['Fastest / slowest trial (s)', (route) => `${decimal(route.minSeconds)} / ${decimal(route.maxSeconds)}`],
    ['Mean tool calls per trial', (route) => decimal(route.toolCallsPerTrial)],
  ]);
  lines.push('Agent time includes model inference and tool execution; container setup is excluded. It is not time to first token or pure decoding speed.', '');
  lines.push('## 2. Price & cache', '');
  table([
    ['Total cost (USD, estimate)', (route) => money(route.cost)],
    ['Actual router charge (USD)', () => 'Not collected'],
    ['Cost per trial (USD, estimate)', (route) => money(route.costPerTrial)],
    ['Cost per successful task (USD, estimate)', (route) => money(route.costPerSuccess)],
    ['Successful tasks per estimated USD', (route) => decimal(route.successesPerDollar)],
    ['Cache hit rate (input tokens)', (route) => percent(route.cacheRate)],
    ['Cache read tokens', (route) => integer(route.cacheRead)],
    ['Cache write tokens', (route) => integer(route.cacheWrite)],
    ['Total input tokens (including cache)', (route) => integer(route.input)],
    ['Output tokens', (route) => integer(route.output)],
  ]);
  lines.push('Cache hit rate = total cache-read tokens / total input tokens, weighted by token volume. Cache writes are included in total input but do not count as hits. A higher hit rate alone does not prove lower billed cost.', '',
    'Costs are agent-reported or Harbor pricing estimates, not verified router charges. Provider balance deltas, discounts, currency conversion and invoices were not collected; actual billed spend and dollar savings from caching are unavailable.', '');
  lines.push('## 3. Quality & governance', '');
  table([
    ['Task pass rate', (route) => `${percent(route.passRate)} (${route.passed}/${route.expectedTrials})`],
    ['Mean verifier reward (0-1)', (route) => route.reward === null ? 'N/A' : route.reward.toFixed(3)],
    ['Verifier checks passed / total', (route) => route.checksPassed === null || route.checks === null ? 'N/A' : `${route.checksPassed} / ${route.checks}`],
    ['Task failures / execution exceptions', (route) => `${route.failures} / ${route.errors}`],
    ['Completed without execution exceptions', (route) => `${route.validExecutions} / ${route.expectedTrials}`],
    ['Missing trial results / missing verifier rewards', (route) => `${route.missing} / ${route.trials - route.verified - route.errors}`],
    ['Cost / cache coverage (trials)', (route) => `${route.costCoverage}/${route.expectedTrials} · ${route.cacheCoverage}/${route.expectedTrials}`],
    ['Usage accounting anomalies', (route) => integer(route.accountingErrors)],
    ['Distinct benchmark tasks', (route) => integer(route.tasks)],
  ]);
  lines.push('Quality is measured by the independent task verifier, not an invented intelligence score. A pass requires reward 1 with no execution exception. Missing usage remains N/A, never zero.', '',
    `Cost sources: ${[...new Set(routes.flatMap((route) => route.costSources))].filter(Boolean).join('; ') || 'Unavailable'}. Neither source verifies the router invoice.`, '');
  lines.push(...integrityReport(jobs, input, perJob));
  const baselineMeans = jobs.slice(0, 2).map((group) => summarizeTrials(group).meanSeconds);
  if (baselineMeans.every((value) => value !== null)) lines.push(`Baseline repeat check: SynthorAI A mean ${decimal(baselineMeans[0])} s; B mean ${decimal(baselineMeans[1])} s.`, '');
  lines.push('This sample measures only the selected task. Small samples do not establish general intelligence, stable speed advantages, or model identity. Usage counters and upstream model identity have not been independently audited.', '');
  return `${lines.join('\n')}\n`;
}

