const valid = (v) => typeof v === 'number' && Number.isFinite(v);
export const average = (values) => values.length && values.every(valid) ? values.reduce((a, b) => a + b, 0) / values.length : null;

function choose(n, k) {
  let result = 1;
  for (let i = 1; i <= k; i++) result = result * (n - i + 1) / i;
  return Math.round(result);
}

// Stratify by task and permute trial labels, not individual API calls.
// Enumerate small samples exactly; use reproducible add-one Monte Carlo otherwise.
export function permutationP(baseline, candidate, key, rounds = 10000) {
  if (baseline.length < 2 || candidate.length < 2 || [...baseline, ...candidate].some((t) => !valid(t[key]))) return null;
  const tasks = [...new Set([...baseline, ...candidate].map((t) => t.task))].sort();
  const strata = tasks.map((task) => {
    const a = baseline.filter((t) => t.task === task), b = candidate.filter((t) => t.task === task);
    return { values: [...a, ...b].map((t) => t[key]), k: b.length, na: a.length };
  });
  if (strata.some((s) => !s.k || !s.na)) return null;
  const total = [...baseline, ...candidate].reduce((s, t) => s + t[key], 0);
  const observed = Math.abs(average(candidate.map((t) => t[key])) - average(baseline.map((t) => t[key])));
  const extreme = (sumB) => Math.abs(sumB / candidate.length - (total - sumB) / baseline.length) >= observed - 1e-10;
  const possibilities = strata.reduce((n, s) => n * choose(s.values.length, s.k), 1);
  let hits = 0;
  if (possibilities <= 100000) {
    const enumerate = (si, sumB) => {
      if (si === strata.length) { if (extreme(sumB)) hits++; return; }
      const { values, k } = strata[si];
      const select = (start, left, sum) => {
        if (!left) { enumerate(si + 1, sumB + sum); return; }
        for (let i = start; i <= values.length - left; i++) select(i + 1, left - 1, sum + values[i]);
      };
      select(0, k, 0);
    };
    enumerate(0, 0);
    return hits / possibilities;
  }
  let state = 123456789;
  const random = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) / 4294967296; };
  for (let round = 0; round < rounds; round++) {
    let sumB = 0;
    for (const { values, k } of strata) {
      const shuffled = [...values];
      for (let i = shuffled.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]; }
      sumB += shuffled.slice(0, k).reduce((a, b) => a + b, 0);
    }
    if (extreme(sumB)) hits++;
  }
  return (hits + 1) / (rounds + 1);
}

export function comparison(a, b, candidate, key, proportion = false) {
  const means = [a, b, candidate, [...a, ...b]].map((ts) => average(ts.map((t) => t[key])));
  const [ma, mb, mn, pooled] = means;
  const change = (x, y) => x === null || y === null || (!proportion && x === 0) ? null : proportion ? y - x : (y - x) / x;
  const aa = change(ma, mb), ab = change(pooled, mn);
  const p = permutationP([...a, ...b], candidate, key);
  const beyondRepeat = aa !== null && ab !== null ? Math.abs(ab) > Math.abs(aa)
    : means.every(valid) && Math.abs(mn - pooled) > Math.abs(mb - ma);
  const verdict = p === null || a.length < 2 || b.length < 2 ? 'Insufficient data'
    : p < 0.05 && beyondRepeat ? 'Difference detected'
      : p < 0.05 ? 'Within A/A variation' : 'No clear difference';
  return { means: means.slice(0, 3), aa, ab, p, verdict };
}
