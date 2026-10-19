# Router Terminal-Bench console

## Goal

Provide a hosted console at `/benchmark/testRouter/` where an operator can compare the fixed SynthorAI and NIBRoute routers using the same Terminal-Bench task and model, observe progress, and retain auditable reports without retaining API keys.

## Requirements

- Support a reversible production report-visibility switch. When enabled, omit finished comparisons from history, deny finished-run detail and every report download with 404, and close/clear report previews when the UI refreshes. Preserve stored jobs, report files and the ability to track active runs. New completed reports remain hidden until the switch is disabled.
- Pin SynthorAI (`https://synthorai.io`) as the A/A baseline and NIBRoute (`https://api.aws.nibroute.xyz`) as the candidate; never accept operator-supplied endpoint URLs.
- Accept only the two router API keys, shared model, task, and trials per job.
- Run SynthorAI A, SynthorAI B, and NIBRoute concurrently through Harbor.
- Select Claude Code for Claude models and Codex for non-Claude OpenAI-compatible models.
- Keep all operator-facing UI copy, API errors, and generated reports in English.
- Run jobs entirely on the server after creation so closing the browser does not interrupt them.
- Persist status, timestamps, redacted configuration, logs, and the generated report.
- Never persist, log, echo, or include API keys in process arguments.
- List past runs, inspect a run, cancel an active run, and download its report/artifacts.
- Preview completed reports inline in an accessible dialog with comparison tables, loading/error states, and a Markdown download. Render report content as escaped text; never execute embedded HTML.
- Reports compare three dimensions: performance, price/cache, and quality/governance. Pool baseline A/B by router, report total and normalized costs, token-weighted cache-read hit rate, independent verifier passes/rewards, and execution/accounting exceptions. Keep missing usage as N/A. Agent/Harbor costs are estimates; actual billed spend is unavailable without provider billing evidence. Do not equate a single task score with general intelligence.
- Read Claude Code session JSONL for unique response models, per-block visible thinking signature presence, first main-response input (uncached + cache write + cache read), paired request digests, cache-hit trials, observed API errors, unpaired request records, message ID prefixes, and inference_geo. Exclude synthetic messages; deduplicate split/replayed blocks and usage. Never copy raw prompts, signatures or thinking text into reports.
- Hard gates use PASS / FAIL / UNVERIFIED. No thinking is unverified, not 100% signed. Require complete trial coverage. First-token equality requires matching task and request digests; settings differences are inconclusive. The fixed routers are not a direct official reference, so official equality and official error ceilings must remain unverified. Backend prefixes are hints, not authenticated identity.
- Include ten statistical rows with separate A/B repeats, pooled-baseline versus candidate changes, two-sided task-stratified trial permutation p values and A/A variation. Exact enumeration for small samples, deterministic Monte Carlo for larger samples. Missing evidence remains N/A; no statistical difference does not establish equivalence. Session timestamp durations are estimates, not network timings.
- Generate an evidence report even when Harbor results include exceptions or missing trials. Keep failed status and allow report preview/download for failed runs.
- Include the run ID, UTC generation time and original trial directory IDs in evidence reports so downloads can be traced to the retained execution artifacts.
- Flag inconsistent first-input totals within repeated identical logged requests even without an official reference. Expose visible thinking text paired with a zero upstream thinking-token counter as a telemetry discrepancy, not evidence of zero reasoning or model substitution.
- Keep the latest nine-trial run when cleaning up the two historical pilot runs. Archive the two exact pilot directories outside the visible run store so deletion is recoverable; do not remove the current run or implement automatic deletion of future runs.
- Limit concurrency and reject loopback/private-network targets to prevent SSRF.
- Let an operator start a run by entering only the two router API keys; do not require a separate console token.

## Acceptance criteria

- [ ] `/benchmark/testRouter/` requires no endpoint setup and supports model/task selectors, create, progress, history, cancellation, and downloads.
- [ ] The page and API do not require a separate operator access token.
- [ ] The backend ignores caller-supplied routes and always selects the two pinned routers.
- [ ] The operator UI, surfaced API errors, and generated report contain no CJK copy.
- [ ] A no-model Harbor smoke run completes a real task container and verifier on the production host.
- [ ] Every API route has automated tests, including auth and validation failures.
- [ ] A mock Harbor executable can exercise the lifecycle without paid calls.
- [ ] Stored JSON contains no supplied API key.
- [ ] Production deployment remains an explicit manual step.

## Out of scope

- Multi-user accounts and billing.
- Storing reusable gateway credentials.
- Automatically changing DNS or production nginx.
- Public unauthenticated benchmark execution.

## Technical notes

- Existing repository is zero-dependency Node.js and static GitHub Pages.
- Terminal-Bench needs Docker and a long-running host, so this feature adds a zero-dependency Node runner service.
- `benchmark.runixcloud.io` has no DNS record as of 2026-10-17.
- Keys are passed to Harbor only through child-process environment variables.

