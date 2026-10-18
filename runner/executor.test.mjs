import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { agentEnvironment, assertValidJobResults } from './executor.mjs';

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
