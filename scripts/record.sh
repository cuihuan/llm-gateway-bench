#!/bin/zsh
# 本地拨测记录器：launchd 每 10 分钟调用一次（安装见 scripts/install-recorder.sh）。
# 数据以 JSON 文档持续落盘到 data/results/；git 提交按 ≥6 小时批量归集，
# 避免 144 个/天的提交刷爆历史。
set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO"

# API key 只放 .env（已 gitignore），格式见 .env.example
if [ -f .env ]; then
  set -a; source .env; set +a
fi
export PROBE_REGION="${PROBE_REGION:-local}"

# 价格快照每天最多刷一次；失败沿用上份快照，不阻塞拨测
if [ ! -f data/prices.json ] || [ $(( $(date +%s) - $(stat -f %m data/prices.json) )) -ge 86400 ]; then
  node probe/prices.mjs || echo "[record] prices refresh failed, keeping snapshot"
fi

# 拨测：每模型 1 采样（10 分钟一次的高频下控制成本）；全部缺 key 时不写文件
out=$(node probe/probe.mjs --samples 1 --out data/results)
if [ -z "$out" ]; then
  echo "[record] no gateway has a key in .env — nothing recorded"
  exit 0
fi
echo "[record] wrote $out"

node probe/aggregate.mjs

# 距上次数据提交 ≥6 小时才归集一次 commit
last=$(git log -1 --format=%ct -- data/results 2>/dev/null || echo 0)
if [ $(( $(date +%s) - last )) -ge 21600 ]; then
  git add data/results data/prices.json web/data.json
  if ! git diff --cached --quiet; then
    git commit -m "data: local probe batch $(date -u +%FT%TZ)"
    echo "[record] committed data batch"
  fi
fi
