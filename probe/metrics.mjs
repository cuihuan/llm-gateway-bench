// Pure metric helpers for probe results. No I/O here so everything is unit-testable.

/**
 * Linear-interpolated percentile. `values` need not be sorted.
 * Returns null for an empty array.
 */
export function percentile(values, p) {
  if (!Array.isArray(values) || values.length === 0) return null;
  if (p < 0 || p > 100) throw new RangeError(`percentile p out of range: ${p}`);
  const sorted = [...values].sort((a, b) => a - b);
  const idx = (sorted.length - 1) * (p / 100);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function round(x, digits = 1) {
  if (x === null || x === undefined || Number.isNaN(x)) return null;
  const f = 10 ** digits;
  return Math.round(x * f) / f;
}

/**
 * Aggregate raw samples for one (gateway, model) pair into a summary row.
 * Each sample: { ok: boolean, ttftMs?: number, tokensPerSec?: number, totalMs?: number, error?: string }
 */
export function summarize(samples) {
  const n = samples.length;
  const okSamples = samples.filter((s) => s.ok);
  const pick = (key) => okSamples.map((s) => s[key]).filter((v) => typeof v === 'number');
  const ttft = pick('ttftMs');
  const tps = pick('tokensPerSec');
  const total = pick('totalMs');
  const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
  return {
    samples: n,
    success: okSamples.length,
    successRate: n ? round(okSamples.length / n, 4) : null,
    ttftMs: { avg: round(avg(ttft)), p50: round(percentile(ttft, 50)), p95: round(percentile(ttft, 95)) },
    tokensPerSec: { avg: round(avg(tps)), p50: round(percentile(tps, 50)) },
    totalMs: { avg: round(avg(total)), p95: round(percentile(total, 95)) },
    // 流式响应里是否带 usage（计费透明度信号；缺 usage 的网关 tok/s 只能按 chunk 数估）
    usageReportedRate: okSamples.length
      ? round(okSamples.filter((s) => s.usageReported === true).length / okSamples.length, 2)
      : null,
    // 疑似假流式占比（仅统计可判定样本；无可判定样本时为 null）
    burstStreamRate: (() => {
      const verdicts = okSamples.map((s) => isBurstStream(s)).filter((v) => v !== null);
      return verdicts.length ? round(verdicts.filter(Boolean).length / verdicts.length, 2) : null;
    })(),
    // 模型回显命中率（仅统计可判定样本）：<1 表示有样本回显的 model 与请求不符。
    modelEchoRate: (() => {
      const verdicts = okSamples.map((s) => s.modelEcho).filter((v) => v != null);
      return verdicts.length ? round(verdicts.filter((v) => v.ok).length / verdicts.length, 2) : null;
    })(),
    // usage 重算指纹：固定 prompt 下上报的 prompt_tokens 中位数 + 实收正文每 token
    // 字符数中位数。供跨网关/对官方基线比对——揪虚报 token 与隐藏注入。
    usage: (() => {
      const promptToks = okSamples.map((s) => s.promptTokens).filter((v) => typeof v === 'number');
      const cpt = okSamples
        .filter((s) => typeof s.completionTokens === 'number' && s.completionTokens > 0 && typeof s.outputChars === 'number')
        .map((s) => s.outputChars / s.completionTokens);
      return {
        promptTokens: round(percentile(promptToks, 50)),
        charsPerToken: cpt.length ? round(percentile(cpt, 50), 2) : null,
      };
    })(),
    errors: samples.filter((s) => !s.ok).map((s) => s.error ?? 'unknown').slice(0, 5),
  };
}

/**
 * 假流式（fake streaming）启发式判定：服务端憋完整个回复后一次性 dump 所有
 * chunk 伪装流式。行为指纹 = 首 token 等了很久（ttft 大）+ 全部内容在极小的
 * 时间窗（streamWindowMs = 末 chunk 到达时刻 - 首 chunk 到达时刻）内到达。
 * 阈值经验值：≥5 个 chunk、窗口 ≤250ms、ttft ≥800ms 且 ≥4 倍窗口。
 * 快但真流式的服务（如 LPU 推理）ttft 很小，不会误伤；慢但真流式的窗口大，
 * 也不会误伤。返回 null 表示样本不足以判定（chunk 太少）。
 */
export function isBurstStream({ chunks, ttftMs, streamWindowMs }) {
  if (typeof chunks !== 'number' || chunks < 5) return null;
  if (typeof ttftMs !== 'number' || typeof streamWindowMs !== 'number') return null;
  return streamWindowMs <= 250 && ttftMs >= 800 && ttftMs >= 4 * Math.max(streamWindowMs, 1);
}

/**
 * Judge one non-stream chat completion body for tool-calling support.
 * ok ⇔ the model called `expectedTool` with parseable JSON arguments —
 * evidence the gateway forwards tool definitions intact instead of
 * stripping them (a common failure mode of resold/reverse channels).
 */
export function evalToolCall(body, expectedTool) {
  const call = body?.choices?.[0]?.message?.tool_calls?.[0];
  if (!call) return { ok: false, reason: 'no tool_calls in response' };
  const name = call.function?.name;
  if (expectedTool && name !== expectedTool) {
    return { ok: false, reason: `called ${name ?? 'unknown'} instead of ${expectedTool}` };
  }
  try {
    JSON.parse(call.function?.arguments ?? '');
  } catch {
    return { ok: false, reason: 'tool arguments are not valid JSON' };
  }
  return { ok: true };
}

const normModel = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * 模型回显校验（偷换模型的零成本硬信号）：把响应里的 `model` 字段与请求的
 * model 比对。请求 deepseek-v4-flash 却回显成别的家族 = 直接证据。归一化去掉
 * 大小写/分隔符/供应商前缀，互为子串即视为一致（容忍 -0528 之类版本后缀）。
 * 回显缺失 → null（无法判定，不算证据）。
 */
export function evalModelEcho(reported, requested) {
  if (reported == null || reported === '') return null;
  const a = normModel(reported), b = normModel(requested);
  if (!a || !b) return null;
  const ok = a.includes(b) || b.includes(a);
  return ok ? { ok: true, reported } : { ok: false, reported, reason: `回显 ${reported} ≠ 请求 ${requested}` };
}

/**
 * CJK 输出完整性（量化降智的常见 tell）：要求模型输出中文，检查是否真给出
 * 中文且未损坏。Int4/FP4 量化在 CJK 上常退化为乱码/原始 unicode 转义/替换符。
 * 不达标 = 疑似量化或非原生权重。需要一段应为中文的文本。
 */
export function evalCjkIntegrity(text) {
  const s = String(text ?? '');
  if (!s.trim()) return { ok: false, reason: '空响应' };
  const cjk = (s.match(/[一-鿿]/g) || []).length;
  const replacement = (s.match(/�/g) || []).length;             //
  const literalEscapes = (s.match(/\\u[0-9a-fA-F]{4}/g) || []).length; // 字面量 \uXXXX 泄漏
  if (replacement > 0) return { ok: false, reason: `含 ${replacement} 个替换符（编码损坏）` };
  if (literalEscapes >= 3) return { ok: false, reason: `含 ${literalEscapes} 处字面量 \\u 转义（未正确解码）` };
  if (cjk < 2) return { ok: false, reason: '响应中几乎无中文字符' };
  return { ok: true, cjkChars: cjk };
}

// 模型评测的价格价值计算（taskCost / tokensForBudget / valuePerDollar）已移至
// web/calc.mjs 作为单一来源——浏览器 evals.html 与本仓库单测共用同一份，避免
// "上线算法 ≠ 被测算法"的漂移。见 probe/metrics.test.mjs 从 ../web/calc.mjs 导入。

/**
 * needle 上下文截断检测：在长填充文本里埋一个唯一标记，要求模型原样回读。
 * 网关若为省上游成本悄悄截断上下文，标记落在切点前就会确定性丢失。
 * ok ⇔ 回答里包含该 needle（忽略大小写）。
 */
export function evalNeedle(text, needle) {
  if (!needle) return { ok: false, reason: 'no needle' };
  const found = String(text ?? '').toLowerCase().includes(String(needle).toLowerCase());
  return found ? { ok: true } : { ok: false, reason: 'needle 未在回答中出现（疑似截断）' };
}

/**
 * Merge a list of daily summaries into a long-run stability view.
 * Each entry: { date: 'YYYY-MM-DD', successRate, ttftP50 }
 * Returns { days, uptimePct, ttftP50TrendMs } where uptimePct is the mean
 * success rate across days (each day weighted equally).
 */
export function stabilityOverTime(dailySummaries) {
  const valid = dailySummaries.filter((d) => typeof d.successRate === 'number');
  if (valid.length === 0) return { days: 0, uptimePct: null, ttftP50TrendMs: [] };
  const uptime = valid.reduce((acc, d) => acc + d.successRate, 0) / valid.length;
  return {
    days: valid.length,
    uptimePct: round(uptime * 100, 2),
    ttftP50TrendMs: valid.map((d) => ({ date: d.date, ttftP50: d.ttftP50 ?? null })),
  };
}
