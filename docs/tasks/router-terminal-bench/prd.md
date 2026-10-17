# Router Terminal-Bench console

## Goal

Provide a hosted console at `/benchmark/testRouter/` where an operator can compare an official Anthropic-compatible endpoint with a new endpoint using the same Terminal-Bench task and model, observe progress, and retain auditable reports without retaining API keys.

## Requirements

- Accept one baseline and one to six candidate endpoints, API keys, agent, model, task, and trials per arm.
- Run baseline A, baseline B, and every candidate concurrently through Harbor.
- Support Claude Code for Anthropic-compatible models and Codex for OpenAI-compatible models.
- Keep all operator-facing UI copy, API errors, and generated reports in English.
- Run jobs entirely on the server after creation so closing the browser does not interrupt them.
- Persist status, timestamps, redacted configuration, logs, and the generated report.
- Never persist, log, echo, or include API keys in process arguments.
- List past runs, inspect a run, cancel an active run, and download its report/artifacts.
- Limit concurrency and reject loopback/private-network targets to prevent SSRF.
- Require a deployment access token when configured.

## Acceptance criteria

- [ ] `/benchmark/testRouter/` supports dynamic candidates, model/task selectors, create, progress, history, cancellation, and downloads.
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

