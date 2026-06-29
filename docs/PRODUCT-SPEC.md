# Product refactor spec (PRODUCT SPEC) · llm-gateway-bench

> This document is the master spec for the refactor. Positioning, architecture, data contracts, monetization, and roadmap all defer to it;
> implementations and PRs must align with it, and any deviation means changing this document first, then the code (the spec principle).
> Drafted 2026-06-23. It **does not overturn** the existing probe engine and unit tests; it adds a product layer on top.

## 0. One sentence

Flip the project from "a **leaderboard** the maintainer pre-measures for you" to "a **tool** anyone can self-test with + a shareable **report platform**",
with the public leaderboard relegated to an **authoritative reference baseline**, monetized via hosted probing / report hosting / a wrapper over each vendor's SDK,
and over the long term driving traffic to the main project via the report footer.

## 1. Pain-points to solve (in the user's own words)

1. **No way to test when onboarding a gateway**: about to plug in a new gateway/relay, with no handy tool to compare it side by side (vs OpenRouter vs others).
   → Deliver a **self-serve comparison tool**: specify multiple targets + your own key, run the full black-box suite in one shot, get a side-by-side comparison.
2. **No good evaluation reports**: dimensions like price and long context lack a trustworthy, reproducible, shareable report.
   → Deliver a **portable report**: self-contained HTML + structured JSON, generated locally, publishable to the gallery.
3. **Reports are shareable**: a user willing to share can share to the platform, and other users can view it.
   → Deliver a **report gallery**: a shared report is just a file (data-as-repo), rendered by static pages; add an upload endpoint later.

## 2. The two product pillars

### Pillar A · Tool (self-serve tool)
- Command: `gwbench compare` (implemented as `probe/compare.mjs`, npm script `compare`).
- Input: a compare spec — multiple targets `{name, baseUrl, authEnv, model}` + a logical model label.
- Behavior: run the **existing full black-box probe suite** against each target (connectivity, streaming TTFT/throughput multi-sample, tool calls,
  fake streaming, model echo, CJK integrity, long-context needle), reusing `probeGateway()` extracted from `probe.mjs`.
- Output:
  - `report.json` — a structured comparison result (schema in §4), ingestible by the gallery/platform;
  - `report.html` — a **self-contained** single file (embedded data + styles), opens directly via file://, sendable to others.
- Red line: **keys live only in environment variables, never enter the report, never leave the machine** (privacy is a core selling point for CN users).

### Pillar B · Report (report platform)
- **Public baseline reports**: the leaderboard produced by the maintainer's 6h cron probing (the status quo) continues, serving as the self-test comparison baseline.
- **User-shared reports**: a user generates locally → opts to make it public → it lands as a `web/reports/<id>.json` file
  (Phase 2 via PR; Phase 4 via an upload endpoint), with the static gallery page `web/reports.html` rendering the list + detail.
- **Report categories** (the top-level navigation and gallery filter dimensions):
  price · long context · stability · compliance & security · behavioral fingerprints (substitution/fake streaming/truncation).

## 3. Architecture (keep "serverless, data-as-repo", add a thin backend on demand)

```
Local (the user's machine, the user's own key)
  gwbench compare  ──►  report.json + report.html        ← Pillar A, purely local, zero backend
        │  (the user opts to share)
        ▼
web/reports/<id>.json  ──►  web/reports.html gallery static render  ← Pillar B, data-as-repo
        ▲
        │  Phase 4: a thin upload endpoint (Cloudflare Worker / Vercel + KV) + payment
Maintainer cron (status quo) ──► data/results/ ──► aggregate ──► web/data.json ──► leaderboard (authoritative baseline)
```

- Phases 1–3 are **fully serverless** and can ship immediately;
- Phase 4 is when a thin backend is introduced (only for "upload-share + payment"), without breaking the purely static form of the first three phases.

## 4. Report data contract (report.json schema v1)

```jsonc
{
  "schema": "gwbench-report/1",
  "kind": "compare",                 // compare | longcontext | stability | ...
  "generatedAt": "2026-06-23T..Z",
  "tool": { "name": "gwbench", "version": "0.2.0" },
  "model": "gpt-4o-mini",            // the logical model being compared
  "region": "local-cn",              // probe-viewpoint label (PROBE_REGION)
  "samplesPerTarget": 3,
  "targets": [                       // one item per measured target
    {
      "name": "OpenRouter", "host": "openrouter.ai",
      "ttftMs": { "p50": 510, "p95": 880 }, "tokensPerSec": 47.2,
      "successRate": 1, "toolCall": true, "burstStream": false,
      "modelEcho": true, "cjk": true, "needle": true,
      "usage": { "promptTokens": 21, "charsPerToken": 3.8 },
      "error": null
    }
  ],
  "comparison": {                    // computed by the buildComparison() pure function
    "fastestTtft": "OpenRouter",
    "highestThroughput": "...",
    "flags": [ { "target": "...", "flag": "burstStream", "severity": "warn" } ]
  }
}
```

- The private parts of key, Authorization, and baseUrl **must not** enter the report (only the host is kept).
- `comparison` does no black-box weighted score; it only gives the objective derivation of "who's fastest/best-value/who triggered which red flags".

## 5. Monetization model (aligned with the product pillars)

| Layer | Free | Paid |
|---|---|---|
| Tool | Run locally, with your own key, unlimited | — |
| Hosted probing | — | **We run the expensive jobs on our own infra/key** (128K long-context needle, K2-style diff against the official, model-identity fingerprint), so users don't burn their own tokens or configure an environment |
| Report hosting | Public sharing to the gallery | **Pro reports**: private/branded, scheduled re-tests, change alerts |
| Unified client | — | A unified benchmark client that **wraps each vendor's SDK** (one interface for CN users to compare many vendors), billed by license / call volume |
| Traffic | Every report's footer + CTA → the main project | — |

## 6. Roadmap (each phase ships, tests, and commits independently)

- **Phase 0 · Spec**: this document. ✅
- **Phase 1 · Tool MVP**: extract `probeGateway()`; the `compare.mjs` comparison runner;
  `report.mjs` pure functions (`buildComparison` + `renderReportHtml`) + unit tests; `npm run compare`. ✅
- **Phase 2 · Report gallery**: `web/reports.html` statically renders `web/reports/*.json` (iframe srcdoc reuses
  `renderReportHtml`, pixel-identical to the CLI); `scripts/publish-report.mjs` archive+manifest; navigation hookup; sample reports. ✅
- **Phase 3 · Long-context report**: `longcontext.mjs` multi-length × multi-depth needle heatmap, kind=longcontext
  reusing the report gallery; `npm run longcontext`; sample report. ✅
- **Phase 3b · Classic-model × gateway matrix (flagship report, the user's top priority)**:
  - **Price matrix** kind=pricematrix: `aggregate` pivots data/prices.json (public pricing, **no key needed**) into a real
    "model × gateway price comparison" (`web/reports/price-matrix.json`), marking each model's cheapest gateway, refreshing with prices. ✅ Real data live.
  - **Speed/stability/fingerprint matrix** `npm run matrix` (`probe/matrix.mjs`): each classic model runs the full black-box suite across all gateways with a key,
    generated only with ≥2 gateways, wired into the 6h CI. ✅ Engine ready; **needs multi-gateway keys configured in CI + aliases added in tracked-models to produce real data**.
- **Phase 4 · Site and monetization scaffolding**: `pricing.html` four-tier pricing (self-serve free/hosted probing/Pro hosting/wrapped SDK);
  homepage self-serve comparison CTA. ✅
  - **Phase 4b · Sharing and payment (serverless monetization)**: decision = stay serverless; the report has a built-in 'download JSON / share to gallery' entry
    (`renderReportHtml`, pure front-end); payment goes through a payment link (once you have the link, just swap the href of the `pricing.html` placeholder CTA, no backend needed). ✅
- **Phase 5 · Traffic**: decision = point to the GitHub repo first; `pricing.html`'s 'about this platform' section + report footer CTA are wired in
  (comments mark the main-project-URL replacement point). ✅ (placeholder). Remaining: a share-card OG image, replace once the main-project URL is in hand.

> Next (can proceed once the user provides info): ① replace the placeholder CTA with a real payment link; ② replace the main-project-URL traffic placeholder;
> ③ actually land hosted probing (the Phase 1/3 probes are ready; what's missing is keys + scheduling on our side); ④ a unified client wrapping each vendor's SDK.

## 7. Invariants (engineering red lines, carried over from the status quo and extended)

- Pure functions + unit tests: all decision/aggregation/report-building logic goes in pure functions and must have unit tests (carrying over `probe/*.test.mjs`).
- Single source: the deployed algorithm == the tested algorithm (e.g. `web/calc.mjs` is shared by the browser and the unit tests).
- Zero keys in repo / zero keys in report: only environment variables are recognized; the report keeps only the host.
- No black-box score: each dimension is its own column; the only derived quantities are the price index and "who's fastest/best-value".
- Reproducible: probe prompts, thresholds, and raw data are public, with randomization to defeat caching.
