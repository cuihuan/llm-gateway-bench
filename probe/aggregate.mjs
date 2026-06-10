#!/usr/bin/env node
// Aggregates data/results/*.json + data/annotations/*.json + data/prices.json
// into web/data.json — the single file the static leaderboard renders from.
//
// Fairness rules encoded here (mirrored in docs/methodology.md):
//   - 401/403 from the prober's own key (e.g. model whitelist) are EXCLUDED from
//     stability stats and disclosed separately — they are prober config issues,
//     not gateway failures.
//   - No black-box composite score. priceIdx is the only derived number:
//     geometric mean of (gateway price ÷ official price) over comparable models.

import { readFile, readdir, writeFile } from 'node:fs/promises';
import { percentile } from './metrics.mjs';

const WINDOW_DAYS = 30;

export function classifyError(msg) {
  if (typeof msg !== 'string') return 'other';
  if (/HTTP 4(01|03)\b/.test(msg)) return 'auth';
  if (/HTTP 429\b/.test(msg)) return '429';
  if (/HTTP 5\d\d\b/.test(msg)) return '5xx';
  if (/timeout|timed? ?out|aborted/i.test(msg)) return 'timeout';
  return 'other';
}

const dayOf = (iso) => iso.slice(0, 10);
const round = (x, d = 0) => (x == null ? null : Math.round(x * 10 ** d) / 10 ** d);

/**
 * Roll up one gateway's entries across runs.
 * runEntries: [{ startedAt, connectivity, models:[{model,samples,success,ttftMs,tokensPerSec,errors}] }]
 * `today` is injectable for tests (YYYY-MM-DD).
 */
export function rollupGateway(runEntries, today) {
  const byDay = new Map(); // day -> {ok, total, ttfts:[]}
  const errors = { '429': 0, '5xx': 0, timeout: 0, other: 0 };
  let authExcluded = 0;
  let probes = 0;
  let latest = null;

  for (const run of runEntries) {
    if (!latest || run.startedAt > latest.startedAt) latest = run;
    const day = dayOf(run.startedAt);
    if (!byDay.has(day)) byDay.set(day, { ok: 0, total: 0, ttfts: [] });
    const bucket = byDay.get(day);
    for (const m of run.models ?? []) {
      const classes = (m.errors ?? []).map(classifyError);
      const allAuth = m.success === 0 && classes.length > 0 && classes.every((c) => c === 'auth');
      if (allAuth) { authExcluded += m.samples; continue; }
      probes += m.samples;
      bucket.total += m.samples;
      bucket.ok += m.success;
      for (const c of classes) { if (c !== 'auth') errors[c]++; else authExcluded++; }
      if (typeof m.ttftMs?.p50 === 'number') bucket.ttfts.push(m.ttftMs.p50);
    }
  }

  // last WINDOW_DAYS calendar days ending today
  const end = new Date(`${today}T00:00:00Z`).getTime();
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

  let ok = 0, total = 0;
  for (const b of byDay.values()) { ok += b.ok; total += b.total; }

  // speed snapshot from the most recent run that has successful samples
  let ttftP50 = null, ttftP95 = null, tps = null;
  if (latest) {
    const rows = (latest.models ?? []).filter((m) => m.success > 0);
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
    daysArr,
    errors,
    authExcluded,
    speed: { ttftP50, ttftP95, tps, trend },
    connMs: latest?.connectivity?.latencyMs ?? null,
    connOk: latest?.connectivity?.ok ?? null,
    modelCount: latest?.connectivity?.modelCount ?? null,
    lastRun: latest?.startedAt ?? null,
  };
}

/** geometric mean of gateway/official price ratios over comparable models */
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
  for (const f of files.sort()) out.push(JSON.parse(await readFile(new URL(f, dirUrl + '/'), 'utf8')));
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
        .map((r) => ({ startedAt: r.startedAt, ...(r.results.find((x) => x.gateway === gw.id && !x.skipped) ?? {}) }))
        .filter((e) => e.models || e.connectivity);
      const roll = rollupGateway(entries, today);
      return {
        id: gw.id,
        name: gw.name,
        host: gw.baseUrl.replace(/^https?:\/\//, ''),
        website: gw.website,
        protocols: gw.tags.includes('anthropic-compatible') ? 'OpenAI · Anthropic' : 'OpenAI',
        pricing: gw.pricingUrl,
        probeModels: gw.probeModels,
        priceIdx: priceIndex(prices?.models, gw.id),
        trust: annoById[gw.id] ?? null,
        ...roll,
      };
    }),
    prices,
  };

  await writeFile(new URL('web/data.json', root), JSON.stringify(site, null, 2));
  console.log(`web/data.json: ${site.gateways.length} gateways, ${runs.length} runs, regions=${regions.join(',') || 'none'}`);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
