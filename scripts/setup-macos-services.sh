#!/usr/bin/env bash
#
# setup-macos-services.sh
#
# Installs macOS launchd services for 3 Ensoul validators + the explorer.
# Services auto-start on login and auto-restart on crash.
#
# Usage:
#   ./scripts/setup-macos-services.sh          # install & load
#   ./scripts/setup-macos-services.sh uninstall # unload & remove
#

set -euo pipefail

# ── Resolve paths ─────────────────────────────────────────────────────

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LAUNCH_DIR="$HOME/Library/LaunchAgents"
DATA_DIR="$HOME/.ensoul"

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

echo "Ensoul macOS service installer"
echo "  Repo:     $REPO_DIR"
echo "  npx:      $NPX_PATH"
echo "  Node bin: $NODE_BIN_DIR"
echo "  Data dir: $DATA_DIR"
echo ""

# ── Uninstall mode ────────────────────────────────────────────────────

if [ "${1:-}" = "uninstall" ]; then
  echo "Uninstalling Ensoul services..."
  for label in dev.ensoul.validator-0 dev.ensoul.validator-1 dev.ensoul.validator-2 dev.ensoul.explorer; do
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
for i in 0 1 2; do
  mkdir -p "$DATA_DIR/validator-$i"
done

# ── Helper: write a plist ─────────────────────────────────────────────

write_plist() {
  local label="$1"
  local program_args="$2"  # XML fragment with <string> elements
  local log_prefix="$3"
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
  <string>$REPO_DIR</string>

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

# For validators: npx tsx packages/node/src/cli/main.ts --validate --port N --data-dir DIR
# For explorer:   npx tsx packages/explorer/start.ts

validator_args() {
  local index="$1"
  local port=$((9000 + index))
  local api_port=$((10000 + index))
  local data_dir="$DATA_DIR/validator-$index"

  cat << ARGS
    <string>$NPX_PATH</string>
    <string>tsx</string>
    <string>$REPO_DIR/packages/node/src/cli/main.ts</string>
    <string>--validate</string>
    <string>--port</string>
    <string>$port</string>
    <string>--api-port</string>
    <string>$api_port</string>
    <string>--data-dir</string>
    <string>$data_dir</string>
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

# ── Create plists ─────────────────────────────────────────────────────

echo "Creating launchd service plists..."

for i in 0 1 2; do
  write_plist "dev.ensoul.validator-$i" "$(validator_args $i)" "validator-$i"
done

write_plist "dev.ensoul.explorer" "$(explorer_args)" "explorer"

# ── Load services ─────────────────────────────────────────────────────

echo ""
echo "Loading services..."

for label in dev.ensoul.validator-0 dev.ensoul.validator-1 dev.ensoul.validator-2 dev.ensoul.explorer; do
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
echo "  Validators:"
echo "    validator-0  port 9000   api 10000  log: $DATA_DIR/validator-0.log"
echo "    validator-1  port 9001   api 10001  log: $DATA_DIR/validator-1.log"
echo "    validator-2  port 9002   api 10002  log: $DATA_DIR/validator-2.log"
echo ""
echo "  Explorer:"
echo "    http://localhost:3000    log: $DATA_DIR/explorer.log"
echo ""
echo "Management commands:"
echo "  launchctl list | grep ensoul          # check status"
echo "  launchctl kickstart gui/$(id -u)/dev.ensoul.validator-0  # force restart"
echo "  tail -f $DATA_DIR/validator-0.log     # follow logs"
echo "  $0 uninstall                          # remove all services"
