import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildReport } from './terminal-report.mjs';

test('report summarizes all three jobs', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'router-report-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const name of ['baseline-a', 'baseline-b', 'candidate-1']) { const dir = path.join(root, name, 'trial'); await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'result.json'), JSON.stringify({ task_name: 'legacy/regex-log', verifier_result: { rewards: { reward: 1 } }, agent_execution: { started_at: '2026-01-01T00:00:00Z', finished_at: '2026-01-01T00:00:10Z' } })); }
  const report = await buildReport(root, { agent: 'codex', model: 'gpt-6.1-sol', candidates: [{ name: 'Relay A' }] });
  assert.match(report, /Pass rate.*100.0%.*100.0%.*100.0%/); assert.match(report, /Relay A/);
});
