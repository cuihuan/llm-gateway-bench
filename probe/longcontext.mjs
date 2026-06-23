#!/usr/bin/env node
// gwbench longcontext —— 长文本上下文留存基准。在多个上下文长度 × 多个埋点深度
// 上做 needle-in-haystack：埋一个唯一标记，要求原样回读。网关若为省上游成本悄悄
// 截断长上下文，标记会在某个长度以上确定性丢失——这张'长度×深度'通过/失败热图
// 就把截断边界显出来。产出 kind=longcontext 的 gwbench-report/1，复用报告广场。
//
// 用法：
//   node probe/longcontext.mjs --model <trackedId> [--url <你的网关> ...] [--with id,id]
//        [--lengths 4000,16000,64000] [--depths 10,50,90] [--out <前缀>]
//
// key 只从环境变量读，绝不入报告（隐私红线，同 compare）。长上下文请求较贵——
// 默认每格 1 发，长度档建议自控（128K 单模型可达 $0.4–1.2/次）。

import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolveTargets } from './compare.mjs';
import { evalNeedle } from './metrics.mjs';
import { REPORT_SCHEMA } from './report.mjs';

const args = process.argv.slice(2);
const flag = (name, fallback = null) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
const host = (url) => String(url).replace(/^https?:\/\//, '').replace(/\/+$/, '');
const TIMEOUT_MS = 120_000;

/** 构造 needle haystack（纯函数）：约 approxTokens 的填充，needle 埋在 depthFraction
 *  处。每行约 11 token。返回 { content, lines, markerAt }。 */
export function buildHaystack(approxTokens, depthFraction, needle) {
  const TOK_PER_LINE = 11;
  const lines = Math.max(8, Math.round(approxTokens / TOK_PER_LINE));
  const filler = Array.from({ length: lines }, (_, i) => `Line ${i + 1}: the quick brown fox jumps over the lazy dog repeatedly.`);
  const at = Math.min(lines, Math.max(0, Math.round(lines * depthFraction)));
  filler.splice(at, 0, `IMPORTANT MARKER — remember this exact code: ${needle}`);
  const content = `${filler.join('\n')}\n\nQuestion: what is the exact code in the IMPORTANT MARKER line above? Reply with only the code.`;
  return { content, lines, markerAt: at };
}

/** 从一个目标的格子结果汇总（纯函数）：测过的长度档（升序）+ 可靠长度上限
 *  （所有深度都通过的最大长度）。 */
export function summarizeGrid(cells) {
  const byLen = new Map();
  for (const c of cells ?? []) {
    if (!byLen.has(c.lengthTokens)) byLen.set(c.lengthTokens, []);
    byLen.get(c.lengthTokens).push(c.ok === true);
  }
  const lengthsTested = [...byLen.keys()].sort((a, b) => a - b);
  let maxReliableLen = null;
  for (const len of lengthsTested) {
    if (byLen.get(len).length && byLen.get(len).every(Boolean)) maxReliableLen = len;
    else break; // 一旦某长度档有失败，更长的不再算"可靠"
  }
  return { lengthsTested, maxReliableLen };
}

/** 由一个目标的原始格子构造报告 target（纯函数，无密钥）。 */
export function buildLongContextTarget({ name, host: h, cells, error = null }) {
  return { name: name ?? '?', host: h ?? null, grid: cells ?? [], ...summarizeGrid(cells), error };
}

/** 跨目标对比（纯函数）：上下文最可靠者 + 出现过截断的目标名单。 */
export function buildLongContextComparison(targets) {
  const list = Array.isArray(targets) ? targets : [];
  const withLen = list.filter((t) => typeof t.maxReliableLen === 'number');
  const bestContext = withLen.length
    ? withLen.reduce((a, b) => (b.maxReliableLen > a.maxReliableLen ? b : a)).name : null;
  const truncators = list.filter((t) => (t.grid ?? []).some((c) => c.ok === false)).map((t) => t.name);
  return { bestContext, truncators };
}

/** 组装完整 longcontext 报告（纯函数）。generatedAt/version 注入以便单测。 */
export function buildLongContextReport({ model, region = null, lengths, depths, targets, generatedAt, version = '0.0.0' }) {
  const t = Array.isArray(targets) ? targets : [];
  return {
    schema: REPORT_SCHEMA, kind: 'longcontext',
    generatedAt: generatedAt ?? null, tool: { name: 'gwbench', version },
    model: model ?? null, region, lengths: lengths ?? [], depths: depths ?? [],
    targets: t, comparison: buildLongContextComparison(t),
  };
}

async function needleOnce(baseUrl, model, key, content) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('timeout')), TIMEOUT_MS);
  try {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST', signal: ctrl.signal,
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages: [{ role: 'user', content }], max_tokens: 64 }),
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const body = await res.json().catch(() => null);
    return { text: body?.choices?.[0]?.message?.content ?? '' };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) };
  } finally { clearTimeout(timer); }
}

function tsStamp(iso) { return `${iso.slice(0, 10)}T${iso.slice(11, 19).replaceAll(':', '')}`; }
const rnd = () => `NDL-${Math.random().toString(36).slice(2, 10).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;

async function main() {
  if (args.includes('--help') || args.includes('-h')) {
    console.log('gwbench longcontext —— 多长度×多深度 needle 截断基准。见文件头注释。');
    return;
  }
  const model = flag('model');
  if (!model) { console.error('[longcontext] 需要 --model <trackedId>'); process.exit(1); }
  const lengths = String(flag('lengths', '4000,16000,64000')).split(',').map(Number).filter((n) => n > 0);
  const depths = String(flag('depths', '10,50,90')).split(',').map(Number).filter((n) => n >= 0 && n <= 100);

  const root = new URL('..', import.meta.url);
  const gateways = JSON.parse(await readFile(new URL('data/gateways.json', root), 'utf8'));
  const tracked = JSON.parse(await readFile(new URL('data/tracked-models.json', root), 'utf8'));
  const version = JSON.parse(await readFile(new URL('package.json', root), 'utf8')).version;

  const adhoc = flag('url') ? { url: flag('url'), alias: flag('alias'), name: flag('name'), authEnv: flag('auth-env') } : null;
  const withIds = flag('with') ? String(flag('with')).split(',').map((s) => s.trim()).filter(Boolean) : null;
  const { targets, notes } = resolveTargets({ model, adhoc, withIds, gateways, tracked });
  for (const n of notes) console.error(`[skip] ${n}`);
  if (!targets.length) { console.error('[longcontext] 没有可测目标'); process.exit(1); }

  const region = flag('region') || process.env.PROBE_REGION || 'local';
  const startedAt = new Date().toISOString();
  const built = [];
  for (const t of targets) {
    const key = process.env[t.authEnv];
    if (!key) { console.error(`[skip] ${t.name}: 环境变量 ${t.authEnv} 未设置`); continue; }
    const cells = [];
    for (const lengthTokens of lengths) {
      for (const depthPct of depths) {
        const needle = rnd();
        const { content } = buildHaystack(lengthTokens, depthPct / 100, needle);
        const r = await needleOnce(t.baseUrl, t.alias, key, content);
        const ok = r.error ? false : evalNeedle(r.text, needle).ok;
        cells.push({ lengthTokens, depthPct, ok, ...(r.error ? { error: r.error } : {}) });
        console.error(`[lc] ${t.name} ${lengthTokens}tok @${depthPct}%: ${ok ? '✓' : `✗${r.error ? '(' + r.error + ')' : ''}`}`);
      }
    }
    built.push(buildLongContextTarget({ name: t.name, host: host(t.baseUrl), cells }));
  }
  if (!built.length) { console.error('[longcontext] 所有目标缺 key，未产出报告'); process.exit(1); }

  const report = buildLongContextReport({ model, region, lengths, depths, version, generatedAt: new Date().toISOString(), targets: built });
  const out = flag('out') || `reports/longcontext-${model}-${tsStamp(startedAt)}`;
  const dir = out.includes('/') ? out.slice(0, out.lastIndexOf('/')) : '.';
  await mkdir(new URL(dir, root), { recursive: true });
  const { renderReportHtml } = await import('./report.mjs');
  await writeFile(new URL(`${out}.json`, root), JSON.stringify(report, null, 2));
  await writeFile(new URL(`${out}.html`, root), renderReportHtml(report));
  console.error(`[longcontext] 上下文最可靠 ${report.comparison.bestContext ?? '—'} · 出现截断 ${report.comparison.truncators.join('/') || '无'}`);
  console.log(`${out}.html`);
  console.log(`${out}.json`);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
