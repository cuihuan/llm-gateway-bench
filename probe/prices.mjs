#!/usr/bin/env node
// Price snapshot: pulls list prices for tracked models from public sources and
// writes data/prices.json. All amounts normalized to USD per 1M tokens [input, output].
//
// Sources (all public, no auth):
//   - official baseline: litellm model_prices_and_context_window.json
//   - synthorai:         GET https://synthorai.io/api/pricing
//   - openrouter:        GET https://openrouter.ai/api/v1/models
//
// On a source failure that source's column falls back to the previous
// committed snapshot (a partial outage never clobbers good data); a source
// that WAS fetched overwrites, even with null (model delisted there).
// Exits non-zero only if NO source could be fetched.

import { readFile, writeFile } from 'node:fs/promises';

const LITELLM_URL = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';

const round3 = (x) => (typeof x === 'number' && isFinite(x) ? Math.round(x * 1000) / 1000 : null);

/** litellm entry (per-token USD) → [inPerM, outPerM] or null */
export function fromLitellm(entry) {
  if (!entry || typeof entry.input_cost_per_token !== 'number' || typeof entry.output_cost_per_token !== 'number') return null;
  return [round3(entry.input_cost_per_token * 1e6), round3(entry.output_cost_per_token * 1e6)];
}

/** first matching litellm key wins */
export function officialPrice(litellmTable, keys) {
  for (const k of keys ?? []) {
    const p = fromLitellm(litellmTable?.[k]);
    if (p) return p;
  }
  return null;
}

/** synthorai /api/pricing rows (already USD/1M, may repeat per channel) → cheapest [in, out] */
export function cheapestSynthorai(rows, alias) {
  const hits = (rows ?? []).filter(
    (r) => r.model === alias && typeof r.input_per_m === 'number' && typeof r.output_per_m === 'number',
  );
  if (!hits.length) return null;
  const best = hits.reduce((a, b) => (a.input_per_m + a.output_per_m <= b.input_per_m + b.output_per_m ? a : b));
  return [round3(best.input_per_m), round3(best.output_per_m)];
}

/** openrouter model entry (per-token USD strings) → [inPerM, outPerM] */
export function fromOpenRouter(models, alias) {
  const m = (models ?? []).find((x) => x.id === alias);
  const p = Number(m?.pricing?.prompt);
  const c = Number(m?.pricing?.completion);
  if (!m || !isFinite(p) || !isFinite(c)) return null;
  return [round3(p * 1e6), round3(c * 1e6)];
}

async function fetchJson(url, headers = {}) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

async function tryFetch(label, fn) {
  try {
    const v = await fn();
    console.error(`[prices] ${label}: ok`);
    return v;
  } catch (e) {
    console.error(`[prices] ${label}: FAILED — ${e.message}`);
    return null;
  }
}

/**
 * Build per-model price rows. A null source (fetch failed) falls back to the
 * previous snapshot's value for that source's column; a non-null source wins
 * even when the model is missing from it (delisted ⇒ cell goes null).
 */
export function buildModels(tracked, { litellm, synthorai, openrouter }, prevModels) {
  const prevById = new Map((prevModels ?? []).map((m) => [m.model, m]));
  return tracked.map((t) => {
    const prev = prevById.get(t.id);
    return {
      model: t.id,
      official: litellm ? officialPrice(litellm, t.litellm) : prev?.official ?? null,
      cells: {
        synthorai: synthorai ? cheapestSynthorai(synthorai, t.aliases.synthorai) : prev?.cells?.synthorai ?? null,
        openrouter: openrouter ? fromOpenRouter(openrouter, t.aliases.openrouter) : prev?.cells?.openrouter ?? null,
      },
    };
  });
}

async function main() {
  const tracked = JSON.parse(await readFile(new URL('../data/tracked-models.json', import.meta.url), 'utf8'));
  const litellm = await tryFetch('litellm', () => fetchJson(LITELLM_URL));
  const synthorai = await tryFetch('synthorai', async () => (await fetchJson('https://synthorai.io/api/pricing')).data);
  const openrouter = await tryFetch('openrouter', async () => (await fetchJson('https://openrouter.ai/api/v1/models')).data);
  if (!litellm && !synthorai && !openrouter) {
    console.error('[prices] all sources failed, keeping existing snapshot');
    process.exit(1);
  }
  let prev = null;
  try { prev = JSON.parse(await readFile(new URL('../data/prices.json', import.meta.url), 'utf8')); } catch {}
  const models = buildModels(tracked, { litellm, synthorai, openrouter }, prev?.models);
  const out = {
    fetchedAt: new Date().toISOString(),
    unit: 'USD per 1M tokens [input, output]',
    sources: { official: 'litellm', synthorai: 'https://synthorai.io/api/pricing', openrouter: 'https://openrouter.ai/api/v1/models' },
    models,
  };
  const path = new URL('../data/prices.json', import.meta.url);
  await writeFile(path, JSON.stringify(out, null, 2));
  console.log('data/prices.json updated');
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
