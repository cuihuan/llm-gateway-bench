#!/usr/bin/env node
// gwbench compare — a self-serve comparison tool. Runs the full black-box probe suite for one logical
// model across "your own gateway" + OpenRouter + other registered gateways in a single pass, and
// produces a portable comparison report (report.json + report.html).
//
// The pain point: when wiring up a new gateway, there's no handy tool to compare side by side. This is
// that tool. Keys are read only from environment variables, never enter the report, never leave your
// machine (privacy red line, see docs/PRODUCT-SPEC.md §2A).
//
// Usage:
//   node probe/compare.mjs --model <trackedId> [options]
//
// Options:
//   --model <id>        Logical model (an id in data/tracked-models.json); the report is labeled with it
//   --url <baseUrl>     Add "your own gateway" to the comparison (OpenAI-compatible endpoint)
//   --alias <model>     With --url: the model's name on your gateway (defaults to --model)
//   --name <name>       With --url: the name shown in the report (defaults to host)
//   --auth-env <NAME>   With --url: name of the env var holding the key (default PROBE_KEY)
//   --with <id,id>      Registered gateways to compare (default: all that have an alias for this model and a key in env)
//   --price-in <usd>    With --url: input price for this model on your gateway (USD/1M), to include a self-built gateway in the price comparison
//   --price-out <usd>   With --url: output price for this model on your gateway (USD/1M)
//   --samples <n>       Sample count per target (default 3)
//   --no-baseline       Don't attach the 'public baseline reference' (attached by default, so you can get a rough read without others' keys)
//   --region <label>    Probe-perspective label written into the report (defaults to PROBE_REGION or 'local')
//   --out <path>        Report output prefix (default reports/<model>-<timestamp>), produces .json and .html
//   -h, --help          Show this help
//
// Example:
//   # My gateway vs OpenRouter vs AiHubMix, comparing gemini-2.5-flash
//   PROBE_KEY=sk-mine OPENROUTER_API_KEY=sk-or AIHUBMIX_API_KEY=sk-ah \
//   node probe/compare.mjs --model gemini-2.5-flash \
//     --url https://my-gateway.com --name "My Gateway" --with openrouter,aihubmix

import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { probeGateway } from './probe.mjs';
import { buildTarget, buildReport, renderReportHtml, buildBaselineRef } from './report.mjs';

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
  return `gwbench compare — benchmark one model across multiple gateways and produce a portable comparison report.

Usage:
  node probe/compare.mjs --model <trackedId> [--url <your gateway> --name <name> --auth-env <ENV>] [--with id,id] [--samples 3] [--out <prefix>]

Keys are read only from environment variables; they never enter the report or leave your machine. See the file header comment for all options.`;
}

/**
 * Resolve the list of comparison targets (pure function, easy to unit-test). Returns
 * [{ id, name, baseUrl, authEnv, alias, source }].
 * - ad-hoc: when --url is present, add a "your own gateway" target;
 * - registry: gateway ids given via --with (default: all gateways with an alias for this model in tracked),
 *   alias taken from tracked-models.json[model].aliases[gatewayId]; skipped (with a note) if no alias.
 * notes collects the reasons skipped targets were dropped, for the CLI to print.
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
    : Object.keys(aliases); // default: all gateways given an alias in tracked
  for (const id of candidateIds) {
    const gw = (gateways ?? []).find((g) => g.id === id);
    if (!gw) { notes.push(`unknown gateway '${id}' (not in data/gateways.json)`); continue; }
    const alias = aliases[id];
    if (!alias) { notes.push(`'${id}' has no alias for '${model}' (data/tracked-models.json)`); continue; }
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
  if (!model) { console.error('[compare] --model <trackedId> is required. See --help.'); process.exit(1); }

  const root = new URL('..', import.meta.url);
  const gateways = JSON.parse(await readFile(new URL('data/gateways.json', root), 'utf8'));
  const tracked = JSON.parse(await readFile(new URL('data/tracked-models.json', root), 'utf8'));
  const version = JSON.parse(await readFile(new URL('package.json', root), 'utf8')).version;
  // Price snapshot (optional): adds 'price + multiplier' columns to the comparison report. A missing file doesn't affect other dimensions.
  let prices = null;
  try { prices = JSON.parse(await readFile(new URL('data/prices.json', root), 'utf8')); } catch {}
  const priceRow = prices?.models?.find((p) => p.model === model) ?? null;
  const official = Array.isArray(priceRow?.official) ? priceRow.official : null;
  const adhocPriceIn = flag('price-in') != null ? Number(flag('price-in')) : null;
  const adhocPriceOut = flag('price-out') != null ? Number(flag('price-out')) : null;
  const adhocPrice = Number.isFinite(adhocPriceIn) && Number.isFinite(adhocPriceOut) ? [adhocPriceIn, adhocPriceOut] : null;
  // Resolve a target's gateway price [in, out]: registry takes the matching gateway column from prices.json; ad-hoc takes --price-in/out.
  const priceFor = (t) => (t.source === 'adhoc' ? adhocPrice : (Array.isArray(priceRow?.cells?.[t.id]) ? priceRow.cells[t.id] : null));

  const adhoc = flag('url') ? { url: flag('url'), alias: flag('alias'), name: flag('name'), authEnv: flag('auth-env') } : null;
  const withIds = flag('with') ? String(flag('with')).split(',').map((s) => s.trim()).filter(Boolean) : null;
  const { targets, notes } = resolveTargets({ model, adhoc, withIds, gateways, tracked });
  for (const n of notes) console.error(`[skip] ${n}`);
  if (!targets.length) { console.error('[compare] no targets to compare. Check --model / --with / --url.'); process.exit(1); }

  const samples = Number(flag('samples', 3));
  const region = flag('region') || process.env.PROBE_REGION || 'local';
  const startedAt = new Date().toISOString();
  const probed = [];
  for (const t of targets) {
    const key = process.env[t.authEnv];
    if (!key) { console.error(`[skip] ${t.name}: env var ${t.authEnv} not set`); continue; }
    const gw = { id: t.id, name: t.name, baseUrl: t.baseUrl, authEnv: t.authEnv, probeModels: [t.alias], tags: [] };
    const { connectivity, models } = await probeGateway(gw, key, { samples });
    probed.push(buildTarget({ name: t.name, host: host(t.baseUrl), connectivity, models, price: priceFor(t), official }));
  }
  if (!probed.length) { console.error('[compare] all targets were skipped for missing keys — no report produced.'); process.exit(1); }

  // Public baseline reference (attached by default, disabled with --no-baseline): get a rough read even without others' keys.
  let baseline = null;
  if (!args.includes('--no-baseline')) {
    try { baseline = buildBaselineRef(JSON.parse(await readFile(new URL('web/data.json', root), 'utf8'))); } catch {}
  }

  // "Your gateway" = the ad-hoc (--url) target; the gap check uses it as the protagonist against the best gateway.
  const mine = adhoc ? (probed.find((p) => p.host === host(adhoc.url))?.name ?? null) : null;
  const report = buildReport({
    model, region, samplesPerTarget: samples, version, baseline, mine,
    generatedAt: new Date().toISOString(), targets: probed,
  });

  const out = flag('out') || `reports/${model}-${tsStamp(startedAt)}`;
  const dir = out.includes('/') ? out.slice(0, out.lastIndexOf('/')) : '.';
  await mkdir(new URL(dir, root), { recursive: true });
  await writeFile(new URL(`${out}.json`, root), JSON.stringify(report, null, 2));
  await writeFile(new URL(`${out}.html`, root), renderReportHtml(report));
  const cmp = report.comparison;
  if (report.gap) console.error(`[gap] ${report.gap.mine} vs best: ${report.gap.summary}`);
  console.error(`[compare] ${probed.length} targets · fastest ${cmp.fastestTtft ?? '—'} · highest throughput ${cmp.highestThroughput ?? '—'} · cheapest ${cmp.cheapest ?? '—'} · flags ${cmp.flags.length}`);
  console.log(`${out}.html`);
  console.log(`${out}.json`);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
