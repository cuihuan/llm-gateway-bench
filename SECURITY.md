# Security Policy

## Reporting a vulnerability

Please report security issues **privately** via GitHub's
[private vulnerability reporting](https://github.com/cuihuan/llm-gateway-bench/security/advisories/new)
rather than opening a public issue.

## Key handling (the important part)

This tool probes gateways with **your own API keys**. By design:

- Keys are read **only** from environment variables (e.g. `PROBE_KEY`,
  `<GATEWAY>_API_KEY`), never from the command line or config files in the repo.
- Keys are **never written to results, reports, or logs**. `scripts/publish-report.mjs`
  scans a report for leaked secrets and refuses to publish if it finds any.
- In CI, keys live only in GitHub Secrets; gateways without a key are marked
  `skipped`, not failed.

If you find a path where a key could leak into committed data (`data/results/`,
`web/`, a generated report), please report it privately — that is the highest-severity
class of bug for this project.

## Scope

The probe code (`probe/*.mjs`) is zero-dependency and makes outbound HTTPS
requests to user-supplied gateway URLs. It does not accept inbound traffic.
Vulnerabilities in the third-party gateways being probed are out of scope —
report those upstream.
