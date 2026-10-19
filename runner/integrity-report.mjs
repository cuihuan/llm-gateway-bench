import { comparison } from './comparison-stats.mjs';
import { median } from './claude-evidence.mjs';

const safe = (v) => String(v ?? '').replace(/[\r\n|]/g, ' ');
const number = (v) => v === null || v === undefined ? 'N/A' : v.toLocaleString('en-US', { maximumFractionDigits: 1 });
const pct = (v) => v === null ? 'N/A' : `${(100 * v).toFixed(1)}%`;
const sum = (ts, key) => ts.length && ts.every((t) => t.evidence?.[key] != null) ? ts.reduce((n, t) => n + t.evidence[key], 0) : null;
const counters = (ts, key) => {
  const all = {};
  for (const t of ts) for (const [k, n] of Object.entries(t.evidence?.[key] || {})) all[k] = (all[k] || 0) + n;
  return Object.entries(all).map(([k, n]) => `${safe(k)} x ${n}`).join(', ') || 'N/A';
};
const values = (ts, key) => [...new Set(ts.map((t) => t.evidence?.[key]).filter((v) => v != null))].sort((a, b) => a - b).map(number).join(', ') || 'N/A';

export function firstInputGate(reference, candidate, expectedReference, expectedCandidate) {
  if (!reference.length || !candidate.length || reference.length !== expectedReference || candidate.length !== expectedCandidate ||
      [...reference, ...candidate].some((t) => !t.evidence?.complete || t.evidence.firstInput == null || !t.evidence.firstDigest)) return 'UNVERIFIED: incomplete evidence';
  for (const task of new Set([...reference, ...candidate].map((t) => t.task))) {
    const a = reference.filter((t) => t.task === task), b = candidate.filter((t) => t.task === task);
    if (!a.length || !b.length) return 'UNVERIFIED: task mismatch';
    const hashes = new Set([...a, ...b].map((t) => t.evidence.firstDigest));
    if (hashes.size !== 1) return 'UNVERIFIED: request digests differ';
    if (new Set([...a, ...b].map((t) => t.evidence.firstInput)).size !== 1) return 'FAIL: token counts differ for matching requests';
  }
  return 'PASS';
}

export function hardGates(trials, expected, model) {
  const covered = trials.length === expected && trials.length > 0 && trials.every((t) => t.evidence?.complete);
  const observed = trials.flatMap((t) => Object.keys(t.evidence?.models || {}));
  const requested = trials.flatMap((t) => Object.keys(t.evidence?.requestedModels || {}));
  const modelMismatch = observed.some((m) => m !== model && m !== '(missing)') || requested.some((m) => m !== model);
  const thinking = sum(trials, 'thinkingBlocks'), signed = sum(trials, 'signedBlocks');
  const badSignature = trials.some((t) => t.evidence?.thinkingBlocks > t.evidence?.signedBlocks);
  const cacheMissing = trials.some((t) => t.cacheRead === 0);
  return {
    model: modelMismatch ? 'FAIL' : !covered || observed.includes('(missing)') ? 'UNVERIFIED' : 'PASS',
    signature: badSignature ? 'FAIL' : !covered || !thinking ? 'UNVERIFIED: no complete thinking sample' : signed === thinking ? 'PASS' : 'FAIL',
    cache: cacheMissing ? 'FAIL' : !trials.length || trials.length !== expected || trials.some((t) => t.cacheRead == null) ? 'UNVERIFIED' : 'PASS',
  };
}

export function integrityReport(jobs, input, perJob) {
  const baselineName = input.baseline?.name || 'SynthorAI';
  const labels = [`${baselineName} A`, `${baselineName} B`, ...(input.candidates || [{ name: 'Candidate 1' }]).map((c) => c.name)];
  const lines = ['## Integrity hard gates', '',
    'Reference status: NO DIRECT OFFICIAL REFERENCE. A and B are repeat runs of the baseline router. Neither configured router is an Anthropic direct API reference; official token equality and official error ceilings remain UNVERIFIED.', ''];
  const table = (rows) => {
    lines.push(`| Check | ${labels.map(safe).join(' | ')} |`, `|---|${labels.map(() => '---').join('|')}|`);
    for (const [label, cells] of rows) lines.push(`| ${label} | ${cells.join(' | ')} |`);
    lines.push('');
  };
  const gates = jobs.map((ts) => hardGates(ts, perJob, input.model));
  const firstGates = jobs.map((ts) => firstInputGate(jobs[0], ts, perJob, perJob));
  table([
    ['Response model matches requested model', gates.map((g) => g.model)],
    ['Every visible thinking block has a signature', gates.map((g) => g.signature)],
    ['Every expected trial has cache hits', gates.map((g) => g.cache)],
    ['First input equals official on identical requests', jobs.map(() => 'UNVERIFIED: official reference unavailable')],
    ['Trial exceptions no greater than official', jobs.map(() => 'UNVERIFIED: official reference unavailable')],
    ['API errors no greater than official', jobs.map(() => 'UNVERIFIED: official reference unavailable')],
    ['First input equals baseline A/B (router comparison)', firstGates],
  ]);
  const failed = gates.some((g) => Object.values(g).some((v) => v.startsWith('FAIL'))) || firstGates.some((v) => v.startsWith('FAIL'));
  lines.push(`Hard-gate result: ${failed ? 'ISSUES DETECTED' : 'UNVERIFIED'}. ${failed ? 'At least one directly observable hard gate failed.' : 'No all-clear is issued without the missing official reference and complete evidence.'}`, '');
  table([
    ['Trials / expected', jobs.map((ts) => `${ts.length}/${perJob}`)],
    ['Complete session evidence (trials)', jobs.map((ts) => `${ts.filter((t) => t.evidence?.complete).length}/${perJob}`)],
    ['Trial exceptions / missing results', jobs.map((ts) => `${ts.filter((t) => t.error).length} / ${Math.max(0, perJob - ts.length)}`)],
    ['API error messages observed by Claude Code', jobs.map((ts) => number(sum(ts, 'apiErrors')))],
    ['API request records / requests without a response', jobs.map((ts) => `${number(sum(ts, 'requestAttempts'))} / ${number(sum(ts, 'unpairedRequests'))}`)],
    ['Response model counts (unique messages)', jobs.map((ts) => counters(ts, 'models'))],
    ['Thinking signature coverage (visible blocks)', jobs.map((ts) => {
      const n = sum(ts, 'thinkingBlocks'), s = sum(ts, 'signedBlocks');
      return n ? `${pct(s / n)} (${s}/${n})` : 'N/A: no visible thinking blocks';
    })],
    ['Redacted thinking with opaque data / blocks', jobs.map((ts) => `${number(sum(ts, 'redactedWithData'))} / ${number(sum(ts, 'redactedBlocks'))}`)],
    ['Trials with cache hits', jobs.map((ts) => `${ts.filter((t) => t.cacheRead > 0).length}/${perJob}`)],
    ['First request total input tokens (all observed values)', jobs.map((ts) => values(ts, 'firstInput'))],
    ['First request uncached input tokens', jobs.map((ts) => values(ts, 'firstUncached'))],
    ['First request cache-read tokens', jobs.map((ts) => values(ts, 'firstCacheRead'))],
    ['First request cache-write tokens', jobs.map((ts) => values(ts, 'firstCacheWrite'))],
    ['Message ID prefixes', jobs.map((ts) => counters(ts, 'prefixes'))],
    ['inference_geo', jobs.map((ts) => counters(ts, 'geo'))],
  ]);
  lines.push('Thinking coverage counts individual visible thinking blocks, not calls; one signed block cannot hide an unsigned block in the same message. A nonempty signature is presence evidence only, not cryptographic verification. Redacted opaque data is listed separately and is not counted as a visible thinking signature.', '',
    'API errors are isApiErrorMessage records observed in the retained Claude Code sessions, not an HTTP wire audit. Request records with no paired response can include retries or compatibility fallback; a zero error-message count does not prove zero upstream HTTP errors.', '',
    'First input = uncached input + cache creation + cache read, taken from the first main-session response and paired to its requestRef. Equality requires the same task and matching request digests, including settings. Different request digests make tokenizer/model substitution conclusions inconclusive. A token mismatch is an investigation signal, not proof of a substituted model.', '',
    'Backend hints are self-reported: msg_011 is commonly associated with Anthropic API and msg_bdrk with Bedrock in the supplied comparison convention. Prefixes and inference_geo do not authenticate a backend. Empty and missing geo are distinguished. A different backend alone is informational; ask the router operator to explain it.', '');

  for (let i = 2; i < jobs.length; i++) {
    lines.push(`## Statistical comparison: ${safe(labels[i])}`, '');
    lines.push(`| Metric (trial means) | ${safe(labels[0])} | ${safe(labels[1])} | ${safe(labels[i])} | A/A change | A/B change | p | Interpretation |`, '|---|---:|---:|---:|---:|---:|---:|---|');
    const mapped = [jobs[0], jobs[1], jobs[i]].map((ts) => ts.map((t) => {
      const e = t.evidence;
      return { task: t.task, pass: t.error ? 0 : t.reward == null ? null : t.reward === 1 ? 1 : 0,
        calls: e?.complete ? e.calls : null, tools: e?.tools ?? t.toolCalls, seconds: t.seconds,
        callSeconds: e?.callSeconds ?? null, input: e?.input ?? t.input,
        cacheRate: t.input > 0 && t.cacheRead != null && t.cacheRead <= t.input ? t.cacheRead / t.input : null,
        output: e?.output ?? t.output, thinkingTokens: e?.thinkingTokens ?? null, thinkingShare: e?.thinkingShare ?? null };
    }));
    for (const [label, key, proportion] of [
      ['Task pass rate', 'pass', true], ['API calls (unique response messages)', 'calls', false],
      ['Tool calls', 'tools', false], ['Agent time (s)', 'seconds', false],
      ['Call duration, trial median (s, log estimate)', 'callSeconds', false], ['Input tokens including cache', 'input', false],
      ['Cache hit rate', 'cacheRate', true], ['Output tokens', 'output', false],
      ['Thinking tokens', 'thinkingTokens', false], ['Calls containing thinking', 'thinkingShare', true],
    ]) {
      const stats = mapped.map((ts) => ts.length === perJob ? ts : []);
      const c = comparison(...stats, key, proportion);
      const change = (v) => v === null ? 'N/A' : proportion ? `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)} pp` : `${v >= 0 ? '+' : ''}${(v * 100).toFixed(0)}%`;
      lines.push(`| ${label} | ${c.means.map(proportion ? pct : number).join(' | ')} | ${change(c.aa)} | ${change(c.ab)} | ${c.p === null ? 'N/A' : c.p.toFixed(4)} | ${c.verdict} |`);
    }
    lines.push('', 'A/A = B minus A; A/B = candidate minus pooled A+B. Percentage metrics use percentage points; other changes are relative (N/A for a zero denominator; absolute changes are then used for the variation check). The two-sided permutation test shuffles trial labels within each task (exact at up to 100,000 permutations; otherwise 10,000 seeded draws). A difference is flagged only at p < 0.05 and beyond the observed A/A change. Missing metrics or fewer than two trials per group remain inconclusive. These ten exploratory tests are not corrected for multiple comparisons; no clear difference is not evidence of equivalence.', '',
      'Call duration uses the paired api-request timestamp through the last logged response block; it is a session-log estimate, not wire latency or time to first token. Unpaired calls remain N/A. Usage and thinking token counts are upstream-reported.', '');
  }
  lines.push('## Per-trial integrity evidence', '', '| Group | Task | Trial | Pass | Exception | API errors | First input | First request digest | Thinking signed / visible | Cache hit |', '|---|---|---|---|---|---:|---:|---|---|---|');
  jobs.forEach((ts, i) => ts.forEach((t, j) => {
    const e = t.evidence;
    lines.push(`| ${safe(labels[i])} | ${safe(t.task)} | ${safe(t.id || j + 1)} | ${t.reward == null ? 'N/A' : !t.error && t.reward === 1 ? 'Yes' : 'No'} | ${safe(t.error || 'None')} | ${number(e?.apiErrors)} | ${number(e?.firstInput)} | ${e?.firstDigest || 'N/A'} | ${number(e?.signedBlocks)} / ${number(e?.thinkingBlocks)} | ${t.cacheRead == null ? 'N/A' : t.cacheRead > 0 ? 'Yes' : 'No'} |`);
  }));
  lines.push('', '## First-request task check', '', `| Task | ${labels.map(safe).join(' | ')} |`, `|---|${labels.map(() => '---').join('|')}|`);
  for (const task of new Set(jobs.flat().map((t) => t.task))) {
    lines.push(`| ${safe(task)} | ${jobs.map((ts) => {
      const tt = ts.filter((t) => t.task === task), inputs = tt.map((t) => t.evidence?.firstInput).filter((v) => v != null);
      return `${tt.filter((t) => !t.error && t.reward === 1).length}/${tt.length} passed; first input median ${number(median(inputs))}`;
    }).join(' | ')} |`);
  }
  return [...lines, ''];
}
