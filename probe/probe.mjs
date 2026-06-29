#!/usr/bin/env node
// Dial-test runner: probes every gateway×model pair in data/gateways.json against
// OpenAI-compatible endpoints and writes one JSON result file per run.
//
// Usage:
//   node probe/probe.mjs [--samples 3] [--out data/results] [--gateway <id>]
//
// API keys are NEVER stored in this repo. Each gateway entry declares `authEnv`,
// the name of the environment variable holding its key (set via GitHub Secrets
// in CI, or exported locally). Gateways whose env var is missing are skipped
// and marked "skipped" in the output so the report can distinguish
// "not tested" from "failed".

import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { summarize, decodeTokensPerSec, evalToolCall, evalModelEcho, evalCjkIntegrity, evalNeedle, extractCachedTokens, evalCache } from './metrics.mjs';

const args = process.argv.slice(2);
function flag(name, fallback) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
}

/** CLI usage text (--help / -h) */
export function usage() {
  return `llm-gateway-bench prober — black-box probing of OpenAI-compatible gateways/endpoints

Usage:
  node probe/probe.mjs [options]

Options:
  --gateway <id>     Probe only one gateway in data/gateways.json (default: all)
  --url <baseUrl>    Probe an arbitrary endpoint without editing config; key read from env (see --auth-env)
  --model <id[,id]>  With --url: the models to probe, comma-separated
  --auth-env <NAME>  With --url: name of the env var holding the key (default PROBE_KEY)
  --name <name>      With --url: gateway name shown in results (default: host)
  --samples <n>      Number of samples per model (default 3; multiple samples for percentiles)
  --out <dir>        Directory to write results to (default out/; --url mode prints only, no write)
  -h, --help         Show this help

Environment:
  <gateway>.authEnv  Each gateway's key env var name is in data/gateways.json (missing key → auto-skipped)
  PROBE_REGION       Probe region label written into results (e.g. gh-us / local-cn)

Examples:
  # Probe one model on an arbitrary endpoint (results to stdout, not written to disk)
  PROBE_KEY=sk-... node probe/probe.mjs --url https://api.example.com --model gpt-4o-mini --samples 3
  # Probe one configured gateway and write to disk, for aggregation
  SYNTHORAI_API_KEY=sk-... node probe/probe.mjs --gateway synthorai --out data/results

Each probe also measures: streaming TTFT/throughput, success rate, tool-call forwarding, fake
streaming, CJK integrity, context truncation, model echo, usage recompute. The verdict logic lives
in probe/metrics.mjs (pure functions + unit tests).`;
}
const SAMPLES = Number(flag('samples', 3));
const OUT_DIR = flag('out', 'out');
const ONLY_GATEWAY = flag('gateway', null);

/**
 * Ad-hoc gateway: probe any OpenAI-compatible endpoint directly via --url, without editing
 * data/gateways.json. The key is read from an env var (default PROBE_KEY, override with --auth-env),
 * never passed on the command line to avoid leaking it. Returns a gateway object, or null when url is missing.
 */
export function adhocGateway({ url, model, name, authEnv } = {}) {
  if (!url) return null;
  const models = String(model ?? '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  return {
    id: 'adhoc',
    name: name || new URL(url).host,
    baseUrl: url.replace(/\/+$/, ''),
    authEnv: authEnv || 'PROBE_KEY',
    probeModels: models,
    tags: [],
  };
}
const TIMEOUT_MS = 60_000;
// llmperf convention: have the model generate a fixed task up to max_tokens, rather than a single
// "pong" — otherwise the output is only 2-3 chunks, tok/s is noise divided by a few ms, and the
// fake-streaming detector can't gather enough samples. The random string defeats gateway-side
// caching (docs/research.md engineering red line).
const probePrompt = () => `List the numbers from one to fifty as English words, comma separated, no other text. Ignore this request id: ${Math.random().toString(36).slice(2, 8)}`;
const MAX_TOKENS = 64;

const PROBE_TOOL = {
  type: 'function',
  function: {
    name: 'get_time',
    description: 'Get the current local time in a city',
    parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
  },
};

async function timedFetch(url, init) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('timeout')), TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

// GET /v1/models — cheap connectivity + auth check.
async function probeConnectivity(gw, key) {
  const t0 = performance.now();
  try {
    const res = await timedFetch(`${gw.baseUrl}/v1/models`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    const latencyMs = Math.round(performance.now() - t0);
    if (!res.ok) return { ok: false, latencyMs, error: `HTTP ${res.status}` };
    const body = await res.json().catch(() => null);
    const modelCount = Array.isArray(body?.data) ? body.data.length : null;
    return { ok: true, latencyMs, modelCount };
  } catch (e) {
    return { ok: false, latencyMs: Math.round(performance.now() - t0), error: String(e?.message ?? e) };
  }
}

// One streaming chat completion; measures TTFT (first content delta) and tokens/s.
async function probeChatOnce(gw, model, key) {
  const t0 = performance.now();
  try {
    const res = await timedFetch(`${gw.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: probePrompt() }],
        max_tokens: MAX_TOKENS,
        stream: true,
        stream_options: { include_usage: true },
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { ok: false, error: `HTTP ${res.status} ${text.slice(0, 120)}` };
    }
    let ttftMs = null;
    let completionTokens = null;
    let promptTokens = null;
    let chunks = 0;
    let lastContentAt = null;
    let outputChars = 0;
    let reportedModel = null;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data: ') || line.includes('[DONE]')) continue;
        let evt;
        try { evt = JSON.parse(line.slice(6)); } catch { continue; }
        const delta = evt.choices?.[0]?.delta?.content;
        if (delta) {
          chunks++;
          outputChars += delta.length;
          lastContentAt = performance.now();
          if (ttftMs === null) ttftMs = lastContentAt - t0;
        }
        if (typeof evt.usage?.completion_tokens === 'number') completionTokens = evt.usage.completion_tokens;
        if (typeof evt.usage?.prompt_tokens === 'number') promptTokens = evt.usage.prompt_tokens;
        if (reportedModel == null && typeof evt.model === 'string') reportedModel = evt.model;
      }
    }
    const totalMs = performance.now() - t0;
    if (ttftMs === null) return { ok: false, error: 'no content received', totalMs: Math.round(totalMs) };
    // Fall back to chunk count when the gateway omits usage in streams.
    const tokens = completionTokens ?? chunks;
    return {
      ok: true,
      ttftMs: Math.round(ttftMs),
      totalMs: Math.round(totalMs),
      // Decode throughput (aligned with llmperf/AA): tokens after the first ÷ time after the first.
      // Computed with the raw float ttftMs/totalMs (not the rounded values) to avoid rounding error on short replies.
      tokensPerSec: decodeTokensPerSec({ tokens, ttftMs, totalMs }),
      usageReported: completionTokens !== null,
      chunks,
      // Time window from the first content chunk to the last — the core fingerprint for fake-streaming detection
      streamWindowMs: Math.round(lastContentAt - (t0 + ttftMs)),
      // usage recompute fingerprint: token count the gateway reports under a fixed prompt + received output chars.
      // For the same model, an abnormally low charsPerToken on one gateway = inflated tokens; a promptTokens far
      // above the same model's baseline = hidden system-prompt injection. Needs a baseline; first capture the raw signal.
      promptTokens,
      completionTokens,
      outputChars,
      // Model echo: the model field in the response, compared with the requested model to catch substitution (zero-cost)
      modelEcho: evalModelEcho(reportedModel, model),
    };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e), totalMs: Math.round(performance.now() - t0) };
  }
}

// One non-stream completion with a tool definition: does the gateway forward
// tools intact (resold/reverse channels often strip them)? Doubles as the
// non-stream total-latency sample.
async function probeToolCall(gw, model, key) {
  const t0 = performance.now();
  try {
    const res = await timedFetch(`${gw.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: `What time is it in Tokyo right now? Use the tool. Ignore this request id: ${Math.random().toString(36).slice(2, 8)}` }],
        tools: [PROBE_TOOL],
        tool_choice: 'auto',
        max_tokens: MAX_TOKENS,
      }),
    });
    const totalMs = Math.round(performance.now() - t0);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { ok: false, totalMs, error: `HTTP ${res.status} ${text.slice(0, 120)}` };
    }
    const verdict = evalToolCall(await res.json().catch(() => null), 'get_time');
    return verdict.ok ? { ok: true, totalMs } : { ok: false, totalMs, error: verdict.reason };
  } catch (e) {
    return { ok: false, totalMs: Math.round(performance.now() - t0), error: String(e?.message ?? e) };
  }
}

// One non-stream completion that returns the body text (shared by the CJK / needle probes).
async function chatOnceText(gw, model, key, userContent, maxTokens) {
  const res = await timedFetch(`${gw.baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: userContent }], max_tokens: maxTokens }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    return { ok: false, error: `HTTP ${res.status} ${text.slice(0, 120)}` };
  }
  const body = await res.json().catch(() => null);
  return { ok: true, text: body?.choices?.[0]?.message?.content ?? '' };
}

// CJK output integrity probe (a quantization/degradation tell): ask for one Chinese sentence and check it isn't corrupted.
// The Chinese instruction is written as \u escapes so the source stays ASCII (the probe still asks for Chinese output).
async function probeCjk(gw, model, key) {
  try {
    const r = await chatOnceText(gw, model, key, `\u7528\u4e2d\u6587\u5199\u4e00\u53e5\u5173\u4e8e\u4eca\u5929\u5929\u6c14\u7684\u8bdd\uff0c\u53ea\u8f93\u51fa\u8fd9\u53e5\u8bdd\u3002 Ignore this request id: ${Math.random().toString(36).slice(2, 8)}`, 64);
    if (!r.ok) return { ok: false, error: r.error };
    const v = evalCjkIntegrity(r.text);
    return v.ok ? { ok: true } : { ok: false, error: v.reason };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

// Context-truncation probe: embed a unique UUID needle in long filler and ask it to be read back; truncation loses it.
async function probeNeedle(gw, model, key) {
  const needle = `NDL-${Math.random().toString(36).slice(2, 10).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
  // ~3.5K tokens of filler (about 11 tokens/line × 320 lines); the needle is embedded at ~12% depth —
  // if the gateway truncates with a tail-retained window, the needle falls before the cut and is lost.
  const filler = Array.from({ length: 320 }, (_, i) => `Line ${i + 1}: the quick brown fox jumps over the lazy dog repeatedly.`);
  filler.splice(40, 0, `IMPORTANT MARKER — remember this exact code: ${needle}`);
  const content = `${filler.join('\n')}\n\nQuestion: what is the exact code in the IMPORTANT MARKER line above? Reply with only the code.`;
  try {
    const r = await chatOnceText(gw, model, key, content, 64);
    if (!r.ok) return { ok: false, error: r.error };
    const v = evalNeedle(r.text, needle);
    return v.ok ? { ok: true } : { ok: false, error: v.reason };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

/**
 * Run the full black-box probe suite for one gateway: connectivity + per-model streaming multi-sample /
 * tool call / CJK / needle. compare.mjs and main() share the same implementation (single source of
 * truth — what's probed in production is what's compared). Progress goes to stderr; samples is the
 * per-model sample count.
 * Returns { connectivity, models:[{ model, ...summary, toolCall, cjk, needle }] }.
 */
export async function probeGateway(gw, key, { samples = SAMPLES } = {}) {
  const connectivity = await probeConnectivity(gw, key);
  console.error(`[conn] ${gw.id}: ${connectivity.ok ? `${connectivity.latencyMs}ms, ${connectivity.modelCount ?? '?'} models` : connectivity.error}`);
  const models = [];
  for (const model of gw.probeModels ?? []) {
    const ss = [];
    for (let i = 0; i < samples; i++) ss.push(await probeChatOnce(gw, model, key));
    const summary = summarize(ss);
    const toolCall = await probeToolCall(gw, model, key);
    const cjk = await probeCjk(gw, model, key);
    const needle = await probeNeedle(gw, model, key);
    const cache = await probeCache(gw, model, key);
    const cacheStr = cache.ok ? (cache.supported === true ? '✓' : cache.supported === false ? '✗' : '?') : `✗(${cache.error})`;
    console.error(`[chat] ${gw.id}/${model}: ok ${summary.success}/${summary.samples}, ttft p50 ${summary.ttftMs.p50}ms, ${summary.tokensPerSec.avg} tok/s, tool ${toolCall.ok ? '✓' : '✗'}, cjk ${cjk.ok ? '✓' : `✗(${cjk.error})`}, needle ${needle.ok ? '✓' : `✗(${needle.error})`}, cache ${cacheStr}`);
    models.push({ model, ...summary, toolCall, cjk, needle, cache });
  }
  return { connectivity, models };
}

// Prompt-cache probe: send the same long prompt twice (≥~1K tokens, the threshold for caching to kick in)
// and check whether the second call's usage reports cached tokens. Fixed and byte-identical across the two
// calls — exactly the precondition for a cache hit.
const CACHE_PROMPT = 'Read the following reference text carefully, then reply with only the word OK.\n\n'
  + 'The quick brown fox jumps over the lazy dog while an API gateway caches the prompt prefix. '.repeat(130);
async function probeCache(gw, model, key) {
  const once = async () => {
    const t0 = performance.now();
    const res = await timedFetch(`${gw.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: CACHE_PROMPT }], max_tokens: 4 }),
    });
    if (!res.ok) { const t = await res.text().catch(() => ''); return { ok: false, error: `HTTP ${res.status} ${t.slice(0, 80)}` }; }
    const body = await res.json().catch(() => null);
    return { ok: true, usage: body?.usage ?? null, ttft: Math.round(performance.now() - t0) };
  };
  try {
    const a = await once(); if (!a.ok) return { ok: false, error: a.error };
    const b = await once(); if (!b.ok) return { ok: false, error: b.error };
    const v = evalCache({ cachedSecond: extractCachedTokens(b.usage), promptTokens: b.usage?.prompt_tokens, ttftFirst: a.ttft, ttftSecond: b.ttft });
    return { ok: true, ...v };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

async function main() {
  if (args.includes('--help') || args.includes('-h')) { console.log(usage()); return; }
  const adhoc = adhocGateway({ url: flag('url', null), model: flag('model', null), name: flag('name', null), authEnv: flag('auth-env', null) });
  if (adhoc && !adhoc.probeModels.length) {
    console.error('[probe] --url requires --model <id[,id2]> (which model(s) to probe)');
    process.exit(1);
  }
  const gateways = adhoc
    ? [adhoc]
    : JSON.parse(await readFile(new URL('../data/gateways.json', import.meta.url), 'utf8'));
  const startedAt = new Date().toISOString();
  const results = [];
  for (const gw of gateways) {
    if (ONLY_GATEWAY && gw.id !== ONLY_GATEWAY) continue;
    const key = process.env[gw.authEnv];
    if (!key) {
      console.error(`[skip] ${gw.id}: env ${gw.authEnv} not set`);
      results.push({ gateway: gw.id, skipped: true, reason: `missing ${gw.authEnv}` });
      continue;
    }
    const { connectivity, models } = await probeGateway(gw, key, { samples: SAMPLES });
    results.push({ gateway: gw.id, skipped: false, connectivity, models });
  }
  if (results.every((r) => r.skipped)) {
    console.error('[probe] all gateways skipped (no keys in env) — nothing written');
    return;
  }
  const run = {
    schema: 1,
    startedAt,
    finishedAt: new Date().toISOString(),
    region: process.env.PROBE_REGION ?? 'unknown',
    runner: process.env.GITHUB_ACTIONS ? 'github-actions' : 'local',
    samplesPerModel: SAMPLES,
    results,
  };
  // Ad-hoc probing (--url) only prints results and never pollutes data/results; an explicit --out still writes to disk.
  if (adhoc && flag('out', null) === null) {
    console.log(JSON.stringify(run, null, 2));
    return;
  }
  await mkdir(OUT_DIR, { recursive: true });
  const file = `${OUT_DIR}/${startedAt.slice(0, 10)}T${startedAt.slice(11, 19).replaceAll(':', '')}-${run.region}.json`;
  await writeFile(file, JSON.stringify(run, null, 2));
  console.log(file);
}

// Run main only when invoked directly as a script; not when imported (e.g. by unit tests).
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
