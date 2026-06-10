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
    errors: samples.filter((s) => !s.ok).map((s) => s.error ?? 'unknown').slice(0, 5),
  };
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
