import dns from 'node:dns/promises';
import net from 'node:net';

const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TASK_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const FIXED_ROUTERS = Object.freeze({
  synthorai: Object.freeze({ name: 'SynthorAI', url: 'https://synthorai.io' }),
  nibroute: Object.freeze({ name: 'NIBRoute', url: 'https://api.aws.nibroute.xyz' }),
});

export function agentForModel(model) {
  return /^claude(?:-|$)/i.test(model) ? 'claude-code' : 'codex';
}

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
  if (!MODEL_RE.test(model)) throw new Error('The model ID is invalid.');
  if (!TASK_RE.test(task)) throw new Error('The task ID is invalid.');
  if (!Number.isInteger(trials) || trials < 1 || trials > 20) throw new Error('Trials per route must be an integer from 1 to 20.');
  const synthoraiKey = String(body.synthoraiKey || body.baseline?.key || body.officialKey || '');
  const nibrouteKey = String(body.nibrouteKey || body.candidates?.[0]?.key || body.newKey || '');
  if (!synthoraiKey || !nibrouteKey) throw new Error('Both router API keys are required.');
  const [synthoraiUrl, nibrouteUrl] = await Promise.all([
    validatePublicUrl(FIXED_ROUTERS.synthorai.url, lookup),
    validatePublicUrl(FIXED_ROUTERS.nibroute.url, lookup),
  ]);
  return {
    baseline: { ...FIXED_ROUTERS.synthorai, url: synthoraiUrl, key: synthoraiKey },
    candidates: [{ ...FIXED_ROUTERS.nibroute, url: nibrouteUrl, key: nibrouteKey }],
    agent: agentForModel(model), model, task, trials,
  };
}

