#!/bin/zsh
# Local probe recorder: invoked by launchd every 10 minutes (see scripts/install-recorder.sh to install).
# Data is continuously written as JSON documents to data/results/; git commits are batched every >=6 hours
# to avoid flooding history with 144 commits/day.
set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO"

# API keys live only in .env (already gitignored); see .env.example for the format
if [ -f .env ]; then
  set -a; source .env; set +a
fi
export PROBE_REGION="${PROBE_REGION:-local}"

# Refresh the price snapshot at most once a day; on failure keep the previous snapshot, don't block the probe
if [ ! -f data/prices.json ] || [ $(( $(date +%s) - $(stat -f %m data/prices.json) )) -ge 86400 ]; then
  node probe/prices.mjs || echo "[record] prices refresh failed, keeping snapshot"
fi

# Probe: 1 sample per model (controls cost at the 10-minute high-frequency cadence); writes no file when all keys are missing
out=$(node probe/probe.mjs --samples 1 --out data/results)
if [ -z "$out" ]; then
  echo "[record] no gateway has a key in .env — nothing recorded"
  exit 0
fi
echo "[record] wrote $out"

node probe/aggregate.mjs

# Only batch a commit once it has been >=6 hours since the last data commit
last=$(git log -1 --format=%ct -- data/results 2>/dev/null || echo 0)
if [ $(( $(date +%s) - last )) -ge 21600 ]; then
  git add data/results data/prices.json web/data.json
  if ! git diff --cached --quiet; then
    git commit -m "data: local probe batch $(date -u +%FT%TZ)"
    echo "[record] committed data batch"
  fi
fi
