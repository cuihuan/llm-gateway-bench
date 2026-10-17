import test from 'node:test';
import assert from 'node:assert/strict';
import { agentEnvironment } from './executor.mjs';

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
