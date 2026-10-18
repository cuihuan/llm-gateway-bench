# Router Terminal-Bench console

## Goal

Provide a hosted console at `/benchmark/testRouter/` where an operator can compare the fixed SynthorAI and NIBRoute routers using the same Terminal-Bench task and model, observe progress, and retain auditable reports without retaining API keys.

## Requirements

- Pin SynthorAI (`https://synthorai.io`) as the A/A baseline and NIBRoute (`https://api.aws.nibroute.xyz`) as the candidate; never accept operator-supplied endpoint URLs.
- Accept only the two router API keys, shared model, task, and trials per job.
- Run SynthorAI A, SynthorAI B, and NIBRoute concurrently through Harbor.
- Select Claude Code for Claude models and Codex for non-Claude OpenAI-compatible models.
- Keep all operator-facing UI copy, API errors, and generated reports in English.
- Run jobs entirely on the server after creation so closing the browser does not interrupt them.
- Persist status, timestamps, redacted configuration, logs, and the generated report.
- Never persist, log, echo, or include API keys in process arguments.
- List past runs, inspect a run, cancel an active run, and download its report/artifacts.
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

