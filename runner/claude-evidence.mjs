import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { createHash } from 'node:crypto';

const num = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
const timestamp = (v) => typeof v === 'string' && Number.isFinite(Date.parse(v)) ? Date.parse(v) : null;
const hash = (v) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const digest = (v) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v) ? v : null;
const sum = (values) => values.length && values.every((v) => v !== null) ? values.reduce((a, b) => a + b, 0) : null;
const count = (values) => Object.fromEntries([...new Set(values)].sort().map((v) => [v, values.filter((x) => x === v).length]));
export const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2 : null;
};

async function sessionFiles(directory) {
  let entries;
  try { entries = await fsp.readdir(directory, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const files = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sessionFiles(file));
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(file);
  }
  return files;
}

// Read raw evidence locally; return only counters and digests, never prompts,
// thinking text, signatures, credentials, complete message IDs or tool arguments.
export async function readClaudeEvidence(directory) {
  const files = await sessionFiles(directory);
  const calls = new Map(), requests = new Map(), errors = new Set();
  let malformed = 0;
  for (const file of files) {
    let lineNumber = 0;
    const lines = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
    for await (const line of lines) {
      lineNumber++;
      if (!line.trim()) continue;
      let e;
      try { e = JSON.parse(line); } catch { malformed++; continue; }
      if (!e || typeof e !== 'object') { malformed++; continue; }
      if (e.isApiErrorMessage) errors.add(e.uuid || `${file}:${lineNumber}`);
      if (e.type === 'api-request' && typeof e.id === 'string') {
        requests.set(e.id, { start: timestamp(e.timestamp), digest: digest(e.requestDigest) });
      }
      const m = e.message;
      if (e.type !== 'assistant' || !m || m.model === '<synthetic>' || e.isApiErrorMessage) continue;
      if (typeof m.id !== 'string' || !m.id) { malformed++; continue; }
      const c = calls.get(m.id) || { id: m.id, blocks: new Map(), usage: {}, model: null, requestedModels: new Set(),
        refs: new Set(), end: null, firstSeen: null, main: false };
      c.model = typeof m.model === 'string' ? m.model : null;
      if (typeof e.requestedModel === 'string') c.requestedModels.add(e.requestedModel);
      if (typeof e.requestRef === 'string') c.refs.add(e.requestRef);
      c.usage = { ...c.usage, ...(m.usage || {}) };
      const time = timestamp(e.timestamp);
      if (time !== null) { c.end = Math.max(c.end ?? time, time); c.firstSeen = Math.min(c.firstSeen ?? time, time); }
      c.main ||= !file.split(path.sep).includes('subagents') && !e.isSidechain;
      if (!Array.isArray(m.content)) malformed++;
      else for (const [i, b] of m.content.entries()) {
        if (!b || typeof b !== 'object') { malformed++; continue; }
        // Claude emits one record per block. apiBlockIndex deduplicates replayed
        // records without letting a signed block mask another unsigned block.
        const key = Number.isInteger(e.apiBlockIndex) ? `index:${e.apiBlockIndex + i}`
          : b.type === 'tool_use' && b.id ? `tool:${b.id}` : `content:${hash(b)}`;
        c.blocks.set(key, { type: b.type, signed: typeof b.signature === 'string' && Boolean(b.signature.trim()),
          opaque: typeof b.data === 'string' && Boolean(b.data.trim()) });
      }
      calls.set(m.id, c);
    }
  }
  const messages = [...calls.values()];
  const complete = files.length > 0 && messages.length > 0 && malformed === 0;
  const usedRefs = new Set(messages.flatMap((c) => [...c.refs]));
  const ordered = messages.filter((c) => c.main).sort((a, b) => {
    const start = (c) => Math.min(...[...c.refs].map((ref) => requests.get(ref)?.start).filter((v) => v != null), c.firstSeen ?? Infinity);
    return start(a) - start(b);
  });
  const first = ordered[0];
  const firstRequest = first?.refs.size === 1 ? requests.get([...first.refs][0]) : null;
  const totalInput = (usage) => sum(['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'].map((key) => num(usage[key])));
  const blocks = messages.flatMap((c) => [...c.blocks.values()]);
  const thinking = blocks.filter((b) => b.type === 'thinking');
  const redacted = blocks.filter((b) => b.type === 'redacted_thinking');
  const durations = messages.map((c) => {
    const request = c.refs.size === 1 ? requests.get([...c.refs][0]) : null;
    return request?.start != null && c.end !== null && c.end >= request.start ? (c.end - request.start) / 1000 : null;
  });
  return {
    complete, files: files.length, malformed, calls: messages.length || null,
    requestAttempts: requests.size || null,
    unpairedRequests: requests.size ? [...requests.keys()].filter((ref) => !usedRefs.has(ref)).length : null,
    apiErrors: files.length && !malformed ? errors.size : null,
    models: count(messages.map((c) => c.model || '(missing)')),
    requestedModels: count(messages.flatMap((c) => [...c.requestedModels])),
    prefixes: count(messages.map((c) => c.id.startsWith('msg_bdrk') ? 'msg_bdrk' : c.id.slice(0, 7))),
    geo: count(messages.map((c) => Object.hasOwn(c.usage, 'inference_geo') ? c.usage.inference_geo === '' ? '(empty)' : String(c.usage.inference_geo) : '(missing)')),
    thinkingBlocks: messages.length ? thinking.length : null,
    signedBlocks: messages.length ? thinking.filter((b) => b.signed).length : null,
    redactedBlocks: messages.length ? redacted.length : null,
    redactedWithData: messages.length ? redacted.filter((b) => b.opaque).length : null,
    thinkingShare: complete ? messages.filter((c) => [...c.blocks.values()].some((b) => ['thinking', 'redacted_thinking'].includes(b.type))).length / messages.length : null,
    thinkingTokens: complete ? sum(messages.map((c) => num(c.usage.output_tokens_details?.thinking_tokens))) : null,
    input: complete ? sum(messages.map((c) => totalInput(c.usage))) : null,
    cacheRead: complete ? sum(messages.map((c) => num(c.usage.cache_read_input_tokens))) : null,
    output: complete ? sum(messages.map((c) => num(c.usage.output_tokens))) : null,
    tools: complete ? blocks.filter((b) => b.type === 'tool_use').length : null,
    callSeconds: complete && durations.every((v) => v !== null) ? median(durations) : null,
    timingCoverage: durations.filter((v) => v !== null).length,
    firstInput: first ? totalInput(first.usage) : null,
    firstUncached: first ? num(first.usage.input_tokens) : null,
    firstCacheRead: first ? num(first.usage.cache_read_input_tokens) : null,
    firstCacheWrite: first ? num(first.usage.cache_creation_input_tokens) : null,
    firstDigest: firstRequest?.digest ?? null,
  };
}
