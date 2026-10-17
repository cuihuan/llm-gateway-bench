import fs from 'node:fs/promises';
import path from 'node:path';

export class RunStore {
  constructor(root) { this.root = root; }
  runDir(id) { return path.join(this.root, id); }
  async init() { await fs.mkdir(this.root, { recursive: true, mode: 0o700 }); }
  async save(run) {
    await this.init();
    const dir = this.runDir(run.id);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const target = path.join(dir, 'run.json');
    const temporary = `${target}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(run, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(temporary, target);
  }
  async get(id) {
    if (!/^[a-f0-9-]{36}$/.test(id)) return null;
    try { return JSON.parse(await fs.readFile(path.join(this.runDir(id), 'run.json'), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  async list() {
    await this.init();
    const entries = await fs.readdir(this.root, { withFileTypes: true });
    const runs = (await Promise.all(entries.filter((entry) => entry.isDirectory()).map((entry) => this.get(entry.name))))
      .filter(Boolean);
    return runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
}

