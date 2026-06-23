#!/usr/bin/env node
// 把一份本地生成的 report.json 归档进 web/reports/ 并更新广场清单 index.json。
// 这是"分享到报告广场"的无服务器形态（数据即仓库）：归档后提交/提 PR 即上线。
// 后续 Phase 4 会在此之上加一键上传端点。
//
// 用法：
//   node scripts/publish-report.mjs <report.json> [--id <slug>] [--source user|baseline]
//
// 安全：发布前校验报告不含 key（sk-/Bearer/Authorization），否则拒绝。

import { readFile, writeFile, mkdir } from 'node:fs/promises';

/** 报告里出现密钥痕迹就拒绝发布（隐私红线兜底）。返回命中的样式名或 null。 */
export function detectSecrets(reportText) {
  const pats = [/sk-[A-Za-z0-9]/, /Bearer\s+[A-Za-z0-9]/, /"?authorization"?\s*[:=]/i];
  const hit = pats.find((p) => p.test(reportText));
  return hit ? hit.source : null;
}

/** 由报告对象 + id 构造广场清单条目（轻量摘要）。纯函数。 */
export function indexEntry(report, id, source = 'user') {
  const cmp = report.comparison ?? {};
  return {
    id,
    kind: report.kind ?? 'compare',
    model: report.model ?? null,
    region: report.region ?? null,
    generatedAt: report.generatedAt ?? null,
    demo: report.demo === true,
    title: report.title ?? null,
    targetCount: Array.isArray(report.targets) ? report.targets.length : 0,
    fastestTtft: cmp.fastestTtft ?? null,
    flagCount: Array.isArray(cmp.flags) ? cmp.flags.length : 0,
    source,
  };
}

/** upsert 一个条目进清单（按 id 去重，新报告排前）。纯函数，便于单测。 */
export function upsertIndex(index, entry, updatedAt) {
  const base = index && Array.isArray(index.reports) ? index : { schema: 'gwbench-reports-index/1', reports: [] };
  const reports = [entry, ...base.reports.filter((r) => r.id !== entry.id)];
  return { schema: base.schema ?? 'gwbench-reports-index/1', updatedAt: updatedAt ?? base.updatedAt ?? null, reports };
}

function slugify(s) {
  return String(s ?? 'report').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'report';
}

async function main() {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith('--'));
  const flag = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : null; };
  if (!file) { console.error('用法: node scripts/publish-report.mjs <report.json> [--id <slug>] [--source user|baseline]'); process.exit(1); }

  const root = new URL('..', import.meta.url);
  const text = await readFile(file, 'utf8');
  const leak = detectSecrets(text);
  if (leak) { console.error(`[publish] 报告疑似含密钥（命中 /${leak}/），拒绝发布。请检查 ${file}`); process.exit(1); }
  const report = JSON.parse(text);
  if (report.schema !== 'gwbench-report/1') { console.error(`[publish] 不是 gwbench-report/1（got ${report.schema}）`); process.exit(1); }

  const id = flag('id') || slugify(`${report.model}-${(report.generatedAt || '').slice(0, 10)}`);
  const source = flag('source') || 'user';

  await mkdir(new URL('web/reports', root), { recursive: true });
  await writeFile(new URL(`web/reports/${id}.json`, root), JSON.stringify(report, null, 2));

  let index = null;
  try { index = JSON.parse(await readFile(new URL('web/reports/index.json', root), 'utf8')); } catch {}
  const next = upsertIndex(index, indexEntry(report, id, source), new Date().toISOString());
  await writeFile(new URL('web/reports/index.json', root), JSON.stringify(next, null, 2));
  console.log(`web/reports/${id}.json + index.json（共 ${next.reports.length} 份）`);
  console.log('提交并 push 后即上线报告广场。');
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
