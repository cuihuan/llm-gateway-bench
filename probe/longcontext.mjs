#!/usr/bin/env node
// gwbench longcontext — a long-context retention benchmark. Runs needle-in-haystack across multiple
// context lengths × multiple embed depths: embed a unique marker and require it read back verbatim.
// If a gateway silently truncates long context to save upstream cost, the marker is deterministically
// lost above some length — this 'length × depth' pass/fail heatmap surfaces the truncation boundary.
// Produces a kind=longcontext gwbench-report/1, reusing the report gallery.
//
// Usage:
//   node probe/longcontext.mjs --model <trackedId> [--url <your gateway> ...] [--with id,id]
//        [--lengths 4000,16000,64000] [--depths 10,50,90] [--out <prefix>]
//
// Keys are read only from environment variables, never enter the report (privacy red line, same as
// compare). Long-context requests are pricey — defaults to 1 shot per cell; tune the length tiers
// yourself (a single model at 128K can run $0.4–1.2/run).

import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolveTargets } from './compare.mjs';
import { evalNeedle } from './metrics.mjs';
import { REPORT_SCHEMA } from './report.mjs';

const args = process.argv.slice(2);
const flag = (name, fallback = null) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
const host = (url) => String(url).replace(/^https?:\/\//, '').replace(/\/+$/, '');
const TIMEOUT_MS = 120_000;

/** Build a needle haystack (pure function): roughly approxTokens of filler, with the needle embedded
 *  at depthFraction. About 11 tokens per line. Returns { content, lines, markerAt }. */
export function buildHaystack(approxTokens, depthFraction, needle) {
  const TOK_PER_LINE = 11;
  const lines = Math.max(8, Math.round(approxTokens / TOK_PER_LINE));
  const filler = Array.from({ length: lines }, (_, i) => `Line ${i + 1}: the quick brown fox jumps over the lazy dog repeatedly.`);
  const at = Math.min(lines, Math.max(0, Math.round(lines * depthFraction)));
  filler.splice(at, 0, `IMPORTANT MARKER — remember this exact code: ${needle}`);
  const content = `${filler.join('\n')}\n\nQuestion: what is the exact code in the IMPORTANT MARKER line above? Reply with only the code.`;
  return { content, lines, markerAt: at };
}

/** Summarize one target's cell results (pure function): the length tiers tested (ascending) + the
 *  reliable length cap (the largest length where all depths pass). */
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
    else break; // once a length tier has a failure, longer ones no longer count as "reliable"
  }
  return { lengthsTested, maxReliableLen };
}

/** Build a report target from one target's raw cells (pure function, no secrets). */
export function buildLongContextTarget({ name, host: h, cells, error = null }) {
  return { name: name ?? '?', host: h ?? null, grid: cells ?? [], ...summarizeGrid(cells), error };
}

/** Cross-target comparison (pure function): the most reliable context + the list of targets that truncated. */
export function buildLongContextComparison(targets) {
  const list = Array.isArray(targets) ? targets : [];
  const withLen = list.filter((t) => typeof t.maxReliableLen === 'number');
  const bestContext = withLen.length
    ? withLen.reduce((a, b) => (b.maxReliableLen > a.maxReliableLen ? b : a)).name : null;
  const truncators = list.filter((t) => (t.grid ?? []).some((c) => c.ok === false)).map((t) => t.name);
  return { bestContext, truncators };
}

/** Assemble the full longcontext report (pure function). generatedAt/version injected for unit testing. */
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
    console.log('gwbench longcontext — multi-length × multi-depth needle truncation benchmark. See the file header comment.');
    return;
  }
  const model = flag('model');
  if (!model) { console.error('[longcontext] --model <trackedId> is required'); process.exit(1); }
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
  if (!targets.length) { console.error('[longcontext] no targets to test'); process.exit(1); }

  const region = flag('region') || process.env.PROBE_REGION || 'local';
  const startedAt = new Date().toISOString();
  const built = [];
  for (const t of targets) {
    const key = process.env[t.authEnv];
    if (!key) { console.error(`[skip] ${t.name}: env var ${t.authEnv} not set`); continue; }
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
  if (!built.length) { console.error('[longcontext] all targets missing keys, no report produced'); process.exit(1); }

  const report = buildLongContextReport({ model, region, lengths, depths, version, generatedAt: new Date().toISOString(), targets: built });
  const out = flag('out') || `reports/longcontext-${model}-${tsStamp(startedAt)}`;
  const dir = out.includes('/') ? out.slice(0, out.lastIndexOf('/')) : '.';
  await mkdir(new URL(dir, root), { recursive: true });
  const { renderReportHtml } = await import('./report.mjs');
  await writeFile(new URL(`${out}.json`, root), JSON.stringify(report, null, 2));
  await writeFile(new URL(`${out}.html`, root), renderReportHtml(report));
  console.error(`[longcontext] most reliable context ${report.comparison.bestContext ?? '—'} · truncation seen ${report.comparison.truncators.join('/') || 'none'}`);
  console.log(`${out}.html`);
  console.log(`${out}.json`);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
