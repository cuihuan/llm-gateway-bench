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
  // The remaining 4xx (400/404/422…) are request/config problems — the model doesn't exist on this
  // gateway, an unsupported param, or improper probe usage — not a gateway outage. Aligned with
  // OpenRouter's uptime convention (exclude user-side 4xx), so like auth it doesn't count toward the
  // availability denominator. 429 stays listed separately (rate limiting is a real availability signal).
  if (/HTTP 4\d\d\b/.test(msg)) return 'user';
  if (/HTTP 5\d\d\b/.test(msg)) return '5xx';
  if (/timeout|timed? ?out|aborted/i.test(msg)) return 'timeout';
  return 'other';
}

// Error classes excluded from the availability denominator: auth (401/403) + other user-side 4xx.
// These are prober/config issues, not gateway failures — counting them would unfairly penalize the gateway.
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

  // Time-of-day profile (by UTC hour): a core value of probing — it reveals "slower / rate-limited
  // at peak". Each hour with data gets a TTFT p50 and a success rate. peakDrift = slowest-hour TTFT
  // ÷ fastest-hour TTFT (≥2 indicates clear peak drift), worstOkRateHour = the hour with the lowest
  // success rate. Null when the window is too empty.
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

  // Streaming-authenticity snapshot: among judgeable models in the latest run, the count of suspected fake streaming (burstStreamRate≥0.5)
  let streamBurst = null;
  if (latest) {
    const rows = (latest.models ?? []).filter((m) => typeof m.burstStreamRate === 'number');
    if (rows.length) {
      streamBurst = { suspect: rows.filter((m) => m.burstStreamRate >= 0.5).length, total: rows.length };
    }
  }

  // usage recompute fingerprint (per model, from the latest run): a low charsPerToken = suspected
  // inflated tokens. The basis for cross-gateway same-model comparison — the comparison is done across gateways in main().
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

  // Integrity snapshot (latest run): for each of model echo / CJK output / context truncation, how
  // many judgeable models passed. Any value <total means suspected substitution/quantization/truncation.
  // Null for a check when there are no judgeable models.
  const snap = (pred, has) => {
    const rows = (latest?.models ?? []).filter(has);
    return rows.length ? { ok: rows.filter(pred).length, total: rows.length } : null;
  };
  const integrity = latest ? {
    modelEcho: snap((m) => m.modelEchoRate === 1, (m) => typeof m.modelEchoRate === 'number'),
    cjk: snap((m) => m.cjk?.ok, (m) => m.cjk),
    needle: snap((m) => m.needle?.ok, (m) => m.needle),
  } : null;

  // Prompt-cache snapshot (latest run): among models that report cache info, how many were observed
  // to hit the cache. reported<total = some models don't report cache info; supported<reported = reported but no hit.
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
 * Pick the primary region: the region of the most recent probe (headline stats reflect only this one
 * observation point, avoiding mixing different network perspectives). Legacy data with no region tag
 * is normalized to 'unknown'.
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
  // A single corrupt file (a half-written CI run, a bad PR) shouldn't crash the whole aggregation — skip it and warn.
  for (const f of files.sort()) {
    try { out.push(JSON.parse(await readFile(new URL(f, dirUrl + '/'), 'utf8'))); }
    catch (e) { console.error(`[aggregate] skipping corrupt file ${f}: ${e.message}`); }
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
      // Different regions are different network observation points (domestic direct vs overseas) and
      // can't be mixed — the headline uses only the primary region (the region of the latest probe);
      // per-region success/latency is listed separately in byRegion for per-region display.
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
        // Category tier (for the frontend's "quick filter" by type): official direct / first-party provider / relay gateway.
        category: gw.tags.includes('official') ? 'Official direct' : gw.tags.includes('provider') ? 'Provider' : 'Gateway',
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

  // Model evaluation dataset (price/value + future benchmarks/scenarios): data/models.json → web/ for the static page to fetch
  try {
    const models = JSON.parse(await readFile(new URL('data/models.json', root), 'utf8'));
    await writeFile(new URL('web/models.json', root), JSON.stringify(models, null, 2));
    console.log(`web/models.json: ${models.models?.length ?? 0} models`);
  } catch (e) { console.error('[aggregate] models.json skipped:', e.message); }

  // Single source of truth for report rendering: mirror the pure-function report.mjs into web/, so the
  // report gallery (reports.html) renders shared reports in the browser with the exact same
  // renderReportHtml as the CLI (Pages deploys web/ directly, so this file must be committed to the
  // repo). report.mjs has no external dependencies and is browser-ESM compatible.
  try {
    const src = await readFile(new URL('probe/report.mjs', root), 'utf8');
    await writeFile(new URL('web/report.mjs', root), src);
    console.log('web/report.mjs: mirrored from probe/report.mjs');
  } catch (e) { console.error('[aggregate] report.mjs mirror skipped:', e.message); }

  // Price comparison (real data, no key needed): pivot the public pricing in data/prices.json into a
  // 'classic models × gateways' price comparison report, serving as the gallery's real flagship report
  // (not a demo). Refreshes with pricing.
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
        id: 'price-matrix', kind: 'pricematrix', model: null, region: 'Public pricing API',
        generatedAt: pm.generatedAt, demo: false, title: 'Classic models × gateways · Price comparison (public pricing, no key needed)',
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
