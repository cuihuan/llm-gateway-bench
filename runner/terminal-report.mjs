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
export async function buildReport(jobsDirectory) {
  const names = ['official-a', 'official-b', 'new'];
  const groups = await Promise.all(names.map((name) => readJob(path.join(jobsDirectory, name))));
  const lines = ['# Terminal-Bench 渠道对比报告', '', `生成时间：${new Date().toISOString()}`, '',
    '| 项目 | official-a | official-b | new |', '|---|---:|---:|---:|'];
  const cells = (fn) => groups.map(fn).join(' | ');
  lines.push(`| trial 数 | ${cells((group) => group.length)} |`);
  lines.push(`| 通过率 | ${cells((group) => group.length ? `${(average(group, 'reward') * 100).toFixed(1)}%` : '-')} |`);
  lines.push(`| 异常 trial | ${cells((group) => group.filter((trial) => trial.error).length)} |`);
  lines.push(`| agent 耗时均值 s | ${cells((group) => group.length ? average(group, 'seconds').toFixed(1) : '-')} |`);
  lines.push('', '> 完整 token、缓存、thinking 签名和后端指纹请结合 jobs 中的 Claude Code session JSONL 复核。');
  return `${lines.join('\n')}\n`;
}

