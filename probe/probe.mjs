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
import { summarize } from './metrics.mjs';

const args = process.argv.slice(2);
function flag(name, fallback) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
}
const SAMPLES = Number(flag('samples', 3));
const OUT_DIR = flag('out', 'out');
const ONLY_GATEWAY = flag('gateway', null);
const TIMEOUT_MS = 60_000;
const PROBE_PROMPT = 'Reply with the single word: pong';
const MAX_TOKENS = 64;

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
        messages: [{ role: 'user', content: PROBE_PROMPT }],
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
    let chunks = 0;
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
        if (evt.choices?.[0]?.delta?.content) {
          chunks++;
          if (ttftMs === null) ttftMs = performance.now() - t0;
        }
        if (evt.usage?.completion_tokens) completionTokens = evt.usage.completion_tokens;
      }
    }
    const totalMs = performance.now() - t0;
    if (ttftMs === null) return { ok: false, error: 'no content received', totalMs: Math.round(totalMs) };
    const genMs = totalMs - ttftMs;
    // Fall back to chunk count when the gateway omits usage in streams.
    const tokens = completionTokens ?? chunks;
    return {
      ok: true,
      ttftMs: Math.round(ttftMs),
      totalMs: Math.round(totalMs),
      tokensPerSec: genMs > 0 ? Math.round((tokens / (genMs / 1000)) * 10) / 10 : null,
      usageReported: completionTokens !== null,
    };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e), totalMs: Math.round(performance.now() - t0) };
  }
}

async function main() {
  const gateways = JSON.parse(await readFile(new URL('../data/gateways.json', import.meta.url), 'utf8'));
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
    const connectivity = await probeConnectivity(gw, key);
    console.error(`[conn] ${gw.id}: ${connectivity.ok ? `${connectivity.latencyMs}ms, ${connectivity.modelCount ?? '?'} models` : connectivity.error}`);
    const models = [];
    for (const model of gw.probeModels ?? []) {
      const samples = [];
      for (let i = 0; i < SAMPLES; i++) samples.push(await probeChatOnce(gw, model, key));
      const summary = summarize(samples);
      console.error(`[chat] ${gw.id}/${model}: ok ${summary.success}/${summary.samples}, ttft p50 ${summary.ttftMs.p50}ms, ${summary.tokensPerSec.avg} tok/s`);
      models.push({ model, ...summary });
    }
    results.push({ gateway: gw.id, skipped: false, connectivity, models });
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
  await mkdir(OUT_DIR, { recursive: true });
  const file = `${OUT_DIR}/${startedAt.slice(0, 10)}T${startedAt.slice(11, 19).replaceAll(':', '')}-${run.region}.json`;
  await writeFile(file, JSON.stringify(run, null, 2));
  console.log(file);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
