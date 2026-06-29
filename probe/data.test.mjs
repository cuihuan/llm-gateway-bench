// Curated-data integrity checks — the benchmark's credibility rests on these files, and a single dirty
// entry can silently break a page or the aggregation. These tests guard the data as a contract in CI:
// structure, types, source links, uniqueness.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const readJson = (rel) => JSON.parse(readFileSync(new URL(rel, root), 'utf8'));
const isHttp = (s) => typeof s === 'string' && /^https?:\/\//.test(s);

test('data/gateways.json: shape, types, unique ids', () => {
  const gws = readJson('data/gateways.json');
  assert.ok(Array.isArray(gws) && gws.length > 0, 'gateways should be a non-empty array');
  const ids = new Set();
  for (const g of gws) {
    assert.ok(g.id && typeof g.id === 'string', `gateway missing id: ${JSON.stringify(g).slice(0,60)}`);
    assert.ok(!ids.has(g.id), `duplicate gateway id: ${g.id}`); ids.add(g.id);
    assert.ok(g.name, `${g.id} missing name`);
    assert.ok(isHttp(g.baseUrl), `${g.id} baseUrl should be http(s): ${g.baseUrl}`);
    assert.ok(g.authEnv && typeof g.authEnv === 'string', `${g.id} missing authEnv`);
    assert.ok(Array.isArray(g.probeModels), `${g.id} probeModels should be an array`);
  }
});

test('data/models.json: shape, non-negative prices, sourced benchmarks', () => {
  const doc = readJson('data/models.json');
  assert.ok(doc.unit && doc.asOf, 'missing unit/asOf');
  assert.ok(Array.isArray(doc.models) && doc.models.length > 0, 'models should be a non-empty array');
  const ids = new Set();
  // benchCols is the single source of truth for score keys; model score keys must come from it (avoid two hardcoded copies drifting)
  for (const c of doc.benchCols ?? []) assert.ok(c.key && c.label, 'benchCols entry missing key/label');
  for (const h of doc.benchHubs ?? []) assert.ok(isHttp(h.url) && h.label, 'benchHubs entry missing valid url/label');
  const scoreKeys = new Set((doc.benchCols ?? []).map((c) => c.key));
  const META = new Set(['src', 'srcUrl', 'asOf']);  // non-score fields allowed inside bench
  assert.ok(scoreKeys.size > 0, 'benchCols should not be empty');
  for (const m of doc.models) {
    assert.ok(m.id && m.name, `model missing id/name: ${JSON.stringify(m).slice(0,60)}`);
    assert.ok(!ids.has(m.id), `duplicate model id: ${m.id}`); ids.add(m.id);
    assert.equal(typeof m.input, 'number', `${m.id} input price should be a number`);
    assert.equal(typeof m.output, 'number', `${m.id} output price should be a number`);
    assert.ok(m.input >= 0 && m.output >= 0, `${m.id} price should not be negative`);
    assert.ok(m.source, `${m.id} missing source (every data point must be traceable)`);
    if (m.bench && m.bench !== null) {
      const hasScore = [...scoreKeys].some((k) => typeof m.bench[k] === 'number');
      assert.ok(hasScore, `${m.id} bench has no numeric score`);
      assert.ok(m.bench.src, `${m.id} bench missing src (never fabricated: every score must cite a source)`);
      assert.ok(isHttp(m.bench.srcUrl), `${m.id} bench.srcUrl should be an http(s) link`);
      assert.ok(m.bench.asOf, `${m.id} bench missing asOf date`);
      for (const [k, v] of Object.entries(m.bench)) {
        if (META.has(k)) continue;
        // Non-metadata fields must be score keys declared in benchCols, and 0-100 — catches typos/drift
        assert.ok(scoreKeys.has(k), `${m.id}.bench has unknown key "${k}" (not in benchCols, likely a typo)`);
        assert.ok(typeof v === 'number' && v >= 0 && v <= 100, `${m.id}.${k} score should be in 0-100`);
      }
    }
  }
});

test('data/annotations/*.json: shape, allowed enums, evidence is null-or-link', () => {
  const VERIFY = new Set(['pass', 'fail', 'pending', 'baseline', 'none']);
  const STATUS = new Set(['good', 'warn', 'bad', 'unknown']);
  const dir = new URL('data/annotations/', root);
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) {
    const a = JSON.parse(readFileSync(new URL(f, dir), 'utf8'));
    assert.ok(a.id, `${f} missing id`);
    assert.ok(a.channel && VERIFY.has(a.channel.verify), `${f} channel.verify invalid: ${a.channel?.verify}`);
    for (const key of ['promptRetention', 'training']) {
      const p = a[key];
      assert.ok(p && STATUS.has(p.status), `${f} ${key}.status invalid: ${p?.status}`);
      assert.ok(p.evidence === null || isHttp(p.evidence), `${f} ${key}.evidence should be null or an http link`);
    }
  }
});

test('referential integrity: every annotation id maps to a real gateway', () => {
  // aggregate matches via annoById[gateway.id] — a mistyped annotation id becomes dead data that never displays.
  const gwIds = new Set(readJson('data/gateways.json').map((g) => g.id));
  const dir = new URL('data/annotations/', root);
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) {
    const a = JSON.parse(readFileSync(new URL(f, dir), 'utf8'));
    assert.ok(gwIds.has(a.id), `annotation ${f} id "${a.id}" maps to no gateway (orphan annotation / typo)`);
  }
});

test('data/tracked-models.json: shape, unique ids, complete price aliases', () => {
  // Price fetching (prices.mjs) uses these aliases to pull prices from each source; a mistyped alias ⇒ that column silently becomes null.
  const tracked = readJson('data/tracked-models.json');
  assert.ok(Array.isArray(tracked) && tracked.length > 0, 'tracked-models should be a non-empty array');
  const ids = new Set();
  for (const t of tracked) {
    assert.ok(t.id && typeof t.id === 'string', `tracked missing id: ${JSON.stringify(t).slice(0, 60)}`);
    assert.ok(!ids.has(t.id), `duplicate tracked id: ${t.id}`); ids.add(t.id);
    assert.ok(Array.isArray(t.litellm) && t.litellm.length > 0 && t.litellm.every((k) => typeof k === 'string'),
      `${t.id} litellm should be a non-empty string array (litellm keys for the official baseline price)`);
    assert.ok(t.aliases && typeof t.aliases === 'object', `${t.id} missing aliases object`);
    for (const src of ['synthorai', 'openrouter']) {
      assert.ok(typeof t.aliases[src] === 'string' && t.aliases[src], `${t.id} aliases.${src} should be a non-empty string`);
    }
  }
});

test('data/prices.json: shape, sources, valid price cells, refs tracked models', () => {
  // The price matrix is a core gateway-level dimension; a dirty price tuple (NaN/negative/wrong shape) would break the page and priceIndex.
  const trackedIds = new Set(readJson('data/tracked-models.json').map((t) => t.id));
  const p = readJson('data/prices.json');
  assert.ok(p.unit && p.fetchedAt, 'prices missing unit/fetchedAt');
  assert.ok(p.sources && typeof p.sources === 'object', 'prices missing sources');
  for (const k of ['official', 'synthorai', 'openrouter']) assert.ok(p.sources[k], `prices.sources missing ${k}`);
  assert.ok(Array.isArray(p.models) && p.models.length > 0, 'prices.models should be a non-empty array');
  // Price tuple: null (missing price / not listed) or exactly [inputPrice, outputPrice], two non-negative numbers.
  const okCell = (c) => c === null || (Array.isArray(c) && c.length === 2 && c.every((n) => typeof n === 'number' && n >= 0));
  for (const m of p.models) {
    assert.ok(m.model && typeof m.model === 'string', `prices row missing model: ${JSON.stringify(m).slice(0, 60)}`);
    assert.ok(trackedIds.has(m.model), `prices row "${m.model}" not in tracked-models (orphan row / typo)`);
    assert.ok(okCell(m.official), `${m.model} official price tuple invalid: ${JSON.stringify(m.official)}`);
    assert.ok(m.cells && typeof m.cells === 'object', `${m.model} missing cells`);
    for (const [gw, cell] of Object.entries(m.cells)) {
      assert.ok(okCell(cell), `${m.model}.cells.${gw} price tuple invalid: ${JSON.stringify(cell)}`);
    }
  }
});
