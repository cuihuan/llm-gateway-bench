#!/usr/bin/env node
// Gateway-overhead micro-benchmark: how much latency does a self-hosted
// LLM gateway add on top of a direct call?
//
// Method (isolates PURE PROXY OVERHEAD — this is not a load test):
//   1. Start a local mock OpenAI upstream (canned /v1/chat/completions reply,
//      no model inference, no network egress, no API keys).
//   2. Point the gateway under test at the mock as its "openai" provider.
//   3. Fire sequential requests direct-to-mock and through-the-gateway in
//      INTERLEAVED rounds (direct, gateway, direct, gateway, …) so machine
//      noise hits both arms equally; per-round medians, then the
//      median-of-medians is the reported figure.
//   4. overhead = gateway_median − direct_median, reported with IQR spread.
//
// Honest scope: sequential requests on localhost measure added per-request
// latency only — NOT throughput, NOT concurrency behavior, NOT TLS/network
// overhead. Numbers from CI runners are indicative, not lab-grade; the
// harness is deterministic and reproducible (`node probe/overhead.mjs --help`).

import { writeFile, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';

// ---------- pure statistics (unit-tested) ----------

/** p-th percentile (0..100) by linear interpolation; null for empty input. */
export function percentile(samples, p) {
  if (!samples?.length) return null;
  const s = [...samples].sort((a, b) => a - b);
  const idx = (Math.min(100, Math.max(0, p)) / 100) * (s.length - 1);
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (idx - lo);
}

/** Round to 0.01 ms. */
const r2 = (x) => (x == null ? null : Math.round(x * 100) / 100);

/** Summary of one arm's samples (ms). */
export function summarize(samples) {
  return {
    n: samples.length,
    p50: r2(percentile(samples, 50)),
    p90: r2(percentile(samples, 90)),
    p99: r2(percentile(samples, 99)),
    min: r2(Math.min(...samples)),
    max: r2(Math.max(...samples)),
  };
}

/** Per-round medians -> the noise-robust round summary. */
export function roundMedians(rounds) {
  return rounds.map((r) => percentile(r, 50));
}

/**
 * Final verdict for a gateway: median-of-round-medians for each arm and the
 * overhead delta, with IQR of the per-round deltas as the spread estimate.
 */
export function overheadVerdict(directRounds, gatewayRounds) {
  const dm = roundMedians(directRounds);
  const gm = roundMedians(gatewayRounds);
  const deltas = gm.map((g, i) => g - dm[i]);
  return {
    rounds: dm.length,
    direct_ms: r2(percentile(dm, 50)),
    gateway_ms: r2(percentile(gm, 50)),
    overhead_ms: r2(percentile(deltas, 50)),
    overhead_iqr_ms: [r2(percentile(deltas, 25)), r2(percentile(deltas, 75))],
  };
}

// ---------- mock OpenAI upstream ----------

export const MOCK_COMPLETION = {
  id: 'chatcmpl-mock', object: 'chat.completion', created: 0, model: 'mock-model',
  choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 8, completion_tokens: 1, total_tokens: 9 },
};

/** Start the canned upstream; resolves to { server, port }. */
export function startMockUpstream(port = 0) {
  const body = JSON.stringify(MOCK_COMPLETION);
  const server = createServer((req, res) => {
    // drain the request, then answer instantly with a canned completion
    req.resume();
    req.on('end', () => {
      if (req.url.endsWith('/models') || req.url.endsWith('/models/')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-model', object: 'model' }] }));
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(body);
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

// ---------- measurement runner ----------

const REQ_BODY = JSON.stringify({
  model: 'mock-model',
  messages: [{ role: 'user', content: 'ping' }],
  max_tokens: 1,
});

async function once(url, headers) {
  const t0 = performance.now();
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: REQ_BODY,
    signal: AbortSignal.timeout(15_000),
  });
  await res.arrayBuffer();
  const dt = performance.now() - t0;
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return dt;
}

async function burst(url, headers, n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(await once(url, headers));
  return out;
}

/**
 * Interleaved measurement: R rounds of (direct n, gateway n).
 * Returns { directRounds, gatewayRounds, directAll, gatewayAll }.
 */
export async function measure({ directUrl, gatewayUrl, headers = {}, rounds = 5, perRound = 20, warmup = 10 }) {
  await burst(directUrl, {}, warmup);
  await burst(gatewayUrl, headers, warmup);
  const directRounds = [], gatewayRounds = [];
  for (let r = 0; r < rounds; r++) {
    directRounds.push(await burst(directUrl, {}, perRound));
    gatewayRounds.push(await burst(gatewayUrl, headers, perRound));
  }
  return {
    directRounds, gatewayRounds,
    directAll: directRounds.flat(), gatewayAll: gatewayRounds.flat(),
  };
}

// ---------- CLI ----------

function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : dflt;
}

async function main() {
  if (process.argv.includes('--help')) {
    console.log(`Usage: node probe/overhead.mjs --gateway <name> --gateway-url <chat-completions-url> [--api-key sk-x]
       [--mock-port 9010] [--rounds 5] [--per-round 20] [--warmup 10] [--out data/overhead.json]
Requires the gateway under test to be configured with the mock upstream
(http://127.0.0.1:<mock-port>/v1) as its openai-compatible provider.
Special mode: --gateway self-test measures direct-vs-direct (expects ~0 overhead).`);
    return;
  }
  const name = arg('gateway');
  if (!name) throw new Error('--gateway <name> is required (or --help)');
  const mockPort = Number(arg('mock-port', '9010'));
  const { server, port } = await startMockUpstream(mockPort);
  const directUrl = `http://127.0.0.1:${port}/v1/chat/completions`;
  const gatewayUrl = name === 'self-test' ? directUrl : arg('gateway-url');
  if (!gatewayUrl) throw new Error('--gateway-url is required');
  const headers = {};
  const key = arg('api-key');
  if (key) headers.authorization = `Bearer ${key}`;

  const opts = {
    directUrl, gatewayUrl, headers,
    rounds: Number(arg('rounds', '5')),
    perRound: Number(arg('per-round', '20')),
    warmup: Number(arg('warmup', '10')),
  };
  console.error(`[overhead] measuring ${name}: ${opts.rounds} rounds x ${opts.perRound} (+${opts.warmup} warmup) …`);
  const m = await measure(opts);
  server.close();

  const verdict = overheadVerdict(m.directRounds, m.gatewayRounds);
  const entry = {
    name,
    version: arg('gateway-version', null),
    measuredAt: new Date().toISOString(),
    env: { runner: process.env.GITHUB_ACTIONS ? 'github-actions' : 'local', node: process.version, platform: process.platform },
    config: { rounds: opts.rounds, perRound: opts.perRound, warmup: opts.warmup },
    verdict,
    directSummary: summarize(m.directAll),
    gatewaySummary: summarize(m.gatewayAll),
  };

  const outPath = arg('out', 'data/overhead.json');
  let doc = { _comment: 'Gateway per-request overhead vs a local mock OpenAI upstream. Sequential, localhost, interleaved rounds; median-of-round-medians. NOT a throughput/load test. See docs/methodology.md.', unit: 'ms', results: [] };
  try { doc = JSON.parse(await readFile(outPath, 'utf8')); } catch {}
  doc.results = (doc.results ?? []).filter((x) => x.name !== name);
  doc.results.push(entry);
  doc.results.sort((a, b) => (a.verdict.overhead_ms ?? 0) - (b.verdict.overhead_ms ?? 0));
  await writeFile(outPath, JSON.stringify(doc, null, 2) + '\n');
  console.log(`[overhead] ${name}: direct ${verdict.direct_ms}ms -> gateway ${verdict.gateway_ms}ms, overhead ${verdict.overhead_ms}ms (IQR ${verdict.overhead_iqr_ms.join('..')})`);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
