import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { buildReport } from './terminal-report.mjs';

function spawnLogged(command, args, options, logPath) {
  const log = fs.createWriteStream(logPath, { flags: 'a', mode: 0o600 });
  const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  const done = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code, signal) => {
      log.end();
      code === 0 ? resolve({ code, signal }) : reject(new Error(`${command} exited with ${code ?? signal}`));
    });
  });
  return { child, done };
}

export class HarborExecutor {
  constructor(config) { this.config = config; this.children = new Map(); }
  cancel(id) {
    for (const child of this.children.get(id) || []) child.kill('SIGTERM');
  }
  async run(id, input, onProgress) {
    const root = path.join(this.config.dataDir, id);
    const jobs = path.join(root, 'jobs');
    await fsp.mkdir(jobs, { recursive: true, mode: 0o700 });
    const definitions = [
      ['baseline-a', input.baseline],
      ['baseline-b', input.baseline],
      ...input.candidates.map((target, index) => [`candidate-${index + 1}`, target]),
    ];
    const children = [];
    this.children.set(id, children);
    try {
      const promises = definitions.map(([name, target]) => {
        const args = ['run', '-p', 'legacy', '-i', input.task, '-a', input.agent, '-m', input.model,
          '-k', String(input.trials), '-n', String(input.trials), '--agent-setup-timeout-multiplier', '4',
          '-o', jobs, '--job-name', name];
        const process = spawnLogged(this.config.harborBin, args, {
          cwd: this.config.terminalBenchDir,
          env: agentEnvironment(input.agent, target.url, target.key),
        }, path.join(root, `${name}.log`));
        children.push(process.child);
        return process.done.then(async () => onProgress(name, 'completed'), async (error) => { await onProgress(name, 'failed'); throw error; });
      });
      await Promise.all(promises);
      const reportPath = path.join(root, 'report.md');
      await fsp.writeFile(reportPath, await buildReport(jobs, input), { mode: 0o600 });
      return { reportPath };
    } finally {
      this.children.delete(id);
    }
  }
}

function processEnvWithoutAnthropic() {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('ANTHROPIC_') && !key.startsWith('OPENAI_')));
}

export function agentEnvironment(agent, baseUrl, key) {
  const env = processEnvWithoutAnthropic();
  return agent === 'codex'
    ? { ...env, OPENAI_BASE_URL: baseUrl, OPENAI_API_KEY: key }
    : { ...env, ANTHROPIC_BASE_URL: baseUrl, ANTHROPIC_API_KEY: key };
}

