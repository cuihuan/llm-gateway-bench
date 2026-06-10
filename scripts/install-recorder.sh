#!/bin/zsh
# 安装/重装 macOS launchd 定时器：每 600 秒运行一次 scripts/record.sh。
# 卸载：launchctl unload ~/Library/LaunchAgents/io.llm-gateway-bench.record.plist && rm 该文件
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
PLIST="$HOME/Library/LaunchAgents/io.llm-gateway-bench.record.plist"
mkdir -p "$REPO/logs" "$HOME/Library/LaunchAgents"

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>io.llm-gateway-bench.record</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string>
    <string>$REPO/scripts/record.sh</string>
  </array>
  <key>StartInterval</key><integer>600</integer>
  <key>RunAtLoad</key><true/>
  <key>WorkingDirectory</key><string>$REPO</string>
  <key>StandardOutPath</key><string>$REPO/logs/record.log</string>
  <key>StandardErrorPath</key><string>$REPO/logs/record.log</string>
</dict>
</plist>
EOF

launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"
echo "installed: $PLIST (every 600s, logs → $REPO/logs/record.log)"
