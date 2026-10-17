# Router Terminal-Bench console

## Goal

Provide a hosted console at `/benchmark/testRouter/` where an operator can compare an official Anthropic-compatible endpoint with a new endpoint using the same Terminal-Bench task and model, observe progress, and retain auditable reports without retaining API keys.

## Requirements

- Accept official/new base URLs, API keys, model, task, and trials per arm.
- Run official A, official B, and new jobs concurrently through Harbor.
- Persist status, timestamps, redacted configuration, logs, and the generated report.
- Never persist, log, echo, or include API keys in process arguments.
- List past runs, inspect a run, cancel an active run, and download its report/artifacts.
- Limit concurrency and reject loopback/private-network targets to prevent SSRF.
- Require a deployment access token when configured.

## Acceptance criteria

- [ ] `/benchmark/testRouter/` supports create, progress, history, cancellation, and downloads.
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

