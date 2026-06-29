// Pure builder functions for the portable comparison report (no I/O, fully unit-testable).
// After compare.mjs runs the raw probes for each target, this module compacts them into
// the report contract (docs/PRODUCT-SPEC.md §4 schema gwbench-report/1), computes the
// objective comparison, and renders a self-contained HTML report. **It NEVER touches
// key / Authorization / baseUrl** — the input only carries host, and the report only
// keeps host (privacy red line).

export const REPORT_SCHEMA = 'gwbench-report/1';

/** Compact one gateway's raw probe result (output of probeGateway) into a report target.
 *  raw: { name, host, connMs?, region?, connectivity?, models:[{...summary, toolCall, cjk, needle}] }
 *  Takes only the first probed model (compare probes exactly one logical model per target). */
/** Price multiplier = mean(gateway input price / official input price, gateway output price / official output price).
 *  Missing either price → null. Same convention as the leaderboard priceIndex (docs/methodology.md),
 *  so self-tests align with the public baseline. */
export function priceIdxFor(price, official) {
  if (!Array.isArray(price) || !Array.isArray(official)) return null;
  const [pi, po] = price, [oi, oo] = official;
  if (![pi, po, oi, oo].every((x) => typeof x === 'number') || oi <= 0 || oo <= 0) return null;
  return Math.round(((pi / oi + po / oo) / 2) * 100) / 100;
}

export function buildTarget(raw) {
  const m = raw?.models?.[0] ?? null;
  const connMs = raw?.connMs ?? raw?.connectivity?.latencyMs ?? null;
  // Price [in, out] USD/1M: registry targets take the matching gateway column from prices.json;
  // ad-hoc targets can supply it via --price-in/--price-out. `official` is the official list-price
  // baseline. Missing → null (never fabricated).
  const price = Array.isArray(raw?.price) ? raw.price : null;
  const official = Array.isArray(raw?.official) ? raw.official : null;
  const priceIdx = priceIdxFor(price, official);
  if (!m) {
    return {
      name: raw?.name ?? '?', host: raw?.host ?? null, connMs,
      ttftMs: { p50: null, p95: null }, tokensPerSec: null, successRate: null,
      toolCall: null, burstStream: null, modelEcho: null, cjk: null, needle: null, cache: null,
      usage: null, price, priceIdx, error: raw?.error ?? 'no model probed',
    };
  }
  const failed = m.success === 0;
  return {
    name: raw.name ?? '?',
    host: raw.host ?? null,
    connMs,
    ttftMs: { p50: m.ttftMs?.p50 ?? null, p95: m.ttftMs?.p95 ?? null },
    tokensPerSec: m.tokensPerSec?.avg ?? null,
    successRate: m.successRate ?? null,
    // Tri-state: true = passed / false = raises a red flag / null = no judgeable data
    toolCall: m.toolCall ? m.toolCall.ok === true : null,
    burstStream: m.burstStreamRate == null ? null : m.burstStreamRate >= 0.5,
    modelEcho: m.modelEchoRate == null ? null : m.modelEchoRate === 1,
    cjk: m.cjk ? m.cjk.ok === true : null,
    needle: m.needle ? m.needle.ok === true : null,
    // Prompt cache: true = hit / false = unsupported / null = not reported or not tested
    cache: m.cache ? (m.cache.supported ?? null) : null,
    usage: m.usage ?? null,
    price,
    priceIdx,
    error: failed ? (m.errors?.[0] ?? 'all samples failed') : null,
  };
}

/** Severity per red flag: substitution is hard evidence (alert), the rest are warn. */
const FLAG_SPEC = [
  { key: 'modelEcho', when: (t) => t.modelEcho === false, severity: 'alert', label: 'Model echo mismatch (suspected substitution)' },
  { key: 'burstStream', when: (t) => t.burstStream === true, severity: 'warn', label: 'Suspected fake streaming (buffered then dumped)' },
  { key: 'needle', when: (t) => t.needle === false, severity: 'warn', label: 'Long-context needle lost (suspected context truncation)' },
  { key: 'cjk', when: (t) => t.cjk === false, severity: 'warn', label: 'CJK output corrupted (suspected quantization degradation)' },
  { key: 'toolCall', when: (t) => t.toolCall === false, severity: 'warn', label: 'Tool calling stripped' },
  // Suspiciously cheap (<0.5× official) is usually a reverse channel — read it alongside the
  // trust rating (price index in docs/methodology.md).
  { key: 'cheapPrice', when: (t) => typeof t.priceIdx === 'number' && t.priceIdx < 0.5, severity: 'warn', label: 'Abnormally low price (<0.5× official, suspected reverse channel)' },
  { key: 'error', when: (t) => t.error != null, severity: 'alert', label: 'Probe failed' },
];

const priceSum = (t) => (Array.isArray(t.price) && typeof t.price[0] === 'number' && typeof t.price[1] === 'number' ? t.price[0] + t.price[1] : null);

/** Objective comparison: who is fastest / highest throughput / cheapest, plus the red flags each
 *  target raises. No black-box weighted total score. */
export function buildComparison(targets) {
  const list = Array.isArray(targets) ? targets : [];
  const withTtft = list.filter((t) => typeof t.ttftMs?.p50 === 'number' && t.successRate > 0);
  const withTps = list.filter((t) => typeof t.tokensPerSec === 'number' && t.successRate > 0);
  const withPrice = list.filter((t) => priceSum(t) != null);
  const minBy = (arr, f) => (arr.length ? arr.reduce((a, b) => (f(b) < f(a) ? b : a)).name : null);
  const maxBy = (arr, f) => (arr.length ? arr.reduce((a, b) => (f(b) > f(a) ? b : a)).name : null);
  const flags = [];
  for (const t of list) {
    for (const spec of FLAG_SPEC) {
      if (spec.when(t)) flags.push({ target: t.name, flag: spec.key, severity: spec.severity, label: spec.label });
    }
  }
  return {
    fastestTtft: minBy(withTtft, (t) => t.ttftMs.p50),
    highestThroughput: maxBy(withTps, (t) => t.tokensPerSec),
    cheapest: minBy(withPrice, (t) => priceSum(t)),
    flags,
  };
}

/** Extract the public baseline reference (pure function) from the aggregated site data
 *  (web/data.json): each gateway's continuously probed 30d success rate / typical TTFT /
 *  price index / last run. This lets a self-test get a rough read even without anyone
 *  else's keys. Note: gateway-level, cross-model aggregate, by each one's probe region —
 *  reference only, not from this run. */
export function buildBaselineRef(siteData) {
  const gws = Array.isArray(siteData?.gateways) ? siteData.gateways : [];
  return gws
    .filter((g) => g.uptimePct != null || g.speed?.ttftP50 != null || g.priceIdx != null)
    .map((g) => ({
      name: g.name, host: g.host ?? null,
      uptimePct: g.uptimePct ?? null,
      ttftP50: g.speed?.ttftP50 ?? null,
      tps: g.speed?.tps ?? null,
      priceIdx: g.priceIdx ?? null,
      region: g.region ?? null,
      lastRun: g.lastRun ?? null,
    }))
    .sort((a, b) => (b.uptimePct ?? -1) - (a.uptimePct ?? -1));
}

/** Build a 'classic models × gateways price comparison' report (pure function) from the public
 *  pricing snapshot (data/prices.json). Prices come from public pricing APIs (official litellm /
 *  synthorai / openrouter), so **no key is needed** — this comparison is real data and can ship
 *  immediately. Each model marks the cheapest gateway. */
export function buildPriceMatrixReport(prices, { gateways = [], region = 'Public pricing API', generatedAt, version = '0.0.0' } = {}) {
  const gwName = new Map((gateways ?? []).map((g) => [g.id, g.name]));
  const models = Array.isArray(prices?.models) ? prices.models : [];
  const ids = [...new Set(models.flatMap((m) => Object.keys(m.cells ?? {})))];
  const rows = models.map((m) => {
    const cells = {};
    let cheapest = null, cheapestSum = Infinity;
    for (const [id, cell] of Object.entries(m.cells ?? {})) {
      if (!Array.isArray(cell) || typeof cell[0] !== 'number') { cells[id] = null; continue; }
      cells[id] = { price: cell, idx: priceIdxFor(cell, m.official ?? null) };
      const sum = cell[0] + cell[1];
      if (sum < cheapestSum) { cheapestSum = sum; cheapest = id; }
    }
    return { model: m.model, official: Array.isArray(m.official) ? m.official : null, cells, cheapest };
  });
  return {
    schema: REPORT_SCHEMA, kind: 'pricematrix',
    generatedAt: generatedAt ?? null, tool: { name: 'gwbench', version },
    model: null, region,
    fetchedAt: prices?.fetchedAt ?? null, sources: prices?.sources ?? null,
    gateways: ids.map((id) => ({ id, name: gwName.get(id) ?? id })),
    rows,
  };
}

const r2 = (x) => (typeof x === 'number' ? Math.round(x * 100) / 100 : null);
const r1 = (x) => (typeof x === 'number' ? Math.round(x * 10) / 10 : null);

/**
 * Gap check (core): benchmark "your gateway" (mineName) dimension by dimension against "the best
 * gateway". Each dimension's candidates come from this run's targets + the public baseline reference
 * (speed/stability); best = the extreme among candidates (including you, so either you're best, or
 * you're behind the best by X%). Returns { mine, dims[], integrity, summary }.
 * This is the first answer the user wants: where am I behind, and by how much.
 */
export function buildGap(targets, baseline, mineName) {
  const list = Array.isArray(targets) ? targets : [];
  const base = Array.isArray(baseline) ? baseline : [];
  const mine = list.find((t) => t.name === mineName);
  if (!mine) return null;

  const cand = (arr, pick) => arr.map(pick).filter((c) => c && typeof c.v === 'number');
  const ttftC = [...cand(list.filter((t) => t.successRate > 0), (t) => ({ name: t.name, v: t.ttftMs?.p50 })), ...cand(base, (b) => ({ name: b.name, v: b.ttftP50 }))];
  const tpsC = [...cand(list.filter((t) => t.successRate > 0), (t) => ({ name: t.name, v: t.tokensPerSec })), ...cand(base, (b) => ({ name: b.name, v: b.tps }))];
  const upC = [...cand(list, (t) => ({ name: t.name, v: typeof t.successRate === 'number' ? t.successRate * 100 : null })), ...cand(base, (b) => ({ name: b.name, v: b.uptimePct }))];
  // Price is benchmarked by multiplier (÷ official price), anchoring "official price 1.0×" as a
  // candidate — so even when only your own gateway is probed, you can still see "how much pricier
  // you are than official / than the best", instead of crowning yourself in isolation.
  const idxAll = [
    ...cand(list, (t) => ({ name: t.name, v: typeof t.priceIdx === 'number' ? t.priceIdx : null })),
    ...cand(base, (b) => ({ name: b.name, v: typeof b.priceIdx === 'number' ? b.priceIdx : null })),
    { name: 'official price', v: 1 },
  ];
  // Price "best" excludes suspected reverse channels below 0.5× (don't use pirated pricing as the
  // benchmark, or every legitimate gateway looks expensive).
  const idxLegit = idxAll.filter((c) => c.v >= 0.5);
  const idxC = idxLegit.length ? idxLegit : idxAll;

  const mineV = {
    price: typeof mine.priceIdx === 'number' ? mine.priceIdx : null,
    ttft: typeof mine.ttftMs?.p50 === 'number' ? mine.ttftMs.p50 : null,
    tps: typeof mine.tokensPerSec === 'number' ? mine.tokensPerSec : null,
    uptime: typeof mine.successRate === 'number' ? mine.successRate * 100 : null,
  };

  const mk = (key, label, lower, unit, v, cands) => {
    if (v == null || !cands.length) return null;
    const best = cands.reduce((a, b) => (lower ? (b.v < a.v ? b : a) : (b.v > a.v ? b : a)));
    const isBest = lower ? v <= best.v + 1e-9 : v >= best.v - 1e-9;
    const behindPct = isBest ? 0 : (lower ? (v - best.v) / best.v : (best.v - v) / best.v) * 100;
    const verdict = isBest ? 'best' : (behindPct < 8 ? 'even' : 'behind');
    return { key, label, unit, lower, yours: r2(v), best: r2(best.v), bestName: best.name, behindPct: r1(behindPct), verdict };
  };

  const dims = [
    mk('price', 'Price', true, '×', mineV.price, idxC),
    mk('ttft', 'TTFT', true, ' ms', mineV.ttft, ttftC),
    mk('tps', 'Throughput', false, ' tok/s', mineV.tps, tpsC),
    mk('uptime', 'Stability', false, '%', mineV.uptime, upC),
  ].filter(Boolean);

  const failed = [];
  if (mine.modelEcho === false) failed.push('model echo');
  if (mine.cjk === false) failed.push('CJK');
  if (mine.needle === false) failed.push('long context');
  if (mine.toolCall === false) failed.push('tool calling');
  if (mine.burstStream === true) failed.push('real streaming');
  const integrity = failed.length ? { ok: false, failed } : { ok: true };

  const cache = { mine: mine.cache ?? null, anySupported: list.some((t) => t.cache === true) };
  const parts = dims.map((d) => (d.verdict === 'best' ? `${d.label} best` : d.verdict === 'even' ? `${d.label} even` : `${d.label} behind ${d.behindPct}%`));
  parts.push(integrity.ok ? 'all fingerprints pass' : `fingerprints failed: ${failed.join('/')}`);
  if (cache.mine === true) parts.push('cache hit'); else if (cache.mine === false) parts.push('no cache');
  return { mine: mineName, dims, integrity, cache, summary: parts.join(' · ') };
}

/** Assemble the full report object (report.json). generatedAt/version are injected by the caller
 *  for unit testing. When baseline is non-empty, attach the 'public baseline reference'; when mine
 *  is given, attach the 'gap check' (you vs the best). */
export function buildReport({ kind = 'compare', model, region = null, samplesPerTarget = null, targets, baseline = null, mine = null, generatedAt, version = '0.0.0' }) {
  const t = Array.isArray(targets) ? targets : [];
  const out = {
    schema: REPORT_SCHEMA,
    kind,
    generatedAt: generatedAt ?? null,
    tool: { name: 'gwbench', version },
    model: model ?? null,
    region,
    samplesPerTarget,
    targets: t,
    comparison: buildComparison(t),
  };
  if (Array.isArray(baseline) && baseline.length) out.baseline = baseline;
  if (mine) {
    const gap = buildGap(t, baseline, mine);
    if (gap) { out.mine = mine; out.gap = gap; }
  }
  return out;
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = (v, suffix = '') => (typeof v === 'number' ? `${v}${suffix}` : '—');
const tri = (v) => (v === true ? '<span class="ok">✓</span>' : v === false ? '<span class="bad">✗</span>' : '<span class="na">—</span>');
const fmtLen = (n) => (typeof n === 'number' ? (n >= 1000 ? `${+(n / 1000).toFixed(n % 1000 ? 1 : 0)}K` : String(n)) : '—');

/** Render a self-contained HTML report: embedded data + inline styles, opens directly via file://,
 *  shareable. Pure string building, no I/O. The only target info that appears in the report is host
 *  (no key/baseUrl). */
export function renderReportHtml(report) {
  const r = report ?? {};
  const targets = Array.isArray(r.targets) ? r.targets : [];
  const isLC = r.kind === 'longcontext';
  const isPM = r.kind === 'pricematrix';
  const cmp = r.comparison ?? (isLC || isPM ? {} : buildComparison(targets));
  const title = isPM ? 'Classic models × gateways · Price comparison' : isLC ? 'Long-context retention report' : 'Gateway comparison report';

  // —— Side-by-side comparison (compare) body ——
  const compareBody = () => {
    const priceCell = (t) => (Array.isArray(t.price) && typeof t.price[0] === 'number' ? `${t.price[0]}/${t.price[1]}` : '—');
    const idxCell = (t) => (typeof t.priceIdx === 'number'
      ? `<span class="${t.priceIdx < 1 ? 'ok' : t.priceIdx > 1 ? 'bad' : ''}">${t.priceIdx}×</span>` : '—');
    const rows = targets.map((t) => `      <tr>
        <td class="name">${esc(t.name)}${t.host ? `<span class="host">${esc(t.host)}</span>` : ''}</td>
        <td class="r">${num(t.ttftMs?.p50, ' ms')}</td>
        <td class="r">${num(t.ttftMs?.p95, ' ms')}</td>
        <td class="r">${num(t.tokensPerSec, '')}</td>
        <td class="r">${typeof t.successRate === 'number' ? Math.round(t.successRate * 100) + '%' : '—'}</td>
        <td class="r">${priceCell(t)}</td>
        <td class="r">${idxCell(t)}</td>
        <td class="c">${tri(t.modelEcho)}</td>
        <td class="c">${tri(t.toolCall)}</td>
        <td class="c">${t.burstStream == null ? '<span class="na">—</span>' : tri(!t.burstStream)}</td>
        <td class="c">${tri(t.cjk)}</td>
        <td class="c">${tri(t.needle)}</td>
        <td class="c">${tri(t.cache)}</td>
        <td class="r">${num(t.usage?.charsPerToken, '')}</td>
      </tr>`).join('\n');
    const flags = (cmp.flags ?? []).map((f) => `<li class="flag ${esc(f.severity)}"><b>${esc(f.target)}</b> · ${esc(f.label)}</li>`).join('\n');
    const winners = [
      cmp.fastestTtft ? `Fastest TTFT: <b>${esc(cmp.fastestTtft)}</b>` : null,
      cmp.highestThroughput ? `Highest throughput: <b>${esc(cmp.highestThroughput)}</b>` : null,
      cmp.cheapest ? `Cheapest: <b>${esc(cmp.cheapest)}</b>` : null,
    ].filter(Boolean).join(' · ') || '(not enough successful samples to decide)';
    const g = r.gap;
    const gapCard = g ? `  <div class="gap">
    <div class="gap-h">Gap check · your gateway <b>${esc(g.mine)}</b> vs the best gateway</div>
    <div class="gap-sum">${esc(g.summary)}</div>
    <div class="gap-grid">
${g.dims.map((d) => `      <div class="gap-cell ${d.verdict === 'behind' ? 'bad' : d.verdict === 'best' ? 'ok' : ''}">
        <div class="gd-label">${esc(d.label)}</div>
        <div class="gd-v">you ${d.yours}${esc(d.unit)}</div>
        <div class="gd-b">best ${d.best}${esc(d.unit)} · ${esc(d.bestName)}</div>
        <div class="gd-verdict">${d.verdict === 'best' ? '🏆 best' : d.verdict === 'even' ? '≈ even' : '▼ behind ' + d.behindPct + '%'}</div>
      </div>`).join('\n')}
    </div>
    <div class="gap-int ${g.integrity.ok ? 'ok' : 'bad'}">${g.integrity.ok ? '✓ all compliance fingerprints pass' : '✗ fingerprints failed: ' + esc(g.integrity.failed.join(', '))}</div>
    ${g.cache ? `<div class="gap-int ${g.cache.mine === true ? 'ok' : g.cache.mine === false ? 'bad' : ''}">${g.cache.mine === true ? '✓ Prompt cache hit (repeated prompts cost less)' : g.cache.mine === false ? ('✗ No prompt cache hit' + (g.cache.anySupported ? ' (some gateways support it, this one does not)' : '')) : '— Prompt cache not tested / gateway does not report'}</div>` : ''}
    <p class="sub" style="margin:10px 0 0">Price is the measured comparison for this model; the "best" for speed/stability includes the public baseline (gateway-level aggregate) reference. |gap| &lt;8% counts as even.</p>
  </div>
` : '';
    const body = gapCard + `  <table><thead><tr>
    <th>Target</th><th class="r">TTFT P50</th><th class="r">TTFT P95</th><th class="r">tok/s</th><th class="r">Success</th>
    <th class="r">Price in/out</th><th class="r">Multiplier</th>
    <th class="c">Model echo</th><th class="c">Tool calling</th><th class="c">Real streaming</th><th class="c">CJK</th><th class="c">Long context</th><th class="c">Cache</th><th class="r">Chars/token</th>
  </tr></thead><tbody>
${rows}
  </tbody></table>
  <p class="sub" style="margin:8px 0 0">Price = USD/1M tokens (input/output) · Multiplier = gateway price ÷ official price (<span class="ok">&lt;1×</span> cheaper than official, <span class="bad">&gt;1×</span> more expensive; &lt;0.5× is usually a reverse channel, read alongside the behavior fingerprints).</p>
  ${flags ? `<ul class="flags">\n${flags}\n</ul>` : '<p class="sub" style="margin-top:18px">No red flags raised.</p>'}`;
    const baseRows = (r.baseline ?? []).map((b) => `      <tr>
        <td class="name">${esc(b.name)}${b.host ? `<span class="host">${esc(b.host)}</span>` : ''}</td>
        <td class="r">${b.uptimePct != null ? b.uptimePct + '%' : '—'}</td>
        <td class="r">${num(b.ttftP50, ' ms')}</td>
        <td class="r">${b.priceIdx != null ? b.priceIdx + '×' : '—'}</td>
        <td class="r">${esc(b.region ?? '—')}</td>
      </tr>`).join('\n');
    const baseSection = baseRows ? `
  <h3 class="tname" style="margin-top:26px">Public baseline reference <span class="rel">continuous probing · gateway-level cross-model aggregate · reference only, not from this run</span></h3>
  <table><thead><tr><th>Gateway</th><th class="r">30D success</th><th class="r">Typical TTFT</th><th class="r">Price index</th><th class="r">Perspective</th></tr></thead><tbody>
${baseRows}
  </tbody></table>
  <p class="sub" style="margin:8px 0 0">Get a rough read even without other providers' keys: public data from the project's continuous probing, <b>aggregated across models</b>, by each one's probe region, <b>not equivalent</b> to your single-model results from this run.</p>` : '';
    return { summary: `🏁 ${winners}`, body: body + baseSection, metaExtra: `<div><span>Samples per target</span><b>${num(r.samplesPerTarget)}</b></div>` };
  };

  // —— Long-context retention (longcontext) body: one length×depth pass/fail heatmap per target ——
  const longContextBody = () => {
    const lengths = (r.lengths ?? []).slice().sort((a, b) => a - b);
    const depths = r.depths ?? [];
    const grids = targets.map((t) => {
      const map = new Map((t.grid ?? []).map((c) => [`${c.lengthTokens}|${c.depthPct}`, c.ok]));
      const head = lengths.map((l) => `<th class="c">${fmtLen(l)}</th>`).join('');
      const body = depths.map((d) => `<tr><td>${esc(d)}%</td>${lengths.map((l) => `<td class="c">${tri(map.has(`${l}|${d}`) ? map.get(`${l}|${d}`) : null)}</td>`).join('')}</tr>`).join('\n');
      const rel = typeof t.maxReliableLen === 'number' ? fmtLen(t.maxReliableLen) : '—';
      return `  <h3 class="tname">${esc(t.name)}${t.host ? `<span class="host">${esc(t.host)}</span>` : ''} <span class="rel">Reliable up to ${rel}</span></h3>
  <table class="lc"><thead><tr><th>Depth \\ Length</th>${head}</tr></thead><tbody>
${body}
  </tbody></table>`;
    }).join('\n');
    const trunc = cmp.truncators ?? [];
    const summary = `📏 Most reliable context: <b>${esc(cmp.bestContext ?? '—')}</b> · Truncation seen: <b>${trunc.length ? esc(trunc.join(', ')) : 'none'}</b>`;
    const metaExtra = `<div><span>Lengths</span><b>${lengths.map(fmtLen).join(' · ') || '—'}</b></div><div><span>Depths</span><b>${depths.map((d) => d + '%').join(' · ') || '—'}</b></div>`;
    return { summary, body: grids || '<p class="sub">No data</p>', metaExtra };
  };

  // —— Price comparison (pricematrix) body: model × gateway price matrix, cheapest gateway highlighted per row ——
  const priceMatrixBody = () => {
    const gws = r.gateways ?? [];
    const head = gws.map((g) => `<th class="r">${esc(g.name)}</th>`).join('');
    const rows = (r.rows ?? []).map((row) => {
      const cells = gws.map((g) => {
        const c = row.cells?.[g.id];
        if (!c || !Array.isArray(c.price)) return '<td class="r"><span class="na">—</span></td>';
        const idx = typeof c.idx === 'number' ? ` <span class="${c.idx < 1 ? 'ok' : c.idx > 1 ? 'bad' : ''}">${c.idx}×</span>` : '';
        return `<td class="r${row.cheapest === g.id ? ' cheap' : ''}">${c.price[0]}/${c.price[1]}${idx}</td>`;
      }).join('');
      const off = Array.isArray(row.official) ? `${row.official[0]}/${row.official[1]}` : '—';
      return `      <tr><td class="name">${esc(row.model)}</td><td class="r">${off}</td>${cells}</tr>`;
    }).join('\n');
    const srcs = r.sources ? Object.values(r.sources).map((s) => esc(String(s).replace(/^https?:\/\//, '').split('/')[0])).join(' · ') : 'Public pricing API';
    const body = `  <table><thead><tr><th>Model</th><th class="r">Official price</th>${head}</tr></thead><tbody>
${rows}
  </tbody></table>
  <p class="sub" style="margin:8px 0 0">Price = USD/1M tokens (input/output) · Multiplier = gateway price ÷ official price (<span class="ok">&lt;1×</span> cheaper, <span class="bad">&gt;1×</span> more expensive) · <span class="cheap" style="padding:1px 6px;border-radius:4px">green cell</span> = the cheapest gateway for that model. Data from public pricing API, <b>no key needed</b>.</p>`;
    return {
      summary: `📊 ${r.rows?.length ?? 0} classic models × ${gws.length} gateways · Price comparison (public pricing, compare with no key needed)`,
      body,
      metaExtra: `<div><span>Data source</span><b>${srcs}</b></div><div><span>Fetched at</span><b>${esc((r.fetchedAt ?? '—').slice(0, 16).replace('T', ' '))}</b></div>`,
    };
  };

  const { summary, body, metaExtra } = isPM ? priceMatrixBody() : isLC ? longContextBody() : compareBody();
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)}${r.model ? ' · ' + esc(r.model) : ''} · gwbench</title>
<style>
  :root{--ac:#6366f1;--bd:#e5e7eb;--mut:#6b7280;--ok:#16a34a;--bad:#dc2626;--warn:#d97706}
  *{box-sizing:border-box}body{font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif;color:#111827;margin:0;background:#f9fafb}
  .wrap{max-width:960px;margin:0 auto;padding:28px 20px 60px}
  h1{font-size:22px;margin:0 0 4px}.sub{color:var(--mut);margin:0 0 20px;font-size:13px}
  .meta{display:flex;flex-wrap:wrap;gap:16px;margin:0 0 18px;padding:12px 14px;background:#fff;border:1px solid var(--bd);border-radius:10px}
  .meta div span{display:block;color:var(--mut);font-size:11px}.meta div b{font-size:14px}
  .win{background:#eef2ff;border:1px solid #c7d2fe;border-radius:10px;padding:11px 14px;margin:0 0 18px;font-size:13px}
  table{width:100%;border-collapse:collapse;background:#fff;border:1px solid var(--bd);border-radius:10px;overflow:hidden;font-size:13px}
  th,td{padding:9px 10px;border-bottom:1px solid var(--bd);text-align:left}
  th{background:#f3f4f6;font-size:11px;color:var(--mut);text-transform:uppercase;letter-spacing:.03em}
  td.r,th.r{text-align:right;font-variant-numeric:tabular-nums}td.c,th.c{text-align:center}
  td.name{font-weight:600}.host{display:block;color:var(--mut);font-weight:400;font-size:11px}
  .ok{color:var(--ok);font-weight:700}.bad{color:var(--bad);font-weight:700}.na{color:#9ca3af}
  ul.flags{list-style:none;padding:0;margin:18px 0 0}.flag{padding:8px 12px;border-radius:8px;margin:6px 0;font-size:13px}
  .flag.alert{background:#fef2f2;border:1px solid #fecaca}.flag.warn{background:#fffbeb;border:1px solid #fde68a}
  table.lc{margin:0 0 18px}.tname{font-size:15px;margin:18px 0 6px}.tname .host{display:inline;margin-left:6px}
  .rel{font-size:12px;color:var(--mut);font-weight:500;margin-left:8px}
  td.cheap{background:#ecfdf5;font-weight:700}
  .gap{background:#fff;border:1px solid var(--bd);border-radius:12px;padding:16px;margin:0 0 18px}
  .gap-h{font-size:15px;font-weight:700}.gap-sum{color:var(--mut);font-size:13px;margin:4px 0 12px}
  .gap-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}
  .gap-cell{border:1px solid var(--bd);border-radius:9px;padding:10px}
  .gap-cell.bad{border-color:#fecaca;background:#fef2f2}.gap-cell.ok{border-color:#a7f3d0;background:#ecfdf5}
  .gd-label{font-size:11px;color:var(--mut);text-transform:uppercase}.gd-v{font-weight:700;font-size:15px;margin-top:2px}
  .gd-b{font-size:12px;color:var(--mut)}.gd-verdict{font-size:13px;font-weight:700;margin-top:4px}
  .gap-int{margin-top:12px;font-size:13px;font-weight:600}.gap-int.ok{color:var(--ok)}.gap-int.bad{color:var(--bad)}
  footer{margin-top:32px;color:var(--mut);font-size:12px;border-top:1px solid var(--bd);padding-top:16px}
  footer a{color:var(--ac)}
  .acts{display:flex;gap:10px;flex-wrap:wrap;margin:0 0 12px}
  .acts button,.acts a{font:600 13px/1 inherit;color:var(--ac);background:#eef2ff;border:1px solid #c7d2fe;border-radius:8px;padding:8px 13px;cursor:pointer;text-decoration:none}
</style></head><body><div class="wrap">
  <h1>${esc(title)}${r.model ? ' · ' + esc(r.model) : ''}</h1>
  <p class="sub">${isPM ? 'Pricing from public pricing API, no key needed; ' : 'Black-box probing, keys never leave your machine; '}this report is self-contained and shareable. schema ${esc(r.schema ?? REPORT_SCHEMA)}</p>
  <div class="meta">
    <div><span>${isPM ? 'Models covered' : 'Logical model'}</span><b>${isPM ? (r.rows?.length ?? 0) : esc(r.model ?? '—')}</b></div>
    <div><span>${isPM ? 'Data type' : 'Probe perspective'}</span><b>${esc(r.region ?? '—')}</b></div>
    ${metaExtra}
    <div><span>Generated at</span><b>${esc(r.generatedAt ?? '—')}</b></div>
    <div><span>Tool</span><b>${esc(r.tool?.name ?? 'gwbench')} ${esc(r.tool?.version ?? '')}</b></div>
  </div>
  <div class="win">${summary}</div>
${body}
  <footer>
    <div class="acts">
      <button id="gw-dl" type="button">Download report JSON</button>
      <a href="https://github.com/cuihuan/llm-gateway-bench#gwbench-compare" target="_blank" rel="noopener">Share to report gallery →</a>
    </div>
    Generated by <b>gwbench</b> · black-box probing — measured, not claimed, reproducible with your own key.
    Full methodology and public reference baseline at <a href="https://github.com/cuihuan/llm-gateway-bench">llm-gateway-bench</a>.
  </footer>
  <script type="application/json" id="gwbench-report">${JSON.stringify(report).replace(/</g, '\\u003c')}</script>
  <script>(function(){var b=document.getElementById('gw-dl');if(!b)return;b.addEventListener('click',function(){var j=document.getElementById('gwbench-report').textContent;var u=URL.createObjectURL(new Blob([j],{type:'application/json'}));var a=document.createElement('a');a.href=u;a.download='gwbench-report.json';document.body.appendChild(a);a.click();a.remove();setTimeout(function(){URL.revokeObjectURL(u);},1000);});})();</script>
</div></body></html>`;
}

export const _internals = { REPORT_SCHEMA };
