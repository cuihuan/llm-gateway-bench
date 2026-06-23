// 便携对比报告的纯构建函数（无 I/O，全部可单测）。
// compare.mjs 跑出每个目标的原始探针结果后，这里把它们压成报告契约
// （docs/PRODUCT-SPEC.md §4 schema gwbench-report/1），算出客观对比，
// 并渲染一份自包含 HTML。**绝不接触 key / Authorization / baseUrl**——
// 入参只给 host，报告只留 host（隐私红线）。

export const REPORT_SCHEMA = 'gwbench-report/1';

/** 把一个网关的原始探针结果（probeGateway 产出）压成报告里的一个 target。
 *  raw: { name, host, connMs?, region?, connectivity?, models:[{...summary, toolCall, cjk, needle}] }
 *  只取第一个被测模型（compare 每个目标只测一个逻辑模型）。 */
/** 价格倍率 = 平均(网关入价/官方入价, 网关出价/官方出价)。缺任一价 → null。
 *  与排行榜 priceIndex 同口径（docs/methodology.md），便于自测与公共基线对齐。 */
export function priceIdxFor(price, official) {
  if (!Array.isArray(price) || !Array.isArray(official)) return null;
  const [pi, po] = price, [oi, oo] = official;
  if (![pi, po, oi, oo].every((x) => typeof x === 'number') || oi <= 0 || oo <= 0) return null;
  return Math.round(((pi / oi + po / oo) / 2) * 100) / 100;
}

export function buildTarget(raw) {
  const m = raw?.models?.[0] ?? null;
  const connMs = raw?.connMs ?? raw?.connectivity?.latencyMs ?? null;
  // 价格 [入,出] USD/1M：registry 目标取自 prices.json 的对应网关列，ad-hoc 目标
  // 可由 --price-in/--price-out 提供；official 为官方标价基线。缺则 null（不臆造）。
  const price = Array.isArray(raw?.price) ? raw.price : null;
  const official = Array.isArray(raw?.official) ? raw.official : null;
  const priceIdx = priceIdxFor(price, official);
  if (!m) {
    return {
      name: raw?.name ?? '?', host: raw?.host ?? null, connMs,
      ttftMs: { p50: null, p95: null }, tokensPerSec: null, successRate: null,
      toolCall: null, burstStream: null, modelEcho: null, cjk: null, needle: null,
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
    // 三态：true 通过 / false 触发红旗 / null 无可判定数据
    toolCall: m.toolCall ? m.toolCall.ok === true : null,
    burstStream: m.burstStreamRate == null ? null : m.burstStreamRate >= 0.5,
    modelEcho: m.modelEchoRate == null ? null : m.modelEchoRate === 1,
    cjk: m.cjk ? m.cjk.ok === true : null,
    needle: m.needle ? m.needle.ok === true : null,
    usage: m.usage ?? null,
    price,
    priceIdx,
    error: failed ? (m.errors?.[0] ?? 'all samples failed') : null,
  };
}

/** 各红旗的严重度：偷换是硬证据（alert），其余是 warn。 */
const FLAG_SPEC = [
  { key: 'modelEcho', when: (t) => t.modelEcho === false, severity: 'alert', label: '模型回显不符（疑似偷换）' },
  { key: 'burstStream', when: (t) => t.burstStream === true, severity: 'warn', label: '疑似假流式（憋完再吐）' },
  { key: 'needle', when: (t) => t.needle === false, severity: 'warn', label: '长文本标记丢失（疑似上下文截断）' },
  { key: 'cjk', when: (t) => t.cjk === false, severity: 'warn', label: 'CJK 输出损坏（疑似量化降智）' },
  { key: 'toolCall', when: (t) => t.toolCall === false, severity: 'warn', label: '工具调用被剥离' },
  // 便宜得反常（<0.5×官方）通常是逆向渠道——配合信任评级一起看（docs/methodology.md 价格指数）。
  { key: 'cheapPrice', when: (t) => typeof t.priceIdx === 'number' && t.priceIdx < 0.5, severity: 'warn', label: '价格异常偏低（<0.5×官方，疑似逆向渠道）' },
  { key: 'error', when: (t) => t.error != null, severity: 'alert', label: '拨测失败' },
];

const priceSum = (t) => (Array.isArray(t.price) && typeof t.price[0] === 'number' && typeof t.price[1] === 'number' ? t.price[0] + t.price[1] : null);

/** 客观对比：谁最快 / 吞吐最高 / 最便宜，以及每个目标触发的红旗。不做黑箱加权总分。 */
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

/** 从聚合站点数据（web/data.json）提取公共基线参照（纯函数）：各网关持续拨测的
 *  30d 成功率 / 典型 TTFT / 价格指数 / 最近拨测。让自测时即使没有别家 key，也能
 *  对个大概。注意：网关级、跨模型聚合、按其探测地域——仅供参照，非本次实测。 */
export function buildBaselineRef(siteData) {
  const gws = Array.isArray(siteData?.gateways) ? siteData.gateways : [];
  return gws
    .filter((g) => g.uptimePct != null || g.speed?.ttftP50 != null || g.priceIdx != null)
    .map((g) => ({
      name: g.name, host: g.host ?? null,
      uptimePct: g.uptimePct ?? null,
      ttftP50: g.speed?.ttftP50 ?? null,
      priceIdx: g.priceIdx ?? null,
      region: g.region ?? null,
      lastRun: g.lastRun ?? null,
    }))
    .sort((a, b) => (b.uptimePct ?? -1) - (a.uptimePct ?? -1));
}

/** 由公开定价快照（data/prices.json）构造'经典模型 × 网关 价格横评'报告（纯函数）。
 *  价格来自公开定价 API（litellm 官方 / synthorai / openrouter），**无需任何 key**——
 *  所以这份横评是真实数据、可立即上线。每模型标出最便宜的网关。 */
export function buildPriceMatrixReport(prices, { gateways = [], region = '公开定价 API', generatedAt, version = '0.0.0' } = {}) {
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

/** 组装完整报告对象（report.json）。generatedAt/version 由调用方注入以便单测。
 *  baseline 非空时附'公共基线参照'（不进 comparison 的胜者/红旗，只作参照）。 */
export function buildReport({ kind = 'compare', model, region = null, samplesPerTarget = null, targets, baseline = null, generatedAt, version = '0.0.0' }) {
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
  return out;
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = (v, suffix = '') => (typeof v === 'number' ? `${v}${suffix}` : '—');
const tri = (v) => (v === true ? '<span class="ok">✓</span>' : v === false ? '<span class="bad">✗</span>' : '<span class="na">—</span>');
const fmtLen = (n) => (typeof n === 'number' ? (n >= 1000 ? `${+(n / 1000).toFixed(n % 1000 ? 1 : 0)}K` : String(n)) : '—');

/** 渲染自包含 HTML 报告：内嵌数据 + 内联样式，file:// 直接打开，可发给别人。
 *  纯字符串构建，无 I/O。报告里出现的目标信息只有 host（无 key/baseUrl）。 */
export function renderReportHtml(report) {
  const r = report ?? {};
  const targets = Array.isArray(r.targets) ? r.targets : [];
  const isLC = r.kind === 'longcontext';
  const isPM = r.kind === 'pricematrix';
  const cmp = r.comparison ?? (isLC || isPM ? {} : buildComparison(targets));
  const title = isPM ? '经典模型 × 网关 · 价格横评' : isLC ? '长文本上下文留存报告' : '网关对比报告';

  // —— 横向对比（compare）正文 ——
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
        <td class="r">${num(t.usage?.charsPerToken, '')}</td>
      </tr>`).join('\n');
    const flags = (cmp.flags ?? []).map((f) => `<li class="flag ${esc(f.severity)}"><b>${esc(f.target)}</b> · ${esc(f.label)}</li>`).join('\n');
    const winners = [
      cmp.fastestTtft ? `最快 TTFT：<b>${esc(cmp.fastestTtft)}</b>` : null,
      cmp.highestThroughput ? `吞吐最高：<b>${esc(cmp.highestThroughput)}</b>` : null,
      cmp.cheapest ? `最便宜：<b>${esc(cmp.cheapest)}</b>` : null,
    ].filter(Boolean).join(' · ') || '（无足够成功样本判定）';
    const body = `  <table><thead><tr>
    <th>目标</th><th class="r">TTFT P50</th><th class="r">TTFT P95</th><th class="r">tok/s</th><th class="r">成功率</th>
    <th class="r">价格 入/出</th><th class="r">倍率</th>
    <th class="c">模型回显</th><th class="c">工具调用</th><th class="c">真流式</th><th class="c">CJK</th><th class="c">长文本</th><th class="r">字/token</th>
  </tr></thead><tbody>
${rows}
  </tbody></table>
  <p class="sub" style="margin:8px 0 0">价格＝USD/1M tokens（输入/输出）· 倍率＝该网关价 ÷ 官方价（<span class="ok">&lt;1×</span> 比官方便宜，<span class="bad">&gt;1×</span> 更贵；&lt;0.5× 多为逆向渠道，配合行为指纹一起看）。</p>
  ${flags ? `<ul class="flags">\n${flags}\n</ul>` : '<p class="sub" style="margin-top:18px">未触发红旗。</p>'}`;
    const baseRows = (r.baseline ?? []).map((b) => `      <tr>
        <td class="name">${esc(b.name)}${b.host ? `<span class="host">${esc(b.host)}</span>` : ''}</td>
        <td class="r">${b.uptimePct != null ? b.uptimePct + '%' : '—'}</td>
        <td class="r">${num(b.ttftP50, ' ms')}</td>
        <td class="r">${b.priceIdx != null ? b.priceIdx + '×' : '—'}</td>
        <td class="r">${esc(b.region ?? '—')}</td>
      </tr>`).join('\n');
    const baseSection = baseRows ? `
  <h3 class="tname" style="margin-top:26px">公共基线参照 <span class="rel">持续拨测 · 网关级跨模型聚合 · 仅供参照，非本次实测</span></h3>
  <table><thead><tr><th>网关</th><th class="r">30D 成功率</th><th class="r">典型 TTFT</th><th class="r">价格指数</th><th class="r">视角</th></tr></thead><tbody>
${baseRows}
  </tbody></table>
  <p class="sub" style="margin:8px 0 0">没有别家 key 也能对个大概：项目持续拨测的公共数据，<b>跨模型聚合</b>、按各自探测地域，<b>不等同</b>于你本次实测的单模型结果。</p>` : '';
    return { summary: `🏁 ${winners}`, body: body + baseSection, metaExtra: `<div><span>每目标采样</span><b>${num(r.samplesPerTarget)}</b></div>` };
  };

  // —— 长文本留存（longcontext）正文：每目标一张 深度×长度 通过/失败热图 ——
  const longContextBody = () => {
    const lengths = (r.lengths ?? []).slice().sort((a, b) => a - b);
    const depths = r.depths ?? [];
    const grids = targets.map((t) => {
      const map = new Map((t.grid ?? []).map((c) => [`${c.lengthTokens}|${c.depthPct}`, c.ok]));
      const head = lengths.map((l) => `<th class="c">${fmtLen(l)}</th>`).join('');
      const body = depths.map((d) => `<tr><td>${esc(d)}%</td>${lengths.map((l) => `<td class="c">${tri(map.has(`${l}|${d}`) ? map.get(`${l}|${d}`) : null)}</td>`).join('')}</tr>`).join('\n');
      const rel = typeof t.maxReliableLen === 'number' ? fmtLen(t.maxReliableLen) : '—';
      return `  <h3 class="tname">${esc(t.name)}${t.host ? `<span class="host">${esc(t.host)}</span>` : ''} <span class="rel">可靠上限 ${rel}</span></h3>
  <table class="lc"><thead><tr><th>深度＼长度</th>${head}</tr></thead><tbody>
${body}
  </tbody></table>`;
    }).join('\n');
    const trunc = cmp.truncators ?? [];
    const summary = `📏 上下文最可靠：<b>${esc(cmp.bestContext ?? '—')}</b> · 出现截断：<b>${trunc.length ? esc(trunc.join('、')) : '无'}</b>`;
    const metaExtra = `<div><span>长度档</span><b>${lengths.map(fmtLen).join(' · ') || '—'}</b></div><div><span>深度档</span><b>${depths.map((d) => d + '%').join(' · ') || '—'}</b></div>`;
    return { summary, body: grids || '<p class="sub">无数据</p>', metaExtra };
  };

  // —— 价格横评（pricematrix）正文：模型 × 网关 价格矩阵，每行最便宜网关高亮 ——
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
    const srcs = r.sources ? Object.values(r.sources).map((s) => esc(String(s).replace(/^https?:\/\//, '').split('/')[0])).join(' · ') : '公开定价 API';
    const body = `  <table><thead><tr><th>模型</th><th class="r">官方价</th>${head}</tr></thead><tbody>
${rows}
  </tbody></table>
  <p class="sub" style="margin:8px 0 0">价格＝USD/1M tokens（输入/输出）· 倍率＝网关价 ÷ 官方价（<span class="ok">&lt;1×</span> 便宜，<span class="bad">&gt;1×</span> 更贵）· <span class="cheap" style="padding:1px 6px;border-radius:4px">绿底</span>＝该模型最便宜的网关。数据源公开定价 API，<b>无需 key</b>。</p>`;
    return {
      summary: `📊 ${r.rows?.length ?? 0} 个经典模型 × ${gws.length} 个网关 · 价格横评（公开定价，无需 key 即可对比）`,
      body,
      metaExtra: `<div><span>数据源</span><b>${srcs}</b></div><div><span>采集时间</span><b>${esc((r.fetchedAt ?? '—').slice(0, 16).replace('T', ' '))}</b></div>`,
    };
  };

  const { summary, body, metaExtra } = isPM ? priceMatrixBody() : isLC ? longContextBody() : compareBody();
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8">
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
  footer{margin-top:32px;color:var(--mut);font-size:12px;border-top:1px solid var(--bd);padding-top:16px}
  footer a{color:var(--ac)}
  .acts{display:flex;gap:10px;flex-wrap:wrap;margin:0 0 12px}
  .acts button,.acts a{font:600 13px/1 inherit;color:var(--ac);background:#eef2ff;border:1px solid #c7d2fe;border-radius:8px;padding:8px 13px;cursor:pointer;text-decoration:none}
</style></head><body><div class="wrap">
  <h1>${esc(title)}${r.model ? ' · ' + esc(r.model) : ''}</h1>
  <p class="sub">${isPM ? '价格来自公开定价 API，无需 key；' : '黑盒拨测，key 不出本机；'}本报告自包含、可分享。schema ${esc(r.schema ?? REPORT_SCHEMA)}</p>
  <div class="meta">
    <div><span>${isPM ? '覆盖模型' : '逻辑模型'}</span><b>${isPM ? (r.rows?.length ?? 0) + ' 个' : esc(r.model ?? '—')}</b></div>
    <div><span>${isPM ? '数据性质' : '探测视角'}</span><b>${esc(r.region ?? '—')}</b></div>
    ${metaExtra}
    <div><span>生成时间</span><b>${esc(r.generatedAt ?? '—')}</b></div>
    <div><span>工具</span><b>${esc(r.tool?.name ?? 'gwbench')} ${esc(r.tool?.version ?? '')}</b></div>
  </div>
  <div class="win">${summary}</div>
${body}
  <footer>
    <div class="acts">
      <button id="gw-dl" type="button">下载报告 JSON</button>
      <a href="https://github.com/cuihuan/llm-gateway-bench#自助对比测你自己的网关-gwbench-compare" target="_blank" rel="noopener">分享到报告广场 →</a>
    </div>
    由 <b>gwbench</b> 生成 · 黑盒拨测，不看声明看实测，可用自己的 key 复现。
    完整方法论与公共参照基线见 <a href="https://github.com/cuihuan/llm-gateway-bench">llm-gateway-bench</a>。
  </footer>
  <script type="application/json" id="gwbench-report">${JSON.stringify(report).replace(/</g, '\\u003c')}</script>
  <script>(function(){var b=document.getElementById('gw-dl');if(!b)return;b.addEventListener('click',function(){var j=document.getElementById('gwbench-report').textContent;var u=URL.createObjectURL(new Blob([j],{type:'application/json'}));var a=document.createElement('a');a.href=u;a.download='gwbench-report.json';document.body.appendChild(a);a.click();a.remove();setTimeout(function(){URL.revokeObjectURL(u);},1000);});})();</script>
</div></body></html>`;
}

export const _internals = { REPORT_SCHEMA };
