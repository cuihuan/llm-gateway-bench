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
    throw new Error('渠道地址不是有效 URL');
  }
  if (url.protocol !== 'https:') throw new Error('渠道地址必须使用 HTTPS');
  if (url.username || url.password) throw new Error('渠道地址不能包含用户名或密码');
  if (url.port && url.port !== '443') throw new Error('渠道地址只能使用 443 端口');
  const addresses = await lookup(url.hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new Error('渠道地址不能指向本机或私有网络');
  }
  return url.toString().replace(/\/$/, '');
}

export async function validateCreateInput(body, lookup) {
  if (!body || typeof body !== 'object') throw new Error('请求体必须是 JSON 对象');
  const model = String(body.model || '').trim();
  const task = String(body.task || 'regex-log').trim();
  const trials = Number(body.trials ?? 5);
  const agent = String(body.agent || 'claude-code');
  if (!MODEL_RE.test(model)) throw new Error('模型名格式无效');
  if (!TASK_RE.test(task)) throw new Error('题目名格式无效');
  if (!AGENTS.has(agent)) throw new Error('Agent 只支持 Claude Code 或 Codex');
  if (!Number.isInteger(trials) || trials < 1 || trials > 20) throw new Error('每组次数必须是 1–20 的整数');
  const baseline = body.baseline || { name: '基准渠道', url: body.officialUrl, key: body.officialKey };
  const candidates = Array.isArray(body.candidates) ? body.candidates : [{ name: '候选渠道 1', url: body.newUrl, key: body.newKey }];
  if (!baseline.key || candidates.some((item) => !item?.key)) throw new Error('所有渠道都必须填写 Key');
  if (candidates.length < 1 || candidates.length > 6) throw new Error('候选渠道数量必须为 1–6 个');
  const endpoints = [baseline, ...candidates];
  const names = endpoints.map((item, index) => String(item.name || (index ? `候选渠道 ${index}` : '基准渠道')).trim());
  if (names.some((name) => !name || name.length > 40)) throw new Error('渠道名称必须为 1–40 个字符');
  const urls = await Promise.all(endpoints.map((item) => validatePublicUrl(String(item.url || ''), lookup)));
  const normalized = endpoints.map((item, index) => ({ name: names[index], url: urls[index], key: String(item.key) }));
  return { baseline: normalized[0], candidates: normalized.slice(1), agent, model, task, trials };
}

