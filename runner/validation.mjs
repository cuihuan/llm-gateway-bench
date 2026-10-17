import dns from 'node:dns/promises';
import net from 'node:net';

const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TASK_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const AGENTS = new Set(['claude-code', 'codex']);

export function isPrivateAddress(address) {
  if (net.isIPv4(address)) {
    const [a, b] = address.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
  }
  if (net.isIPv6(address)) {
    const value = address.toLowerCase();
    return value === '::1' || value === '::' || value.startsWith('fc') ||
      value.startsWith('fd') || value.startsWith('fe8') || value.startsWith('fe9') ||
      value.startsWith('fea') || value.startsWith('feb');
  }
  return true;
}

export async function validatePublicUrl(value, lookup = dns.lookup) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Route address is not a valid URL.');
  }
  if (url.protocol !== 'https:') throw new Error('Route addresses must use HTTPS.');
  if (url.username || url.password) throw new Error('Route addresses cannot contain a username or password.');
  if (url.port && url.port !== '443') throw new Error('Route addresses can only use port 443.');
  const addresses = await lookup(url.hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new Error('Route addresses cannot point to localhost or a private network.');
  }
  return url.toString().replace(/\/$/, '');
}

export async function validateCreateInput(body, lookup) {
  if (!body || typeof body !== 'object') throw new Error('The request body must be a JSON object.');
  const model = String(body.model || '').trim();
  const task = String(body.task || 'regex-log').trim();
  const trials = Number(body.trials ?? 5);
  const agent = String(body.agent || 'claude-code');
  if (!MODEL_RE.test(model)) throw new Error('The model ID is invalid.');
  if (!TASK_RE.test(task)) throw new Error('The task ID is invalid.');
  if (!AGENTS.has(agent)) throw new Error('Agent must be Claude Code or Codex.');
  if (!Number.isInteger(trials) || trials < 1 || trials > 20) throw new Error('Trials per route must be an integer from 1 to 20.');
  const baseline = body.baseline || { name: 'Baseline', url: body.officialUrl, key: body.officialKey };
  const candidates = Array.isArray(body.candidates) ? body.candidates : [{ name: 'Candidate 1', url: body.newUrl, key: body.newKey }];
  if (!baseline.key || candidates.some((item) => !item?.key)) throw new Error('Every route requires an API key.');
  if (candidates.length < 1 || candidates.length > 6) throw new Error('Add between 1 and 6 candidate routes.');
  const endpoints = [baseline, ...candidates];
  const names = endpoints.map((item, index) => String(item.name || (index ? `Candidate ${index}` : 'Baseline')).trim());
  if (names.some((name) => !name || name.length > 40)) throw new Error('Route names must contain 1 to 40 characters.');
  const urls = await Promise.all(endpoints.map((item) => validatePublicUrl(String(item.url || ''), lookup)));
  const normalized = endpoints.map((item, index) => ({ name: names[index], url: urls[index], key: String(item.key) }));
  return { baseline: normalized[0], candidates: normalized.slice(1), agent, model, task, trials };
}

