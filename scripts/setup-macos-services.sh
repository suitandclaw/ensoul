#!/usr/bin/env bash
#
# setup-macos-services.sh
#
# Installs macOS launchd services for the Ensoul validator, explorer,
# cloudflared named tunnel, and Twitter agent on this MacBook Pro.
# The 3 Mac Minis each run their own validator; this machine runs 1.
#
# Usage:
#   ./scripts/setup-macos-services.sh          # install & load
#   ./scripts/setup-macos-services.sh uninstall # unload & remove
#
# Cloudflared named tunnel setup (one-time):
#   cloudflared tunnel create ensoul
#   cloudflared tunnel route dns ensoul explorer.ensoul.dev
#   # Then this script runs: cloudflared tunnel run ensoul
#

set -euo pipefail

# ── Resolve paths ─────────────────────────────────────────────────────

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LAUNCH_DIR="$HOME/Library/LaunchAgents"
DATA_DIR="$HOME/.ensoul"

# Peer URLs for the 3 Mac Mini validators
PEER_URLS="https://v1.ensoul.dev,https://v2.ensoul.dev,https://v3.ensoul.dev"

NPX_PATH="$(which npx 2>/dev/null || true)"
if [ -z "$NPX_PATH" ]; then
  echo "Error: npx not found. Install Node.js 22+ first." >&2
  exit 1
fi

TSX_PATH="$(which tsx 2>/dev/null || true)"
if [ -z "$TSX_PATH" ]; then
  echo "Warning: tsx not found globally. Will use npx tsx." >&2
  TSX_PATH=""
fi

NODE_BIN_DIR="$(dirname "$NPX_PATH")"

CLOUDFLARED_PATH="$(which cloudflared 2>/dev/null || true)"
if [ -z "$CLOUDFLARED_PATH" ]; then
  echo "Warning: cloudflared not found. Tunnel service will not be installed." >&2
  echo "  Install: brew install cloudflared" >&2
fi

echo "Ensoul macOS service installer (MacBook Pro)"
echo "  Repo:        $REPO_DIR"
echo "  npx:         $NPX_PATH"
echo "  Node bin:    $NODE_BIN_DIR"
echo "  cloudflared: ${CLOUDFLARED_PATH:-not found}"
echo "  Data dir:    $DATA_DIR"
echo "  Peers:       $PEER_URLS"
echo ""

# ── Uninstall mode ────────────────────────────────────────────────────

if [ "${1:-}" = "uninstall" ]; then
  echo "Uninstalling Ensoul services..."
  for label in dev.ensoul.validator-0 dev.ensoul.validator-1 dev.ensoul.validator-2 dev.ensoul.explorer dev.ensoul.tunnel dev.ensoul.agent; do
    plist="$LAUNCH_DIR/$label.plist"
    if [ -f "$plist" ]; then
      launchctl bootout "gui/$(id -u)" "$plist" 2>/dev/null || true
      rm -f "$plist"
      echo "  Removed $label"
    fi
  done
  echo "Done."
  exit 0
fi

# ── Create directories ────────────────────────────────────────────────

mkdir -p "$LAUNCH_DIR"
mkdir -p "$DATA_DIR"
mkdir -p "$DATA_DIR/validator-0"

# ── Helper: write a plist ─────────────────────────────────────────────

write_plist() {
  local label="$1"
  local program_args="$2"  # XML fragment with <string> elements
  local log_prefix="$3"
  local work_dir="${4:-$REPO_DIR}"  # optional working directory override
  local plist_path="$LAUNCH_DIR/$label.plist"

  cat > "$plist_path" << PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$label</string>

  <key>ProgramArguments</key>
  <array>
$program_args
  </array>

  <key>WorkingDirectory</key>
  <string>$work_dir</string>

  <key>RunAtLoad</key>
  <true/>

  <key>KeepAlive</key>
  <true/>

  <key>StandardOutPath</key>
  <string>$DATA_DIR/$log_prefix.log</string>

  <key>StandardErrorPath</key>
  <string>$DATA_DIR/$log_prefix.log</string>

  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>$NODE_BIN_DIR:/usr/local/bin:/usr/bin:/bin</string>
    <key>HOME</key>
    <string>$HOME</string>
  </dict>

  <key>ThrottleInterval</key>
  <integer>5</integer>
</dict>
</plist>
PLIST_EOF

  echo "  Created $plist_path"
}

# ── Build program arguments ───────────────────────────────────────────

# Single validator on MacBook Pro, connecting to Mac Mini peers
validator_args() {
  cat << ARGS
    <string>$NPX_PATH</string>
    <string>tsx</string>
    <string>$REPO_DIR/packages/node/src/cli/main.ts</string>
    <string>--validate</string>
    <string>--port</string>
    <string>9000</string>
    <string>--api-port</string>
    <string>10000</string>
    <string>--data-dir</string>
    <string>$DATA_DIR/validator-0</string>
    <string>--peers</string>
    <string>$PEER_URLS</string>
ARGS
}

explorer_args() {
  cat << ARGS
    <string>$NPX_PATH</string>
    <string>tsx</string>
    <string>$REPO_DIR/packages/explorer/start.ts</string>
    <string>--port</string>
    <string>3000</string>
ARGS
}

# Named tunnel: cloudflared tunnel run ensoul
# Requires one-time setup: cloudflared tunnel create ensoul
tunnel_args() {
  cat << ARGS
    <string>$CLOUDFLARED_PATH</string>
    <string>tunnel</string>
    <string>run</string>
    <string>ensoul</string>
ARGS
}

# Agent: npx tsx src/agent.ts (runs from ~/ensoul-agent)
AGENT_DIR="$HOME/ensoul-agent"

agent_args() {
  cat << ARGS
    <string>$NPX_PATH</string>
    <string>tsx</string>
    <string>$AGENT_DIR/src/agent.ts</string>
ARGS
}

# ── Create plists ─────────────────────────────────────────────────────

echo "Creating launchd service plists..."

write_plist "dev.ensoul.validator-0" "$(validator_args)" "validator-0"

write_plist "dev.ensoul.explorer" "$(explorer_args)" "explorer"

if [ -n "$CLOUDFLARED_PATH" ]; then
  write_plist "dev.ensoul.tunnel" "$(tunnel_args)" "tunnel"
else
  echo "  Skipped dev.ensoul.tunnel (cloudflared not installed)"
fi

if [ -d "$AGENT_DIR/src" ]; then
  write_plist "dev.ensoul.agent" "$(agent_args)" "agent" "$AGENT_DIR"
else
  echo "  Skipped dev.ensoul.agent ($AGENT_DIR/src not found)"
fi

# ── Load services ─────────────────────────────────────────────────────

echo ""
echo "Loading services..."

ALL_LABELS="dev.ensoul.validator-0 dev.ensoul.explorer"
if [ -n "$CLOUDFLARED_PATH" ]; then
  ALL_LABELS="$ALL_LABELS dev.ensoul.tunnel"
fi
if [ -d "$AGENT_DIR/src" ]; then
  ALL_LABELS="$ALL_LABELS dev.ensoul.agent"
fi

for label in $ALL_LABELS; do
  plist="$LAUNCH_DIR/$label.plist"
  # Unload first in case it was already loaded
  launchctl bootout "gui/$(id -u)" "$plist" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$plist"
  echo "  Loaded $label"
done

# ── Summary ───────────────────────────────────────────────────────────

echo ""
echo "All services installed and running."
echo ""
echo "  Validator:"
echo "    validator-0  port 9000   api 10000  log: $DATA_DIR/validator-0.log"
echo "    peers: $PEER_URLS"
echo ""
echo "  Explorer:"
echo "    http://localhost:3000    log: $DATA_DIR/explorer.log"
echo ""
if [ -n "$CLOUDFLARED_PATH" ]; then
echo "  Tunnel (named: ensoul):"
echo "    explorer.ensoul.dev     log: $DATA_DIR/tunnel.log"
echo ""
fi
if [ -d "$AGENT_DIR/src" ]; then
echo "  Agent:"
echo "    @ensoul_network Twitter bot   log: $DATA_DIR/agent.log"
echo ""
fi
echo "Management commands:"
echo "  launchctl list | grep ensoul          # check status"
echo "  launchctl kickstart gui/$(id -u)/dev.ensoul.validator-0  # force restart"
echo "  tail -f $DATA_DIR/validator-0.log     # follow logs"
echo "  $0 uninstall                          # remove all services"
