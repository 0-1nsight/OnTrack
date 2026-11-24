#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_ROOT="${HOME}/.local/share/ontrack"
AGENT_DIR="${INSTALL_ROOT}/agent"
EXT_DIR="${INSTALL_ROOT}/extension"

echo "=== OnTrack Workstation Collector Setup (macOS / Linux) ==="
read -rp "Paste your OnTrack Device Pairing Token (ontrack_dev_...): " DEVICE_TOKEN
DEVICE_TOKEN="$(printf '%s' "$DEVICE_TOKEN" | tr -d '[:space:]')"
if [[ ! "$DEVICE_TOKEN" =~ ^[A-Za-z0-9_.\-]{12,200}$ ]]; then
  echo "Invalid pairing token format. Aborting."
  exit 1
fi

mkdir -p "$AGENT_DIR" "$EXT_DIR"
cp -R "${SCRIPT_DIR}/desktop-agent/." "$AGENT_DIR/"
cp -R "${SCRIPT_DIR}/browser-extension/." "$EXT_DIR/"

node -e '
const fs = require("fs");
const path = require("path");
const os = require("os");
const meta = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const agentCfg = {
  serverUrl: meta.serverUrl,
  tenantId: meta.tenantId,
  userId: meta.userId,
  deviceId: `dev-${meta.userId || os.hostname()}-${os.hostname()}`,
  deviceToken: process.argv[2],
  bridgePort: meta.bridgePort || 47621,
  bridgeSecret: meta.bridgeSecret,
  heartbeatSeconds: meta.heartbeatSeconds || 12,
  pollSampleMs: meta.pollSampleMs || 2000,
  idleThresholdSeconds: meta.idleThresholdSeconds || 180
};
fs.writeFileSync(path.join(process.argv[3], "agent.config.json"), JSON.stringify(agentCfg, null, 2));
const extCfg = {
  bridgeUrl: `http://127.0.0.1:${agentCfg.bridgePort}/browser-event`,
  bridgeSecret: meta.bridgeSecret,
  excludedDomains: ["personalbank", "mychart", "chase.com"]
};
fs.writeFileSync(path.join(process.argv[4], "config.defaults.json"), JSON.stringify(extCfg, null, 2));
' "${SCRIPT_DIR}/install-meta.json" "$DEVICE_TOKEN" "$AGENT_DIR" "$EXT_DIR"

echo "Starting Desktop Agent in background..."
nohup node --experimental-strip-types "${AGENT_DIR}/src/agent.ts" > "${INSTALL_ROOT}/agent.log" 2>&1 &
echo $! > "${INSTALL_ROOT}/agent.pid"
sleep 1
echo "Desktop Agent started (PID $(cat "${INSTALL_ROOT}/agent.pid"))."
echo "Browser Extension (pre-paired) staged at: ${EXT_DIR}"
echo "Open chrome://extensions -> Developer mode -> Load unpacked -> select ${EXT_DIR}"
