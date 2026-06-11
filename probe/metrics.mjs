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
