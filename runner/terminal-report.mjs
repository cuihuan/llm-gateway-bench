import fs from 'node:fs/promises';
import path from 'node:path';

async function walk(directory) {
  const output = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true }).catch(() => [])) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) output.push(...await walk(file)); else output.push(file);
  }
  return output;
}

function isoSeconds(start, finish) {
  return start && finish ? (new Date(finish) - new Date(start)) / 1000 : null;
}

export async function readJob(directory) {
  const files = (await walk(directory)).filter((file) => file.endsWith('result.json'));
  return Promise.all(files.map(async (file) => {
    const result = JSON.parse(await fs.readFile(file, 'utf8'));
    const execution = result.agent_execution || {};
    return { task: String(result.task_name || '').split('/').at(-1), reward: result.verifier_result?.rewards?.reward || 0,
      error: result.exception_info?.exception_type || null, seconds: isoSeconds(execution.started_at, execution.finished_at) };
  }));
}

const average = (items, key) => items.length ? items.reduce((sum, item) => sum + (item[key] || 0), 0) / items.length : 0;
export async function buildReport(jobsDirectory, input = {}) {
  const names = ['baseline-a', 'baseline-b', ...(input.candidates || [{ name: 'Candidate 1' }]).map((_, index) => `candidate-${index + 1}`)];
  const groups = await Promise.all(names.map((name) => readJob(path.join(jobsDirectory, name))));
  const labels = ['Baseline A', 'Baseline B', ...(input.candidates || [{ name: 'Candidate 1' }]).map((item) => item.name)];
  const lines = ['# Terminal-Bench Route Comparison', '', `Generated: ${new Date().toISOString()}`, `Agent: ${input.agent || 'claude-code'}`, `Model: ${input.model || '-'}`, '',
    `| Metric | ${labels.join(' | ')} |`, `|---|${labels.map(() => '---:').join('|')}|`];
  const cells = (fn) => groups.map(fn).join(' | ');
  lines.push(`| Trials | ${cells((group) => group.length)} |`);
  lines.push(`| Pass rate | ${cells((group) => group.length ? `${(average(group, 'reward') * 100).toFixed(1)}%` : '-')} |`);
  lines.push(`| Failed trials | ${cells((group) => group.filter((trial) => trial.error).length)} |`);
  lines.push(`| Mean agent duration (s) | ${cells((group) => group.length ? average(group, 'seconds').toFixed(1) : '-')} |`);
  lines.push('', '> Review the job session JSONL files for complete token, cache, reasoning and backend fingerprint evidence.');
  return `${lines.join('\n')}\n`;
}

