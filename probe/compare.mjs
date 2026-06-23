#!/usr/bin/env node
// gwbench compare —— 自助对比工具。把同一个逻辑模型在「你自己的网关」+ OpenRouter +
// 其它已登记网关上一把跑完整套黑盒拨测，产出便携对比报告（report.json + report.html）。
//
// 痛点：要接一个新网关，没有顺手的工具横向比一比。这就是那个工具。
// key 只从环境变量读，绝不入报告、绝不出本机（隐私红线，见 docs/PRODUCT-SPEC.md §2A）。
//
// 用法：
//   node probe/compare.mjs --model <trackedId> [选项]
//
// 选项：
//   --model <id>        逻辑模型（data/tracked-models.json 里的 id），报告以它为标签
//   --url <baseUrl>     把「你自己的网关」加进对比（OpenAI 兼容端点）
//   --alias <model>     配合 --url：该模型在你网关上的名字（默认取 --model）
//   --name <name>       配合 --url：报告里显示的名字（默认取 host）
//   --auth-env <NAME>   配合 --url：存 key 的环境变量名（默认 PROBE_KEY）
//   --with <id,id>      要对比的已登记网关（默认：所有有该模型别名且环境里有 key 的）
//   --price-in <usd>    配合 --url：你网关该模型的输入价（USD/1M），让自建网关进入价格对比
//   --price-out <usd>   配合 --url：你网关该模型的输出价（USD/1M）
//   --samples <n>       每个目标的采样次数（默认 3）
//   --region <label>    探测视角标签写进报告（默认取 PROBE_REGION 或 'local'）
//   --out <path>        报告输出前缀（默认 reports/<model>-<时间戳>），产出 .json 与 .html
//   -h, --help          显示本帮助
//
// 示例：
//   # 我的网关 vs OpenRouter vs AiHubMix，比 gemini-2.5-flash
//   PROBE_KEY=sk-mine OPENROUTER_API_KEY=sk-or AIHUBMIX_API_KEY=sk-ah \
//   node probe/compare.mjs --model gemini-2.5-flash \
//     --url https://my-gateway.com --name "我的网关" --with openrouter,aihubmix

import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { probeGateway } from './probe.mjs';
import { buildTarget, buildReport, renderReportHtml } from './report.mjs';

const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const host = (url) => String(url).replace(/^https?:\/\//, '').replace(/\/+$/, '');

export function usage() {
  return readFileHeaderComment();
}
function readFileHeaderComment() {
  return `gwbench compare —— 同一模型横评多个网关，产出便携对比报告。

用法:
  node probe/compare.mjs --model <trackedId> [--url <你的网关> --name <名> --auth-env <ENV>] [--with id,id] [--samples 3] [--out <前缀>]

key 只从环境变量读，不入报告、不出本机。完整选项见文件头注释。`;
}

/**
 * 解析对比目标列表（纯函数，便于单测）。返回 [{ id, name, baseUrl, authEnv, alias, source }]。
 * - ad-hoc：有 --url 时加入一个「你自己的网关」目标；
 * - registry：--with 指定的网关 id（默认所有在 tracked 里有该模型别名的网关），
 *   别名取 tracked-models.json[model].aliases[gatewayId]，无别名则跳过（带 note）。
 * notes 收集被跳过目标的原因，供 CLI 打印。
 */
export function resolveTargets({ model, adhoc, withIds, gateways, tracked }) {
  const targets = [];
  const notes = [];
  if (adhoc?.url) {
    targets.push({
      id: 'adhoc', source: 'adhoc',
      name: adhoc.name || host(adhoc.url),
      baseUrl: String(adhoc.url).replace(/\/+$/, ''),
      authEnv: adhoc.authEnv || 'PROBE_KEY',
      alias: adhoc.alias || model,
    });
  }
  const trackedEntry = (tracked ?? []).find((t) => t.id === model) ?? null;
  const aliases = trackedEntry?.aliases ?? {};
  const candidateIds = withIds && withIds.length
    ? withIds
    : Object.keys(aliases); // 默认：所有在 tracked 里给了别名的网关
  for (const id of candidateIds) {
    const gw = (gateways ?? []).find((g) => g.id === id);
    if (!gw) { notes.push(`未知网关 '${id}'（不在 data/gateways.json）`); continue; }
    const alias = aliases[id];
    if (!alias) { notes.push(`'${id}' 没有 '${model}' 的别名（data/tracked-models.json）`); continue; }
    targets.push({
      id, source: 'registry', name: gw.name,
      baseUrl: gw.baseUrl.replace(/\/+$/, ''), authEnv: gw.authEnv, alias,
    });
  }
  return { targets, notes };
}

function tsStamp(iso) {
  return `${iso.slice(0, 10)}T${iso.slice(11, 19).replaceAll(':', '')}`;
}

async function main() {
  if (args.includes('--help') || args.includes('-h')) { console.log(usage()); return; }
  const model = flag('model');
  if (!model) { console.error('[compare] 需要 --model <trackedId>。看 --help。'); process.exit(1); }

  const root = new URL('..', import.meta.url);
  const gateways = JSON.parse(await readFile(new URL('data/gateways.json', root), 'utf8'));
  const tracked = JSON.parse(await readFile(new URL('data/tracked-models.json', root), 'utf8'));
  const version = JSON.parse(await readFile(new URL('package.json', root), 'utf8')).version;
  // 价格快照（可选）：给对比报告补上'价格 + 倍率'列。缺文件不影响其它维度。
  let prices = null;
  try { prices = JSON.parse(await readFile(new URL('data/prices.json', root), 'utf8')); } catch {}
  const priceRow = prices?.models?.find((p) => p.model === model) ?? null;
  const official = Array.isArray(priceRow?.official) ? priceRow.official : null;
  const adhocPriceIn = flag('price-in') != null ? Number(flag('price-in')) : null;
  const adhocPriceOut = flag('price-out') != null ? Number(flag('price-out')) : null;
  const adhocPrice = Number.isFinite(adhocPriceIn) && Number.isFinite(adhocPriceOut) ? [adhocPriceIn, adhocPriceOut] : null;
  // 解析某目标的网关价 [入,出]：registry 取 prices.json 对应网关列；ad-hoc 取 --price-in/out。
  const priceFor = (t) => (t.source === 'adhoc' ? adhocPrice : (Array.isArray(priceRow?.cells?.[t.id]) ? priceRow.cells[t.id] : null));

  const adhoc = flag('url') ? { url: flag('url'), alias: flag('alias'), name: flag('name'), authEnv: flag('auth-env') } : null;
  const withIds = flag('with') ? String(flag('with')).split(',').map((s) => s.trim()).filter(Boolean) : null;
  const { targets, notes } = resolveTargets({ model, adhoc, withIds, gateways, tracked });
  for (const n of notes) console.error(`[skip] ${n}`);
  if (!targets.length) { console.error('[compare] 没有可对比的目标。检查 --model / --with / --url。'); process.exit(1); }

  const samples = Number(flag('samples', 3));
  const region = flag('region') || process.env.PROBE_REGION || 'local';
  const startedAt = new Date().toISOString();
  const probed = [];
  for (const t of targets) {
    const key = process.env[t.authEnv];
    if (!key) { console.error(`[skip] ${t.name}: 环境变量 ${t.authEnv} 未设置`); continue; }
    const gw = { id: t.id, name: t.name, baseUrl: t.baseUrl, authEnv: t.authEnv, probeModels: [t.alias], tags: [] };
    const { connectivity, models } = await probeGateway(gw, key, { samples });
    probed.push(buildTarget({ name: t.name, host: host(t.baseUrl), connectivity, models, price: priceFor(t), official }));
  }
  if (!probed.length) { console.error('[compare] 所有目标都因缺 key 被跳过——没产出报告。'); process.exit(1); }

  const report = buildReport({
    model, region, samplesPerTarget: samples, version,
    generatedAt: new Date().toISOString(), targets: probed,
  });

  const out = flag('out') || `reports/${model}-${tsStamp(startedAt)}`;
  const dir = out.includes('/') ? out.slice(0, out.lastIndexOf('/')) : '.';
  await mkdir(new URL(dir, root), { recursive: true });
  await writeFile(new URL(`${out}.json`, root), JSON.stringify(report, null, 2));
  await writeFile(new URL(`${out}.html`, root), renderReportHtml(report));
  const cmp = report.comparison;
  console.error(`[compare] ${probed.length} 个目标 · 最快 ${cmp.fastestTtft ?? '—'} · 吞吐最高 ${cmp.highestThroughput ?? '—'} · 最便宜 ${cmp.cheapest ?? '—'} · 红旗 ${cmp.flags.length}`);
  console.log(`${out}.html`);
  console.log(`${out}.json`);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
