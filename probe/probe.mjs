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
import { summarize, evalToolCall, evalModelEcho, evalCjkIntegrity, evalNeedle } from './metrics.mjs';

const args = process.argv.slice(2);
function flag(name, fallback) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
}

/** CLI 用法说明（--help / -h） */
export function usage() {
  return `llm-gateway-bench 拨测器 — 黑盒拨测 OpenAI 兼容网关/端点

用法:
  node probe/probe.mjs [选项]

选项:
  --gateway <id>     只测 data/gateways.json 里的某个网关（默认全测）
  --url <baseUrl>    临时拨测任意端点，免改配置；key 从环境变量读（见 --auth-env）
  --model <id[,id]>  配合 --url：要拨测的模型，逗号分隔
  --auth-env <NAME>  配合 --url：存 key 的环境变量名（默认 PROBE_KEY）
  --name <name>      配合 --url：结果里显示的网关名（默认取 host）
  --samples <n>      每个模型的采样次数（默认 3，多采样取分位数）
  --out <dir>        结果落盘目录（默认 out/；--url 模式默认只打印不落盘）
  -h, --help         显示本帮助

环境:
  <网关>.authEnv     各网关的 key 环境变量名见 data/gateways.json（缺 key 自动跳过）
  PROBE_REGION       探测地域标签，写进结果（如 gh-us / local-cn）

示例:
  # 临时测某端点的一个模型（结果打到 stdout，不落盘）
  PROBE_KEY=sk-... node probe/probe.mjs --url https://api.example.com --model gpt-4o-mini --samples 3
  # 测配置里的某网关并落盘，供聚合
  SYNTHORAI_API_KEY=sk-... node probe/probe.mjs --gateway synthorai --out data/results

每次拨测同时测：流式 TTFT/吞吐、成功率、工具调用转发、假流式、CJK 完整性、
上下文截断、模型回显、usage 重算。判定逻辑见 probe/metrics.mjs（纯函数+单测）。`;
}
const SAMPLES = Number(flag('samples', 3));
const OUT_DIR = flag('out', 'out');
const ONLY_GATEWAY = flag('gateway', null);

/**
 * 临时网关：用 --url 直接拨测任意 OpenAI 兼容端点，免改 data/gateways.json。
 * key 从环境变量读（默认 PROBE_KEY，可用 --auth-env 指定），不走命令行避免泄露。
 * 返回 gateway 对象，或 url 缺失时 null。
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
// llmperf 惯例：让模型生成到 max_tokens 上限的固定任务，而不是一句 "pong"——
// 否则输出只有 2-3 个 chunk，tok/s 是除以几毫秒的噪声，假流式检测也凑不够样本。
// 随机串防网关侧缓存（docs/research.md 工程红线）。
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
    const genMs = totalMs - ttftMs;
    // Fall back to chunk count when the gateway omits usage in streams.
    const tokens = completionTokens ?? chunks;
    return {
      ok: true,
      ttftMs: Math.round(ttftMs),
      totalMs: Math.round(totalMs),
      tokensPerSec: genMs > 0 ? Math.round((tokens / (genMs / 1000)) * 10) / 10 : null,
      usageReported: completionTokens !== null,
      chunks,
      // 首个内容 chunk 到末个内容 chunk 的时间窗——假流式检测的核心指纹
      streamWindowMs: Math.round(lastContentAt - (t0 + ttftMs)),
      // usage 重算指纹：固定 prompt 下网关上报的 token 数 + 实收正文字符数。
      // 同模型若某网关 charsPerToken 异常偏低 = 虚报 token；promptTokens 远超
      // 同模型基线 = 隐藏 system prompt 注入。需基线对照，先把原始信号沉淀进数据。
      promptTokens,
      completionTokens,
      outputChars,
      // 模型回显：响应里的 model 字段，与请求 model 比对揪偷换（零成本）
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

// 一发非流式补全，取回正文文本（CJK / needle 探针共用）。
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

// CJK 输出完整性探针（量化/降智 tell）：要求一句中文，检查未损坏。
async function probeCjk(gw, model, key) {
  try {
    const r = await chatOnceText(gw, model, key, `用中文写一句关于今天天气的话，只输出这句话。忽略请求号 ${Math.random().toString(36).slice(2, 8)}`, 64);
    if (!r.ok) return { ok: false, error: r.error };
    const v = evalCjkIntegrity(r.text);
    return v.ok ? { ok: true } : { ok: false, error: v.reason };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

// 上下文截断探针：长填充里埋唯一 UUID needle，要求原样回读；截断则丢失。
async function probeNeedle(gw, model, key) {
  const needle = `NDL-${Math.random().toString(36).slice(2, 10).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
  // ~3.5K token 的填充（每行约 11 token × 320 行）；needle 埋在前 12% 处——
  // 若网关从尾部保留窗口截断，needle 会落在切点前而丢失。
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
 * 跑完一个网关的全套黑盒探针：连通性 + 每个模型的流式多采样 / 工具调用 /
 * CJK / needle。compare.mjs 与 main() 共用同一实现（单一来源——上线拨测的
 * 就是被对比的）。进度打到 stderr；samples 为每模型采样次数。
 * 返回 { connectivity, models:[{ model, ...summary, toolCall, cjk, needle }] }。
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
    console.error(`[chat] ${gw.id}/${model}: ok ${summary.success}/${summary.samples}, ttft p50 ${summary.ttftMs.p50}ms, ${summary.tokensPerSec.avg} tok/s, tool ${toolCall.ok ? '✓' : '✗'}, cjk ${cjk.ok ? '✓' : `✗(${cjk.error})`}, needle ${needle.ok ? '✓' : `✗(${needle.error})`}`);
    models.push({ model, ...summary, toolCall, cjk, needle });
  }
  return { connectivity, models };
}

async function main() {
  if (args.includes('--help') || args.includes('-h')) { console.log(usage()); return; }
  const adhoc = adhocGateway({ url: flag('url', null), model: flag('model', null), name: flag('name', null), authEnv: flag('auth-env', null) });
  if (adhoc && !adhoc.probeModels.length) {
    console.error('[probe] --url 需要配合 --model <id[,id2]>（要拨测哪个模型）');
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
  // 临时拨测（--url）只打印结果，不污染 data/results；显式 --out 仍会落盘。
  if (adhoc && flag('out', null) === null) {
    console.log(JSON.stringify(run, null, 2));
    return;
  }
  await mkdir(OUT_DIR, { recursive: true });
  const file = `${OUT_DIR}/${startedAt.slice(0, 10)}T${startedAt.slice(11, 19).replaceAll(':', '')}-${run.region}.json`;
  await writeFile(file, JSON.stringify(run, null, 2));
  console.log(file);
}

// 仅作为脚本直接运行时执行 main；被 import（如单测）时不自动跑。
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
