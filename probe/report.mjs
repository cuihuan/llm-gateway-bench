// 便携对比报告的纯构建函数（无 I/O，全部可单测）。
// compare.mjs 跑出每个目标的原始探针结果后，这里把它们压成报告契约
// （docs/PRODUCT-SPEC.md §4 schema gwbench-report/1），算出客观对比，
// 并渲染一份自包含 HTML。**绝不接触 key / Authorization / baseUrl**——
// 入参只给 host，报告只留 host（隐私红线）。

export const REPORT_SCHEMA = 'gwbench-report/1';

/** 把一个网关的原始探针结果（probeGateway 产出）压成报告里的一个 target。
 *  raw: { name, host, connMs?, region?, connectivity?, models:[{...summary, toolCall, cjk, needle}] }
 *  只取第一个被测模型（compare 每个目标只测一个逻辑模型）。 */
export function buildTarget(raw) {
  const m = raw?.models?.[0] ?? null;
  const connMs = raw?.connMs ?? raw?.connectivity?.latencyMs ?? null;
  if (!m) {
    return {
      name: raw?.name ?? '?', host: raw?.host ?? null, connMs,
      ttftMs: { p50: null, p95: null }, tokensPerSec: null, successRate: null,
      toolCall: null, burstStream: null, modelEcho: null, cjk: null, needle: null,
      usage: null, error: raw?.error ?? 'no model probed',
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
  { key: 'error', when: (t) => t.error != null, severity: 'alert', label: '拨测失败' },
];

/** 客观对比：谁最快 / 吞吐最高，以及每个目标触发的红旗。不做黑箱加权总分。 */
export function buildComparison(targets) {
  const list = Array.isArray(targets) ? targets : [];
  const withTtft = list.filter((t) => typeof t.ttftMs?.p50 === 'number' && t.successRate > 0);
  const withTps = list.filter((t) => typeof t.tokensPerSec === 'number' && t.successRate > 0);
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
    flags,
  };
}

/** 组装完整报告对象（report.json）。generatedAt/version 由调用方注入以便单测。 */
export function buildReport({ kind = 'compare', model, region = null, samplesPerTarget = null, targets, generatedAt, version = '0.0.0' }) {
  const t = Array.isArray(targets) ? targets : [];
  return {
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
  const cmp = r.comparison ?? (isLC ? {} : buildComparison(targets));
  const title = isLC ? '长文本上下文留存报告' : '网关对比报告';

  // —— 横向对比（compare）正文 ——
  const compareBody = () => {
    const rows = targets.map((t) => `      <tr>
        <td class="name">${esc(t.name)}${t.host ? `<span class="host">${esc(t.host)}</span>` : ''}</td>
        <td class="r">${num(t.ttftMs?.p50, ' ms')}</td>
        <td class="r">${num(t.ttftMs?.p95, ' ms')}</td>
        <td class="r">${num(t.tokensPerSec, '')}</td>
        <td class="r">${typeof t.successRate === 'number' ? Math.round(t.successRate * 100) + '%' : '—'}</td>
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
    ].filter(Boolean).join(' · ') || '（无足够成功样本判定）';
    const body = `  <table><thead><tr>
    <th>目标</th><th class="r">TTFT P50</th><th class="r">TTFT P95</th><th class="r">tok/s</th><th class="r">成功率</th>
    <th class="c">模型回显</th><th class="c">工具调用</th><th class="c">真流式</th><th class="c">CJK</th><th class="c">长文本</th><th class="r">字/token</th>
  </tr></thead><tbody>
${rows}
  </tbody></table>
  ${flags ? `<ul class="flags">\n${flags}\n</ul>` : '<p class="sub" style="margin-top:18px">未触发红旗。</p>'}`;
    return { summary: `🏁 ${winners}`, body, metaExtra: `<div><span>每目标采样</span><b>${num(r.samplesPerTarget)}</b></div>` };
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

  const { summary, body, metaExtra } = isLC ? longContextBody() : compareBody();
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)} · ${esc(r.model ?? '')} · gwbench</title>
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
  footer{margin-top:32px;color:var(--mut);font-size:12px;border-top:1px solid var(--bd);padding-top:16px}
  footer a{color:var(--ac)}
</style></head><body><div class="wrap">
  <h1>${esc(title)} · ${esc(r.model ?? '')}</h1>
  <p class="sub">黑盒拨测，key 不出本机；本报告自包含、可分享。schema ${esc(r.schema ?? REPORT_SCHEMA)}</p>
  <div class="meta">
    <div><span>逻辑模型</span><b>${esc(r.model ?? '—')}</b></div>
    <div><span>探测视角</span><b>${esc(r.region ?? '—')}</b></div>
    ${metaExtra}
    <div><span>生成时间</span><b>${esc(r.generatedAt ?? '—')}</b></div>
    <div><span>工具</span><b>${esc(r.tool?.name ?? 'gwbench')} ${esc(r.tool?.version ?? '')}</b></div>
  </div>
  <div class="win">${summary}</div>
${body}
  <footer>
    由 <b>gwbench</b> 生成 · 黑盒拨测，不看声明看实测，可用自己的 key 复现。
    完整方法论与公共参照基线见 <a href="https://github.com/cuihuan/llm-gateway-bench">llm-gateway-bench</a>。
  </footer>
  <script type="application/json" id="gwbench-report">${JSON.stringify(report).replace(/</g, '\\u003c')}</script>
</div></body></html>`;
}

export const _internals = { REPORT_SCHEMA };
