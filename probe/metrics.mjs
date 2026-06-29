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
 * Decode throughput (output / decode tokens-per-second). Aligned with llmperf and Artificial
 * Analysis: rate = tokens generated **after the first token** ÷ decode time **after the first
 * token**, not all tokens ÷ decode time. The latter keeps the first token in the numerator but
 * has already subtracted the first-token interval from the denominator (genMs = totalMs - ttftMs),
 * a mismatch that systematically overestimates tok/s — the slower the model and the larger the
 * ttft share, the more inflated it gets. AA's wording: "average number of tokens received per
 * second, after the first token". When tokens<2 (can't tell first from subsequent) or decode
 * time ≤0, speed can't be measured → null.
 */
export function decodeTokensPerSec({ tokens, ttftMs, totalMs } = {}) {
  if (typeof tokens !== 'number' || tokens < 2) return null;
  if (typeof ttftMs !== 'number' || typeof totalMs !== 'number') return null;
  const decodeMs = totalMs - ttftMs;
  if (!(decodeMs > 0)) return null;
  return round(((tokens - 1) / (decodeMs / 1000)), 1);
}

// Minimum successful samples required to report p95. Below this, p95 equals max and is
// statistically meaningless → set to null. The default of 3 samples per model is far too few;
// a credible p95 needs more samples or a rolling-window aggregate.
export const MIN_P95_SAMPLES = 5;

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
  // p95 is meaningless with too few samples (at n≤4 the p95 is basically max, hostage to a single
  // slow sample) — rather than report a misleading number, set it to null. p50/avg are still usable
  // with small samples, so give them as usual. For a credible p95, raise samples per model
  // (see docs/methodology.md).
  const p95 = (a) => (a.length >= MIN_P95_SAMPLES ? round(percentile(a, 95)) : null);
  return {
    samples: n,
    success: okSamples.length,
    successRate: n ? round(okSamples.length / n, 4) : null,
    ttftMs: { avg: round(avg(ttft)), p50: round(percentile(ttft, 50)), p95: p95(ttft) },
    tokensPerSec: { avg: round(avg(tps)), p50: round(percentile(tps, 50)) },
    totalMs: { avg: round(avg(total)), p95: p95(total) },
    // Whether streaming responses carry usage (a billing-transparency signal; for gateways missing
    // usage, tok/s can only be estimated from chunk count)
    usageReportedRate: okSamples.length
      ? round(okSamples.filter((s) => s.usageReported === true).length / okSamples.length, 2)
      : null,
    // Suspected fake-streaming share (judgeable samples only; null when none are judgeable)
    burstStreamRate: (() => {
      const verdicts = okSamples.map((s) => isBurstStream(s)).filter((v) => v !== null);
      return verdicts.length ? round(verdicts.filter(Boolean).length / verdicts.length, 2) : null;
    })(),
    // Model-echo hit rate (judgeable samples only): <1 means some samples echoed a model that
    // doesn't match the request.
    modelEchoRate: (() => {
      const verdicts = okSamples.map((s) => s.modelEcho).filter((v) => v != null);
      return verdicts.length ? round(verdicts.filter((v) => v.ok).length / verdicts.length, 2) : null;
    })(),
    // usage recompute fingerprint: median reported prompt_tokens under a fixed prompt + median
    // chars per received output token. For cross-gateway / official-baseline comparison — to catch
    // inflated token counts and hidden injection.
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
 * Fake-streaming heuristic: the server buffers the entire reply, then dumps all chunks at once to
 * fake streaming. Behavior fingerprint = a long wait for the first token (large ttft) + all content
 * arriving within a tiny time window (streamWindowMs = last-chunk arrival - first-chunk arrival).
 * Empirical thresholds: ≥5 chunks, window ≤250ms, ttft ≥800ms and ≥4× the window.
 * Fast genuine streaming (e.g. LPU inference) has a tiny ttft and won't be misflagged; slow genuine
 * streaming has a large window and won't be misflagged either. Returns null when there's not enough
 * to judge (too few chunks).
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
 * Model-echo check (a zero-cost hard signal for model substitution): compare the `model` field in
 * the response against the requested model. Requesting deepseek-v4-flash but getting back a
 * different family echoed = direct evidence. Normalization strips case/separators/vendor prefix,
 * and a substring match either way is treated as a match (tolerating version suffixes like -0528).
 * A missing echo → null (can't judge, not counted as evidence).
 */
export function evalModelEcho(reported, requested) {
  if (reported == null || reported === '') return null;
  const a = normModel(reported), b = normModel(requested);
  if (!a || !b) return null;
  const ok = a.includes(b) || b.includes(a);
  return ok ? { ok: true, reported } : { ok: false, reported, reason: `echo ${reported} ≠ requested ${requested}` };
}

/**
 * CJK output integrity (a common tell of quantization degradation): ask the model to output Chinese
 * and check that it actually produces Chinese and that it isn't corrupted. Int4/FP4 quantization
 * often degrades on CJK into mojibake / raw unicode escapes / replacement chars. Failing = suspected
 * quantization or non-native weights. Requires a passage that should be Chinese.
 */
export function evalCjkIntegrity(text) {
  const s = String(text ?? '');
  if (!s.trim()) return { ok: false, reason: 'empty response' };
  // \u4e00-\u9fff is the CJK Unified Ideographs range (escaped to keep the source ASCII).
  const cjk = (s.match(/[\u4e00-\u9fff]/g) || []).length;
  const replacement = (s.match(/\ufffd/g) || []).length;   // U+FFFD replacement char
  const literalEscapes = (s.match(/\\u[0-9a-fA-F]{4}/g) || []).length; // literal \uXXXX leakage
  if (replacement > 0) return { ok: false, reason: `contains ${replacement} replacement char(s) (encoding corrupted)` };
  if (literalEscapes >= 3) return { ok: false, reason: `contains ${literalEscapes} literal \\u escape(s) (not properly decoded)` };
  if (cjk < 2) return { ok: false, reason: 'almost no Chinese characters in response' };
  return { ok: true, cjkChars: cjk };
}

// The model-level price/value calculations (taskCost / tokensForBudget / valuePerDollar) have moved
// to web/calc.mjs as the single source of truth — the browser (evals.html) and this repo's unit
// tests share the same copy, avoiding drift between "the shipped algorithm" and "the tested
// algorithm". See probe/metrics.test.mjs importing from ../web/calc.mjs.

/**
 * needle context-truncation detection: embed a unique marker in a long filler text and ask the model
 * to read it back verbatim. If a gateway silently truncates context to save upstream cost, a marker
 * that falls before the cut point is deterministically lost.
 * ok ⇔ the answer contains the needle (case-insensitive).
 */
export function evalNeedle(text, needle) {
  if (!needle) return { ok: false, reason: 'no needle' };
  const found = String(text ?? '').toLowerCase().includes(String(needle).toLowerCase());
  return found ? { ok: true } : { ok: false, reason: 'needle not found in answer (suspected truncation)' };
}

/**
 * Extract the "cached prompt token count" from usage (a black-box prompt-cache signal). Handles three
 * reporting conventions: OpenAI `prompt_tokens_details.cached_tokens` · DeepSeek
 * `prompt_cache_hit_tokens` · Anthropic-style `cache_read_input_tokens`. None present → null
 * (the gateway doesn't report it, can't judge).
 */
export function extractCachedTokens(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const d = usage.prompt_tokens_details;
  if (d && typeof d.cached_tokens === 'number') return d.cached_tokens;
  if (typeof usage.prompt_cache_hit_tokens === 'number') return usage.prompt_cache_hit_tokens;
  if (typeof usage.cache_read_input_tokens === 'number') return usage.cache_read_input_tokens;
  return null;
}

/**
 * Prompt-cache verdict: send the same long prompt twice and see whether the second call hits the
 * cache. cachedSecond=null (not reported) → supported:null (can't judge); =0 (reported but no hit)
 * → false; >0 → true. Includes the hit fraction and TTFT speedup (how much faster the second call
 * is than the first). Pure function, easy to unit test.
 */
export function evalCache({ cachedSecond, promptTokens, ttftFirst, ttftSecond } = {}) {
  if (typeof cachedSecond !== 'number') {
    return { reported: false, supported: null, cachedTokens: null, cachedFrac: null, ttftSpeedupPct: null };
  }
  const cachedFrac = (typeof promptTokens === 'number' && promptTokens > 0)
    ? Math.round((cachedSecond / promptTokens) * 100) / 100 : null;
  const ttftSpeedupPct = (typeof ttftFirst === 'number' && typeof ttftSecond === 'number' && ttftFirst > 0)
    ? Math.round(((ttftFirst - ttftSecond) / ttftFirst) * 100) : null;
  return { reported: true, supported: cachedSecond > 0, cachedTokens: cachedSecond, cachedFrac, ttftSpeedupPct };
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
