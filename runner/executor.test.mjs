import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { agentEnvironment, assertValidJobResults, HarborExecutor } from './executor.mjs';

test('Claude Code receives only Anthropic channel variables', () => {
  const env = agentEnvironment('claude-code', 'https://claude.example', 'secret');
  assert.equal(env.ANTHROPIC_BASE_URL, 'https://claude.example'); assert.equal(env.ANTHROPIC_API_KEY, 'secret');
  assert.equal(env.OPENAI_API_KEY, undefined);
});
test('Codex receives only OpenAI channel variables', () => {
  const env = agentEnvironment('codex', 'https://openai.example/v1', 'secret');
  assert.equal(env.OPENAI_BASE_URL, 'https://openai.example/v1'); assert.equal(env.OPENAI_API_KEY, 'secret');
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
});

test('job validation ignores the Harbor aggregate and accepts successful trials', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'router-job-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'result.json'), JSON.stringify({ n_total_trials: 1 }));
  await fs.mkdir(path.join(root, 'trial'));
  await fs.writeFile(path.join(root, 'trial', 'result.json'), JSON.stringify({ task_name: 'terminal-bench/regex-log', exception_info: null }));
  assert.equal((await assertValidJobResults(root, 1)).length, 1);
});

test('job validation rejects trial exceptions even when Harbor exits successfully', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'router-job-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'trial'));
  await fs.writeFile(path.join(root, 'trial', 'result.json'), JSON.stringify({
    task_name: 'terminal-bench/regex-log', exception_info: { exception_type: 'AgentAuthenticationError' },
  }));
  await assert.rejects(assertValidJobResults(root, 1), /AgentAuthenticationError/);
});

test('job validation rejects missing trial results', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'router-job-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await assert.rejects(assertValidJobResults(root, 1), /produced 0 trial result/);
});

test('executor writes an integrity report before rejecting a failed Harbor group', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'failed-harbor-report-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const bin = path.join(root, 'mock-harbor');
  await fs.writeFile(bin, `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path');
const arg = (name) => process.argv[process.argv.indexOf(name) + 1];
const name = arg('--job-name'), dir = path.join(arg('-o'), name, 'trial');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify({ task_name: 'legacy/regex-log',
  exception_info: name === 'candidate-1' ? { exception_type: 'AgentAuthenticationError' } : null,
  verifier_result: { rewards: { reward: name === 'candidate-1' ? 0 : 1 } } }));
`, { mode: 0o700 });
  const executor = new HarborExecutor({ dataDir: root, terminalBenchDir: root, harborBin: bin });
  const progress = {};
  await assert.rejects(executor.run('test-run', {
    baseline: { name: 'SynthorAI', url: 'https://synthorai.io', key: 'SENTINEL_A' },
    candidates: [{ name: 'NIBRoute', url: 'https://api.aws.nibroute.xyz', key: 'SENTINEL_B' }],
    agent: 'claude-code', model: 'claude-opus-4-8', task: 'regex-log', trials: 1,
  }, async (name, status) => { progress[name] = status; }), /See the report/);
  const report = await fs.readFile(path.join(root, 'test-run', 'report.md'), 'utf8');
  assert.match(report, /AgentAuthenticationError/);
  assert.match(report, /Integrity hard gates/);
  assert.match(report, /Run: test-run/);
  assert.match(report, /UNVERIFIED/);
  assert.doesNotMatch(report, /SENTINEL/);
  assert.equal(progress['candidate-1'], 'failed');
  assert.equal(progress['baseline-a'], 'completed');
});
