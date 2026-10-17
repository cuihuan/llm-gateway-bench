import dns from 'node:dns/promises';
import net from 'node:net';

const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TASK_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

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
  const officialKey = String(body.officialKey || '');
  const newKey = String(body.newKey || '');
  if (!MODEL_RE.test(model)) throw new Error('模型名格式无效');
  if (!TASK_RE.test(task)) throw new Error('题目名格式无效');
  if (!Number.isInteger(trials) || trials < 1 || trials > 20) throw new Error('每组次数必须是 1–20 的整数');
  if (!officialKey || !newKey) throw new Error('两个渠道都必须填写 Key');
  const [officialUrl, newUrl] = await Promise.all([
    validatePublicUrl(String(body.officialUrl || ''), lookup),
    validatePublicUrl(String(body.newUrl || ''), lookup),
  ]);
  return { officialUrl, newUrl, officialKey, newKey, model, task, trials };
}

