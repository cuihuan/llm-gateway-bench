#!/usr/bin/env node
// gwbench matrix — classic models × gateways comparison (the platform's flagship report type).
// For each classic model (data/tracked-models.json, with aliases deciding which gateways carry it),
// run the full black-box suite on every gateway that has a key, and produce a "this model's measured
// performance across gateways" report, published straight to the report gallery (web/reports/). This
// is the user's top priority: "a few classic models, their test results across different gateways".
// The maintainer runs it in CI (which has each gateway's key); the reports refresh on the 6h cron.
//
// Usage:
//   node probe/matrix.mjs [--models a,b] [--samples 3] [--min 2] [--region gh-us]
//
// Keys are read only from environment variables, never enter the report. A model needs data on at
// least --min (default 2) gateways to generate a report — avoiding a meaningless "comparison" with
// only one gateway.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolveTargets } from './compare.mjs';
import { probeGateway } from './probe.mjs';
import { buildTarget, buildReport } from './report.mjs';

const args = process.argv.slice(2);
const flag = (name, fallback = null) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
const host = (url) => String(url).replace(/^https?:\/\//, '').replace(/\/+$/, '');

/** Model id → filename-safe slug (pure function). */
export function matrixSlug(model) {
  return `matrix-${String(model ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'model'}`;
}

/** Merge the gallery index (pure function): swap out all matrix-* entries for a fresh batch, keeping
 *  demo / user reports. matrix reports are recomputed each time, so they're replaced wholesale by
 *  prefix rather than upserted one by one. */
export function mergeMatrixIndex(index, matrixEntries, updatedAt) {
  const base = index && Array.isArray(index.reports) ? index.reports : [];
  const kept = base.filter((r) => !String(r.id).startsWith('matrix-'));
  return {
    schema: index?.schema ?? 'gwbench-reports-index/1',
    updatedAt: updatedAt ?? index?.updatedAt ?? null,
    reports: [...matrixEntries, ...kept],
  };
}

/** Build a gallery index entry from a report object (pure function). */
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
    console.log('gwbench matrix — classic models × gateways comparison, published to web/reports/. See the file header comment.');
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
      if (!key) { console.error(`[skip] ${model} @ ${t.name}: missing ${t.authEnv}`); continue; }
      const gw = { id: t.id, name: t.name, baseUrl: t.baseUrl, authEnv: t.authEnv, probeModels: [t.alias], tags: [] };
      const { connectivity, models: ms } = await probeGateway(gw, key, { samples });
      const price = Array.isArray(priceRow?.cells?.[t.id]) ? priceRow.cells[t.id] : null;
      probed.push(buildTarget({ name: t.name, host: host(t.baseUrl), connectivity, models: ms, price, official }));
    }
    if (probed.length < minGw) { console.error(`[matrix] ${model}: only ${probed.length} gateways have data (<${minGw}), skipping`); continue; }

    const report = buildReport({ model, region, samplesPerTarget: samples, version, generatedAt: new Date().toISOString(), targets: probed });
    report.kind = 'compare';
    report.source = 'baseline';
    report.title = `${model} · benchmarked across ${probed.length} gateways`;
    const id = matrixSlug(model);
    await mkdir(new URL('web/reports', root), { recursive: true });
    await writeFile(new URL(`web/reports/${id}.json`, root), JSON.stringify(report, null, 2));
    entries.push(matrixIndexEntry(report, id));
    console.error(`[matrix] ${model}: ${probed.length} gateways → web/reports/${id}.json · fastest ${report.comparison.fastestTtft ?? '—'} · cheapest ${report.comparison.cheapest ?? '—'}`);
  }

  if (!entries.length) { console.error('[matrix] no model reached the min gateway count — gallery not updated (most likely only one key available)'); return; }
  let index = null;
  try { index = JSON.parse(await readFile(new URL('web/reports/index.json', root), 'utf8')); } catch {}
  const next = mergeMatrixIndex(index, entries, startedAt);
  await writeFile(new URL('web/reports/index.json', root), JSON.stringify(next, null, 2));
  console.log(`web/reports/index.json: ${entries.length} matrix reports, ${next.reports.length} total`);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
