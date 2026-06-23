#!/usr/bin/env node
// Aggregates data/results/*.json + data/annotations/*.json + data/prices.json
// into web/data.json — the single file the static leaderboard renders from.
//
// Fairness rules encoded here (mirrored in docs/methodology.md):
//   - User-side errors are EXCLUDED from uptime and disclosed separately
//     (authExcluded): 401/403 from the prober's own key (model whitelist) AND
//     other 4xx (400/404/422…: model absent on this gateway, unsupported param,
//     bad probe usage). These are prober/config issues, not gateway outages —
//     same convention as OpenRouter's uptime. 429 stays counted (real signal).
//   - No black-box composite score. priceIdx is the only derived number:
//     geometric mean of (gateway price ÷ official price) over comparable models.

import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { percentile } from './metrics.mjs';
import { buildPriceMatrixReport } from './report.mjs';

const WINDOW_DAYS = 30;

export function classifyError(msg) {
  if (typeof msg !== 'string') return 'other';
  if (/HTTP 4(01|03)\b/.test(msg)) return 'auth';
  if (/HTTP 429\b/.test(msg)) return '429';
  // 其余 4xx(400/404/422…)是请求/配置问题——模型在该网关不存在、参数不支持、
  // 探针用法不当——不是网关宕机。对齐 OpenRouter uptime 口径(排除用户侧 4xx),
  // 与 auth 一样不计入可用率分母。429 仍单列保留(限流是真实可用性信号)。
  if (/HTTP 4\d\d\b/.test(msg)) return 'user';
  if (/HTTP 5\d\d\b/.test(msg)) return '5xx';
  if (/timeout|timed? ?out|aborted/i.test(msg)) return 'timeout';
  return 'other';
}

// 计入"排除出可用率分母"的错误类:鉴权(401/403)+ 其余用户侧 4xx。
// 这些是探针/配置问题,不是网关故障——计入会冤枉网关。
const EXCLUDED_FROM_UPTIME = new Set(['auth', 'user']);

const dayOf = (iso) => iso.slice(0, 10);
const round = (x, d = 0) => (x == null ? null : Math.round(x * 10 ** d) / 10 ** d);

/**
 * Roll up one gateway's entries across runs.
 * runEntries: [{ startedAt, connectivity, models:[{model,samples,success,ttftMs,tokensPerSec,errors}] }]
 * `today` is injectable for tests (YYYY-MM-DD).
 *
 * All stability stats (uptimePct, uptime7dPct, probes, errors, authExcluded)
 * honor the WINDOW_DAYS window; only lastRun/connectivity reflect the absolute
 * latest run, and the speed snapshot the latest run with ≥1 successful sample.
 */
export function rollupGateway(runEntries, today) {
  const end = new Date(`${today}T00:00:00Z`).getTime();
  const windowStart = new Date(end - (WINDOW_DAYS - 1) * 86_400_000).toISOString().slice(0, 10);
  const day7Start = new Date(end - 6 * 86_400_000).toISOString().slice(0, 10);

  const byDay = new Map();  // day -> {ok, total, ttfts:[]}
  const byHour = new Map(); // UTC hour-of-day 0-23 -> {ok, total, ttfts:[]}
  const errors = { '429': 0, '5xx': 0, timeout: 0, other: 0 };
  let authExcluded = 0;
  let probes = 0;
  let latest = null;   // current state: connectivity, lastRun
  let latestOk = null; // speed snapshot source

  for (const run of runEntries) {
    if (!latest || run.startedAt > latest.startedAt) latest = run;
    if ((run.models ?? []).some((m) => m.success > 0) && (!latestOk || run.startedAt > latestOk.startedAt)) latestOk = run;
    const day = dayOf(run.startedAt);
    if (day < windowStart || day > today) continue;
    if (!byDay.has(day)) byDay.set(day, { ok: 0, total: 0, ttfts: [] });
    const hour = new Date(run.startedAt).getUTCHours();
    if (!byHour.has(hour)) byHour.set(hour, { ok: 0, total: 0, ttfts: [] });
    const bucket = byDay.get(day);
    const hbucket = byHour.get(hour);
    for (const m of run.models ?? []) {
      const classes = (m.errors ?? []).map(classifyError);
      const failed = m.samples - m.success;
      // errors[] is capped at 5 per model by metrics.summarize(); when every
      // captured error is a user-side problem (auth or other 4xx), attribute
      // ALL failures to it (prober/config issue, not a gateway outage),
      // otherwise count the excluded classes one by one.
      const excludedN = classes.length > 0 && classes.every((c) => EXCLUDED_FROM_UPTIME.has(c))
        ? failed
        : classes.filter((c) => EXCLUDED_FROM_UPTIME.has(c)).length;
      authExcluded += excludedN;
      const counted = m.samples - excludedN;
      if (counted <= 0) continue;
      probes += counted;
      bucket.total += counted;
      bucket.ok += m.success;
      hbucket.total += counted;
      hbucket.ok += m.success;
      for (const c of classes) { if (!EXCLUDED_FROM_UPTIME.has(c)) errors[c]++; }
      if (typeof m.ttftMs?.p50 === 'number') { bucket.ttfts.push(m.ttftMs.p50); hbucket.ttfts.push(m.ttftMs.p50); }
    }
  }

  // last WINDOW_DAYS calendar days ending today
  const daysArr = [];
  const trend = [];
  for (let i = WINDOW_DAYS - 1; i >= 0; i--) {
    const d = new Date(end - i * 86_400_000).toISOString().slice(0, 10);
    const b = byDay.get(d);
    if (!b || b.total === 0) { daysArr.push({ date: d, status: 'n' }); continue; }
    const rate = b.ok / b.total;
    daysArr.push({ date: d, status: rate >= 0.99 ? 'g' : rate >= 0.8 ? 'w' : 'b' });
    if (b.ttfts.length) trend.push({ date: d, ttftP50: round(percentile(b.ttfts, 50)) });
  }

  let ok = 0, total = 0, ok7 = 0, total7 = 0;
  for (const [d, b] of byDay) {
    ok += b.ok; total += b.total;
    if (d >= day7Start) { ok7 += b.ok; total7 += b.total; }
  }

  // 时段画像（按 UTC 小时）：拨测核心价值——揭示"高峰期变慢/限速"。每个有数据
  // 的小时给 TTFT p50 与成功率。peakDrift = 最慢小时 TTFT ÷ 最快小时 TTFT（≥2
  // 表示存在明显高峰漂移），worstOkRateHour = 成功率最低的小时。窗口太空则为 null。
  const hourly = [...byHour.entries()]
    .map(([hour, b]) => ({
      hour,
      ttftP50: b.ttfts.length ? round(percentile(b.ttfts, 50)) : null,
      okRate: b.total ? round((b.ok / b.total) * 100, 1) : null,
      n: b.total,
    }))
    .sort((a, b) => a.hour - b.hour);
  let peakDrift = null;
  const ttftHours = hourly.filter((h) => h.ttftP50 != null);
  if (ttftHours.length >= 2) {
    const slow = ttftHours.reduce((a, b) => (b.ttftP50 > a.ttftP50 ? b : a));
    const fast = ttftHours.reduce((a, b) => (b.ttftP50 < a.ttftP50 ? b : a));
    const worst = hourly.filter((h) => h.okRate != null).reduce((a, b) => (b.okRate < a.okRate ? b : a), { okRate: 101 });
    peakDrift = {
      ratio: round(slow.ttftP50 / Math.max(fast.ttftP50, 1), 2),
      slowHour: slow.hour, slowTtft: slow.ttftP50,
      fastHour: fast.hour, fastTtft: fast.ttftP50,
      worstOkRateHour: worst.hour ?? null, worstOkRate: worst.okRate <= 100 ? worst.okRate : null,
    };
  }

  // 流式真实性快照：最近一次运行里可判定模型中，疑似假流式（burstStreamRate≥0.5）的个数
  let streamBurst = null;
  if (latest) {
    const rows = (latest.models ?? []).filter((m) => typeof m.burstStreamRate === 'number');
    if (rows.length) {
      streamBurst = { suspect: rows.filter((m) => m.burstStreamRate >= 0.5).length, total: rows.length };
    }
  }

  // usage 重算指纹（按模型，取最近一次运行）：charsPerToken 偏低=疑似虚报 token。
  // 跨网关同模型比对的依据——comparison 在 main() 里跨网关做。
  let usageByModel = null;
  if (latest) {
    const rows = (latest.models ?? []).filter((m) => m.usage && (m.usage.charsPerToken != null || m.usage.promptTokens != null));
    if (rows.length) {
      usageByModel = rows.map((m) => ({ model: m.model, charsPerToken: m.usage.charsPerToken ?? null, promptTokens: m.usage.promptTokens ?? null }));
    }
  }

  // tool-call capability snapshot from the most recent run that attempted it
  let toolCalls = null;
  if (latest) {
    const rows = (latest.models ?? []).filter((m) => m.toolCall);
    if (rows.length) {
      toolCalls = {
        ok: rows.filter((m) => m.toolCall.ok).length,
        total: rows.length,
        nonStreamMs: round(percentile(rows.map((m) => m.toolCall.totalMs).filter((v) => typeof v === 'number'), 50)),
      };
    }
  }

  // 完整性快照（最近一次运行）：模型回显/CJK 输出/上下文截断三项可判定模型里
  // 各有几个通过。任一 <total 即出现疑似偷换/量化/截断。无可判定模型则该项 null。
  const snap = (pred, has) => {
    const rows = (latest?.models ?? []).filter(has);
    return rows.length ? { ok: rows.filter(pred).length, total: rows.length } : null;
  };
  const integrity = latest ? {
    modelEcho: snap((m) => m.modelEchoRate === 1, (m) => typeof m.modelEchoRate === 'number'),
    cjk: snap((m) => m.cjk?.ok, (m) => m.cjk),
    needle: snap((m) => m.needle?.ok, (m) => m.needle),
  } : null;

  // 提示缓存快照（最近一次运行）：在上报缓存口径的模型里，有几个观察到缓存命中。
  // reported<总数 = 部分模型不上报缓存口径；supported<reported = 上报但未命中。
  let cache = null;
  if (latest) {
    const reported = (latest.models ?? []).filter((m) => m.cache && m.cache.reported);
    if (reported.length) cache = { supported: reported.filter((m) => m.cache.supported).length, reported: reported.length, total: (latest.models ?? []).length };
  }

  let ttftP50 = null, ttftP95 = null, tps = null;
  if (latestOk) {
    const rows = (latestOk.models ?? []).filter((m) => m.success > 0);
    const p50s = rows.map((m) => m.ttftMs?.p50).filter((v) => typeof v === 'number');
    const p95s = rows.map((m) => m.ttftMs?.p95).filter((v) => typeof v === 'number');
    const tpss = rows.map((m) => m.tokensPerSec?.avg).filter((v) => typeof v === 'number');
    ttftP50 = round(percentile(p50s, 50));
    ttftP95 = round(percentile(p95s, 50));
    tps = tpss.length ? round(tpss.reduce((a, b) => a + b, 0) / tpss.length) : null;
  }

  return {
    probes,
    uptimePct: total ? round((ok / total) * 100, 2) : null,
    uptime7dPct: total7 ? round((ok7 / total7) * 100, 2) : null,
    daysArr,
    errors,
    authExcluded,
    speed: { ttftP50, ttftP95, tps, trend },
    toolCalls,
    streamBurst,
    usageByModel,
    integrity,
    cache,
    hourly,
    peakDrift,
    connMs: latest?.connectivity?.latencyMs ?? null,
    connOk: latest?.connectivity?.ok ?? null,
    modelCount: latest?.connectivity?.modelCount ?? null,
    lastRun: latest?.startedAt ?? null,
  };
}

/**
 * 选主地域：取最近一次拨测所属的 region（headline 统计只反映这一个观测点，
 * 避免把不同网络视角混算）。无 region 标注的旧数据归一为 'unknown'。
 */
export function pickPrimaryRegion(entries) {
  let latest = null;
  for (const e of entries ?? []) {
    if (!e.startedAt) continue;
    if (!latest || e.startedAt > latest.startedAt) latest = e;
  }
  return latest ? (latest.region ?? 'unknown') : null;
}

/**
 * Price index. Per model the ratio is the ARITHMETIC mean of the input-price
 * ratio and output-price ratio (documented in docs/methodology.md — matters
 * for asymmetric pricing); the index is the geometric mean of those per-model
 * ratios over all comparable models.
 */
export function priceIndex(priceModels, gatewayId) {
  const ratios = [];
  for (const m of priceModels ?? []) {
    const cell = m.cells?.[gatewayId];
    if (!cell || !m.official) continue;
    const r = (cell[0] / m.official[0] + cell[1] / m.official[1]) / 2;
    if (isFinite(r) && r > 0) ratios.push(r);
  }
  if (!ratios.length) return null;
  return round(Math.exp(ratios.reduce((a, r) => a + Math.log(r), 0) / ratios.length), 2);
}

async function readJsonDir(dirUrl) {
  let files = [];
  try { files = (await readdir(dirUrl)).filter((f) => f.endsWith('.json')); } catch { return []; }
  const out = [];
  // 单个损坏文件（CI 写一半中断、坏 PR）不应让整个聚合崩掉——跳过并告警。
  for (const f of files.sort()) {
    try { out.push(JSON.parse(await readFile(new URL(f, dirUrl + '/'), 'utf8'))); }
    catch (e) { console.error(`[aggregate] 跳过损坏文件 ${f}: ${e.message}`); }
  }
  return out;
}

async function main() {
  const root = new URL('..', import.meta.url);
  const gateways = JSON.parse(await readFile(new URL('data/gateways.json', root), 'utf8'));
  const runs = await readJsonDir(new URL('data/results', root));
  const annotations = await readJsonDir(new URL('data/annotations', root));
  let prices = null;
  try { prices = JSON.parse(await readFile(new URL('data/prices.json', root), 'utf8')); } catch {}

  const today = new Date().toISOString().slice(0, 10);
  const annoById = Object.fromEntries(annotations.map((a) => [a.id, a]));
  const regions = [...new Set(runs.map((r) => r.region))];

  const site = {
    generatedAt: new Date().toISOString(),
    demo: false,
    windowDays: WINDOW_DAYS,
    regions,
    runCount: runs.length,
    gateways: gateways.map((gw) => {
      const entries = runs
        .map((r) => ({ region: r.region, startedAt: r.startedAt, ...(r.results.find((x) => x.gateway === gw.id && !x.skipped) ?? {}) }))
        .filter((e) => e.models || e.connectivity);
      // 不同地域是不同的网络观测点（国内直连 vs 海外），不能混算——headline 只用
      // 主地域（最近一次拨测的地域），各地域成功率/延迟另列在 byRegion，供分地域展示。
      const primaryRegion = pickPrimaryRegion(entries);
      const roll = rollupGateway(entries.filter((e) => e.region === primaryRegion), today);
      const gwRegions = [...new Set(entries.map((e) => e.region))];
      const byRegion = Object.fromEntries(gwRegions.map((rg) => {
        const r = rollupGateway(entries.filter((e) => e.region === rg), today);
        return [rg, { uptimePct: r.uptimePct, uptime7dPct: r.uptime7dPct, probes: r.probes, ttftP50: r.speed.ttftP50, connMs: r.connMs }];
      }));
      return {
        id: gw.id,
        name: gw.name,
        host: gw.baseUrl.replace(/^https?:\/\//, ''),
        website: gw.website,
        protocols: gw.tags.includes('anthropic-compatible') ? 'OpenAI · Anthropic' : 'OpenAI',
        // 类型分档（供前端"速选"按类型筛选）：官方直连 / 一手供应商 / 中转网关。
        category: gw.tags.includes('official') ? '官方直连' : gw.tags.includes('provider') ? '供应商' : '网关',
        pricing: gw.pricingUrl,
        probeModels: gw.probeModels,
        priceIdx: priceIndex(prices?.models, gw.id),
        trust: annoById[gw.id] ?? null,
        region: primaryRegion,
        byRegion,
        ...roll,
      };
    }),
    prices,
  };

  await writeFile(new URL('web/data.json', root), JSON.stringify(site, null, 2));
  console.log(`web/data.json: ${site.gateways.length} gateways, ${runs.length} runs, regions=${regions.join(',') || 'none'}`);

  // 模型评测集数据集（价格价值 + 后续 benchmark/场景）：data/models.json → web/ 供静态页 fetch
  try {
    const models = JSON.parse(await readFile(new URL('data/models.json', root), 'utf8'));
    await writeFile(new URL('web/models.json', root), JSON.stringify(models, null, 2));
    console.log(`web/models.json: ${models.models?.length ?? 0} models`);
  } catch (e) { console.error('[aggregate] models.json skipped:', e.message); }

  // 报告渲染单一来源：把纯函数 report.mjs 镜像到 web/，让报告广场（reports.html）
  // 在浏览器里用与 CLI 完全相同的 renderReportHtml 渲染分享报告（pages 直接部署
  // web/，故此文件需提交进仓库）。report.mjs 无外部依赖、浏览器 ESM 兼容。
  try {
    const src = await readFile(new URL('probe/report.mjs', root), 'utf8');
    await writeFile(new URL('web/report.mjs', root), src);
    console.log('web/report.mjs: mirrored from probe/report.mjs');
  } catch (e) { console.error('[aggregate] report.mjs mirror skipped:', e.message); }

  // 价格横评（真实数据，无需 key）：把 data/prices.json 的公开定价 pivot 成一份
  // '经典模型 × 网关'价格对比报告，作为报告广场的真实旗舰报告（非 demo）。随价格刷新。
  try {
    if (prices) {
      let version = '0.0.0';
      try { version = JSON.parse(await readFile(new URL('package.json', root), 'utf8')).version; } catch {}
      const pm = buildPriceMatrixReport(prices, { gateways, generatedAt: new Date().toISOString(), version });
      await mkdir(new URL('web/reports', root), { recursive: true });
      await writeFile(new URL('web/reports/price-matrix.json', root), JSON.stringify(pm, null, 2));
      let idx = null;
      try { idx = JSON.parse(await readFile(new URL('web/reports/index.json', root), 'utf8')); } catch {}
      const entry = {
        id: 'price-matrix', kind: 'pricematrix', model: null, region: '公开定价 API',
        generatedAt: pm.generatedAt, demo: false, title: '经典模型 × 网关 · 价格横评（公开定价，无需 key）',
        targetCount: pm.rows.length, fastestTtft: null, cheapest: null, flagCount: 0, source: 'baseline',
      };
      const reports = [entry, ...((idx?.reports ?? []).filter((x) => x.id !== 'price-matrix'))];
      await writeFile(new URL('web/reports/index.json', root), JSON.stringify({ schema: idx?.schema ?? 'gwbench-reports-index/1', updatedAt: pm.generatedAt, reports }, null, 2));
      console.log(`web/reports/price-matrix.json: ${pm.rows.length} models × ${pm.gateways.length} gateways`);
    }
  } catch (e) { console.error('[aggregate] price-matrix skipped:', e.message); }
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
