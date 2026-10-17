import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { validateCreateInput } from './validation.mjs';

const PUBLIC_FIELDS = ['id', 'status', 'createdAt', 'startedAt', 'finishedAt', 'agent', 'model', 'task', 'trials', 'baseline', 'candidates', 'progress', 'error'];

export function publicRun(run) {
  return Object.fromEntries(PUBLIC_FIELDS.map((key) => [key, run[key]]).filter(([, value]) => value !== undefined));
}

export class BenchmarkService {
  constructor({ store, executor, maxActiveRuns = 1, lookup }) {
    Object.assign(this, { store, executor, maxActiveRuns, lookup });
    this.active = new Map();
  }
  async list() { return (await this.store.list()).map(publicRun); }
  async get(id) { const run = await this.store.get(id); return run && publicRun(run); }
  async create(body) {
    if (this.active.size >= this.maxActiveRuns) throw Object.assign(new Error('A benchmark is already running. Try again when it finishes.'), { statusCode: 409 });
    const input = await validateCreateInput(body, this.lookup);
    const now = new Date().toISOString();
    const candidateRecords = input.candidates.map((item, index) => ({ id: `candidate-${index + 1}`, name: item.name, host: new URL(item.url).host }));
    const progress = { 'baseline-a': 'queued', 'baseline-b': 'queued', ...Object.fromEntries(candidateRecords.map((item) => [item.id, 'queued'])) };
    const run = { id: crypto.randomUUID(), status: 'queued', createdAt: now, agent: input.agent, model: input.model, task: input.task,
      trials: input.trials, baseline: { name: input.baseline.name, host: new URL(input.baseline.url).host }, candidates: candidateRecords, progress };
    await this.store.save(run);
    const promise = this.execute(run, input);
    this.active.set(run.id, promise);
    promise.finally(() => this.active.delete(run.id));
    return publicRun(run);
  }
  async execute(run, input) {
    run.status = 'running'; run.startedAt = new Date().toISOString();
    for (const key of Object.keys(run.progress)) run.progress[key] = 'running';
    await this.store.save(run);
    try {
      await this.executor.run(run.id, input, async (name, status) => { run.progress[name] = status; await this.store.save(run); });
      run.status = 'completed';
    } catch (error) {
      const current = await this.store.get(run.id);
      if (current?.status === 'cancelled') Object.assign(run, current);
      else { run.status = 'failed'; run.error = String(error.message || error).slice(0, 500); }
    } finally {
      const current = await this.store.get(run.id);
      if (current?.status === 'cancelled') Object.assign(run, current);
      else run.finishedAt = new Date().toISOString();
      await this.store.save(run);
    }
  }
  async cancel(id) {
    const run = await this.store.get(id);
    if (!run) return null;
    if (!['queued', 'running'].includes(run.status)) throw Object.assign(new Error('This benchmark has already finished.'), { statusCode: 409 });
    run.status = 'cancelled'; run.finishedAt = new Date().toISOString();
    await this.store.save(run); this.executor.cancel(id);
    return publicRun(run);
  }
  async artifact(id, kind) {
    const run = await this.store.get(id);
    if (!run) return null;
    const file = kind === 'report' ? 'report.md' : null;
    if (!file) return null;
    try { return await fs.readFile(path.join(this.store.runDir(id), file)); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
}

