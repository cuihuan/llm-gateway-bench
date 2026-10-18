# Hosted Terminal-Bench runner

The runner serves `/benchmark/testRouter/` and the same-origin API. It requires a Linux host with Docker, Harbor 0.24.0, the pinned Terminal-Bench checkout, Node.js 22+, and enough resources for the configured concurrency.

```bash
uv tool install harbor==0.24.0
git clone https://github.com/harbor-framework/terminal-bench.git /opt/terminal-bench
git -C /opt/terminal-bench checkout 1d49c52e

BENCHMARK_ACCESS_TOKEN='generate-a-long-random-value' \
TERMINAL_BENCH_DIR=/opt/terminal-bench \
BENCHMARK_DATA_DIR=/var/lib/router-bench \
npm run router-bench
```

Configuration:

| Variable | Default | Meaning |
|---|---|---|
| `BENCHMARK_HOST` | `127.0.0.1` | Bind address |
| `BENCHMARK_PORT` | `8788` | Bind port |
| `BENCHMARK_ACCESS_TOKEN` | empty | Shared operator token; production must set it |
| `BENCHMARK_DATA_DIR` | `./var/router-bench` | Run metadata, logs, jobs and reports |
| `TERMINAL_BENCH_DIR` | `./terminal-bench` | Pinned Terminal-Bench checkout |
| `HARBOR_BIN` | `harbor` | Harbor executable |
| `BENCHMARK_MAX_ACTIVE_RUNS` | `1` | Concurrent comparison groups |

Each comparison pins SynthorAI as the baseline and NIBRoute as the candidate. SynthorAI runs twice (A/A) and NIBRoute runs once. Claude models use Harbor's `claude-code` agent with `ANTHROPIC_BASE_URL` and `ANTHROPIC_API_KEY`; all other models use Harbor's `codex` agent with `OPENAI_BASE_URL` and `OPENAI_API_KEY`. The other provider's variables are removed from every child environment. Caller-supplied endpoint URLs and agent values are ignored.

The HTTP request only creates the run. Harbor jobs continue in the runner service after the browser is closed, and their status and artifacts are persisted under `BENCHMARK_DATA_DIR`. Production readiness can be checked without a model call by running one verified task with Harbor's `nop` agent; this exercises Docker, task discovery, the verifier, and result persistence without using an API key.

API keys are accepted in the create request and passed to Harbor only through child-process environment variables. They are not included in `run.json`, API responses, reports, or command arguments. The access token is kept in browser `sessionStorage`, not local storage.

## Reverse proxy

Route the whole hostname to the runner so the UI and API remain same-origin:

```nginx
server {
  listen 443 ssl http2;
  server_name benchmark.example.com;

  location / {
    proxy_pass http://127.0.0.1:8788;
    proxy_http_version 1.1;
    proxy_read_timeout 60s;
    client_max_body_size 64k;
  }
}
```

Keep the service private until `BENCHMARK_ACCESS_TOKEN`, TLS, DNS, disk retention, and host firewall rules are configured.

