#!/usr/bin/env node
// gwbench matrix —— 经典模型 × 网关 横评（平台旗舰报告类型）。
// 对每个经典模型（data/tracked-models.json，按 aliases 决定哪些网关有它），把它在
// 所有有 key 的网关上跑一遍全套黑盒，产出一份"该模型在各网关的实测效果"报告，
// 直接发布到报告广场（web/reports/）。这是用户的重中之重："几个经典模型，不同网关
// 的测试效果"。维护者在 CI（有各网关 key）跑，报告随 6h cron 自动刷新。
//
// 用法：
//   node probe/matrix.mjs [--models a,b] [--samples 3] [--min 2] [--region gh-us]
//
// key 只从环境变量读，绝不入报告。一个模型至少在 --min（默认 2）个网关上有数据
// 才生成报告——避免只有一家时产出无意义的"横评"。

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolveTargets } from './compare.mjs';
import { probeGateway } from './probe.mjs';
import { buildTarget, buildReport } from './report.mjs';

const args = process.argv.slice(2);
const flag = (name, fallback = null) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
const host = (url) => String(url).replace(/^https?:\/\//, '').replace(/\/+$/, '');

/** 模型 id → 文件名安全 slug（纯函数）。 */
export function matrixSlug(model) {
  return `matrix-${String(model ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'model'}`;
}

/** 广场清单合并（纯函数）：换掉所有 matrix-* 条目为新一批，保留 demo / 用户报告。
 *  matrix 报告每次重算，故按前缀整体替换而非逐条 upsert。 */
export function mergeMatrixIndex(index, matrixEntries, updatedAt) {
  const base = index && Array.isArray(index.reports) ? index.reports : [];
  const kept = base.filter((r) => !String(r.id).startsWith('matrix-'));
  return {
    schema: index?.schema ?? 'gwbench-reports-index/1',
    updatedAt: updatedAt ?? index?.updatedAt ?? null,
    reports: [...matrixEntries, ...kept],
  };
}

/** 由报告对象构造广场清单条目（纯函数）。 */
export function matrixIndexEntry(report, id) {
  const cmp = report.comparison ?? {};
  return {
    id, kind: report.kind ?? 'compare', model: report.model ?? null, region: report.region ?? null,
    generatedAt: report.generatedAt ?? null, demo: false, title: report.title ?? null,
    targetCount: Array.isArray(report.targets) ? report.targets.length : 0,
    fastestTtft: cmp.fastestTtft ?? null, cheapest: cmp.cheapest ?? null,
    flagCount: Array.isArray(cmp.flags) ? cmp.flags.length : 0, source: 'baseline',
  };
}

async function main() {
  if (args.includes('--help') || args.includes('-h')) {
    console.log('gwbench matrix —— 经典模型×网关横评，发布到 web/reports/。见文件头注释。');
    return;
  }
  const root = new URL('..', import.meta.url);
  const gateways = JSON.parse(await readFile(new URL('data/gateways.json', root), 'utf8'));
  const tracked = JSON.parse(await readFile(new URL('data/tracked-models.json', root), 'utf8'));
  const version = JSON.parse(await readFile(new URL('package.json', root), 'utf8')).version;
  let prices = null;
  try { prices = JSON.parse(await readFile(new URL('data/prices.json', root), 'utf8')); } catch {}

  const onlyModels = flag('models') ? String(flag('models')).split(',').map((s) => s.trim()).filter(Boolean) : null;
  const models = (onlyModels ?? tracked.map((t) => t.id));
  const samples = Number(flag('samples', 3));
  const minGw = Number(flag('min', 2));
  const region = flag('region') || process.env.PROBE_REGION || 'local';
  const startedAt = new Date().toISOString();

  const entries = [];
  for (const model of models) {
    const priceRow = prices?.models?.find((p) => p.model === model) ?? null;
    const official = Array.isArray(priceRow?.official) ? priceRow.official : null;
    const { targets } = resolveTargets({ model, adhoc: null, withIds: null, gateways, tracked });
    const probed = [];
    for (const t of targets) {
      const key = process.env[t.authEnv];
      if (!key) { console.error(`[skip] ${model} @ ${t.name}: 缺 ${t.authEnv}`); continue; }
      const gw = { id: t.id, name: t.name, baseUrl: t.baseUrl, authEnv: t.authEnv, probeModels: [t.alias], tags: [] };
      const { connectivity, models: ms } = await probeGateway(gw, key, { samples });
      const price = Array.isArray(priceRow?.cells?.[t.id]) ? priceRow.cells[t.id] : null;
      probed.push(buildTarget({ name: t.name, host: host(t.baseUrl), connectivity, models: ms, price, official }));
    }
    if (probed.length < minGw) { console.error(`[matrix] ${model}: 仅 ${probed.length} 个网关有数据（<${minGw}），跳过`); continue; }

    const report = buildReport({ model, region, samplesPerTarget: samples, version, generatedAt: new Date().toISOString(), targets: probed });
    report.kind = 'compare';
    report.source = 'baseline';
    report.title = `${model} · ${probed.length} 个网关实测横评`;
    const id = matrixSlug(model);
    await mkdir(new URL('web/reports', root), { recursive: true });
    await writeFile(new URL(`web/reports/${id}.json`, root), JSON.stringify(report, null, 2));
    entries.push(matrixIndexEntry(report, id));
    console.error(`[matrix] ${model}: ${probed.length} 网关 → web/reports/${id}.json · 最快 ${report.comparison.fastestTtft ?? '—'} · 最便宜 ${report.comparison.cheapest ?? '—'}`);
  }

  if (!entries.length) { console.error('[matrix] 没有任何模型达到 min 网关数——未更新广场（多半是只有一家 key）'); return; }
  let index = null;
  try { index = JSON.parse(await readFile(new URL('web/reports/index.json', root), 'utf8')); } catch {}
  const next = mergeMatrixIndex(index, entries, startedAt);
  await writeFile(new URL('web/reports/index.json', root), JSON.stringify(next, null, 2));
  console.log(`web/reports/index.json: ${entries.length} 个矩阵报告，共 ${next.reports.length} 份`);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
