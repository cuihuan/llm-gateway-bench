#!/usr/bin/env node
// Archive a locally generated report.json into web/reports/ and update the gallery index.json.
// This is the serverless form of "share to the report gallery" (data-as-repo): once archived, commit/open a PR to go live.
// A later Phase 4 will add a one-click upload endpoint on top of this.
//
// Usage:
//   node scripts/publish-report.mjs <report.json> [--id <slug>] [--source user|baseline]
//
// Security: before publishing, verify the report contains no key (sk-/Bearer/Authorization), otherwise refuse.

import { readFile, writeFile, mkdir } from 'node:fs/promises';

/** Refuse to publish if the report shows any key traces (privacy red-line fallback). Returns the matched pattern source or null. */
export function detectSecrets(reportText) {
  const pats = [/sk-[A-Za-z0-9]/, /Bearer\s+[A-Za-z0-9]/, /"?authorization"?\s*[:=]/i];
  const hit = pats.find((p) => p.test(reportText));
  return hit ? hit.source : null;
}

/** Build a gallery index entry (lightweight summary) from a report object + id. Pure function. */
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

/** Upsert an entry into the index (dedupe by id, newest report first). Pure function, easy to unit-test. */
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
  if (!file) { console.error('Usage: node scripts/publish-report.mjs <report.json> [--id <slug>] [--source user|baseline]'); process.exit(1); }

  const root = new URL('..', import.meta.url);
  const text = await readFile(file, 'utf8');
  const leak = detectSecrets(text);
  if (leak) { console.error(`[publish] report looks like it contains a key (matched /${leak}/), refusing to publish. Please check ${file}`); process.exit(1); }
  const report = JSON.parse(text);
  if (report.schema !== 'gwbench-report/1') { console.error(`[publish] not gwbench-report/1 (got ${report.schema})`); process.exit(1); }

  const id = flag('id') || slugify(`${report.model}-${(report.generatedAt || '').slice(0, 10)}`);
  const source = flag('source') || 'user';

  await mkdir(new URL('web/reports', root), { recursive: true });
  await writeFile(new URL(`web/reports/${id}.json`, root), JSON.stringify(report, null, 2));

  let index = null;
  try { index = JSON.parse(await readFile(new URL('web/reports/index.json', root), 'utf8')); } catch {}
  const next = upsertIndex(index, indexEntry(report, id, source), new Date().toISOString());
  await writeFile(new URL('web/reports/index.json', root), JSON.stringify(next, null, 2));
  console.log(`web/reports/${id}.json + index.json (${next.reports.length} reports total)`);
  console.log('Commit and push to go live on the report gallery.');
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
