import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.mjs';
import { RunStore } from './store.mjs';
import { HarborExecutor } from './executor.mjs';
import { BenchmarkService } from './service.mjs';

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../web');
// Module scripts are refused by browsers unless served with a JavaScript type.
const contentTypes = {
  '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.json': 'application/json; charset=utf-8', '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8', '.svg': 'image/svg+xml', '.md': 'text/markdown; charset=utf-8',
};

function json(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
}
async function readJson(request) {
  const chunks = []; let size = 0;
  for await (const chunk of request) { size += chunk.length; if (size > 32_768) throw Object.assign(new Error('The request body is too large.'), { statusCode: 413 }); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw Object.assign(new Error('The request body contains invalid JSON.'), { statusCode: 400 }); }
}

export function createServer({ service, staticRoot = webRoot, reportsHidden = false }) {
  return http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      if (url.pathname.startsWith('/api/router-bench')) {
        const match = url.pathname.match(/^\/api\/router-bench\/runs(?:\/([a-f0-9-]{36})(?:\/(cancel|report))?)?$/);
        if (!match) return json(response, 404, { error: 'API endpoint not found.' });
        const [, id, action] = match;
        if (request.method === 'GET' && !id) {
          const runs = await service.list();
          return json(response, 200, { runs: reportsHidden ? runs.filter((run) => ['queued', 'running'].includes(run.status)) : runs, reportsHidden });
        }
        if (request.method === 'POST' && !id) return json(response, 202, { run: await service.create(await readJson(request)) });
        if (request.method === 'GET' && id && !action) {
          const run = await service.get(id);
          return run && (!reportsHidden || ['queued', 'running'].includes(run.status)) ? json(response, 200, { run }) : json(response, 404, { error: 'Benchmark run not found.' });
        }
        if (request.method === 'POST' && action === 'cancel') { const run = await service.cancel(id); return run ? json(response, 200, { run }) : json(response, 404, { error: 'Benchmark run not found.' }); }
        if (request.method === 'GET' && action === 'report') {
          if (reportsHidden) return json(response, 404, { error: 'Reports are temporarily hidden.' });
          const artifact = await service.artifact(id, 'report');
          if (!artifact) return json(response, 404, { error: 'The report is not available yet.' });
          response.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8', 'cache-control': 'no-store', 'content-disposition': `attachment; filename=router-bench-${id}.md` });
          return response.end(artifact);
        }
        return json(response, 405, { error: 'Method not allowed.' });
      }
      const pathname = url.pathname === '/benchmark/testRouter' ? '/benchmark/testRouter/' : url.pathname;
      const relative = pathname.endsWith('/') ? `${pathname.slice(1)}index.html` : pathname.replace(/^\//, '');
      const file = path.resolve(staticRoot, relative);
      if (!file.startsWith(`${staticRoot}${path.sep}`)) return json(response, 404, { error: 'Page not found.' });
      const content = await fs.readFile(file);
      const type = contentTypes[path.extname(file)] || 'text/html; charset=utf-8';
      response.writeHead(200, { 'content-type': type }); response.end(content);
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'EISDIR') return json(response, 404, { error: 'Page not found.' });
      json(response, error.statusCode || 400, { error: String(error.message || error) });
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const config = loadConfig();
  const store = new RunStore(config.dataDir);
  const service = new BenchmarkService({ store, executor: new HarborExecutor(config), maxActiveRuns: config.maxActiveRuns });
  createServer({ service, reportsHidden: config.reportsHidden }).listen(config.port, config.host, () => console.log(`router benchmark listening on ${config.host}:${config.port}`));
}

