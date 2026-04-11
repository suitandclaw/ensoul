#!/usr/bin/env bash
#
# auto-upgrade.sh: Automatically apply code upgrades after ABCI halts.
#
# Called by systemd via ExecStopPost when ensoul-abci exits. If the exit
# was triggered by an on-chain SOFTWARE_UPGRADE, this script:
#   1. Reads upgrade-info.json to get the target git tag
#   2. Checks out the tag and rebuilds
#   3. Places the CometBFT binary in the Cosmovisor upgrade directory
#   4. systemd then restarts ensoul-abci with the new code
#
# The info field in the upgrade plan must contain a JSON object with
# a "tag" field pointing to a git tag or commit hash:
#   {"tag": "v1.5.0"}
#
# If the info field contains Cosmovisor-style binary URLs, those are
# ignored (we build from source, not from pre-compiled binaries).
#
# Usage:
#   Called automatically by systemd ExecStopPost. Can also be run manually:
#   ./scripts/auto-upgrade.sh
#

set -euo pipefail

REPO_DIR="${ENSOUL_REPO:-$HOME/ensoul}"
CMT_HOME="${DAEMON_HOME:-$HOME/.cometbft-ensoul/node}"
UPGRADE_INFO="$CMT_HOME/data/upgrade-info.json"
LOG_FILE="$HOME/.ensoul/auto-upgrade.log"
LOCK_FILE="$HOME/.ensoul/auto-upgrade.lock"

log() {
    local ts
    ts=$(date "+%Y-%m-%d %H:%M:%S")
    echo "[$ts] [auto-upgrade] $1" | tee -a "$LOG_FILE"
}

# ── Check if an upgrade is pending ──────────────────────────────────

if [ ! -f "$UPGRADE_INFO" ]; then
    # No upgrade pending. Normal restart.
    exit 0
fi

# Read the upgrade plan
UPGRADE_NAME=$(python3 -c "import json; print(json.load(open('$UPGRADE_INFO'))['name'])" 2>/dev/null || echo "")
UPGRADE_HEIGHT=$(python3 -c "import json; print(json.load(open('$UPGRADE_INFO'))['height'])" 2>/dev/null || echo "0")
UPGRADE_INFO_RAW=$(python3 -c "import json; print(json.load(open('$UPGRADE_INFO')).get('info',''))" 2>/dev/null || echo "")

if [ -z "$UPGRADE_NAME" ]; then
    log "upgrade-info.json exists but name is empty. Skipping."
    exit 0
fi

# Parse the info field for the git tag
GIT_TAG=$(echo "$UPGRADE_INFO_RAW" | python3 -c "import sys,json; print(json.load(sys.stdin).get('tag',''))" 2>/dev/null || echo "")

if [ -z "$GIT_TAG" ]; then
    log "Upgrade '$UPGRADE_NAME' at height $UPGRADE_HEIGHT has no git tag in info field. Skipping auto-upgrade."
    log "Info field: $UPGRADE_INFO_RAW"
    exit 0
fi

# ── Prevent concurrent runs ─────────────────────────────────────────

if [ -f "$LOCK_FILE" ]; then
    lock_age=$(( $(date +%s) - $(stat -f %m "$LOCK_FILE" 2>/dev/null || stat -c %Y "$LOCK_FILE" 2>/dev/null || echo 0) ))
    if [ "$lock_age" -lt 300 ] 2>/dev/null; then
        log "Another auto-upgrade is running (lock age: ${lock_age}s). Skipping."
        exit 0
    fi
    rm -f "$LOCK_FILE"
fi
echo $$ > "$LOCK_FILE"
trap 'rm -f "$LOCK_FILE"' EXIT

# ── Apply the upgrade ───────────────────────────────────────────────

log "=========================================="
log "APPLYING UPGRADE: $UPGRADE_NAME"
log "  Target height: $UPGRADE_HEIGHT"
log "  Git tag: $GIT_TAG"
log "=========================================="

cd "$REPO_DIR"

# Fetch and checkout the target tag
log "Fetching tag $GIT_TAG..."
git fetch origin --tags 2>&1 | tail -3 >> "$LOG_FILE"

if git rev-parse "$GIT_TAG" >/dev/null 2>&1; then
    git checkout "$GIT_TAG" 2>&1 | tail -1 >> "$LOG_FILE"
    log "Checked out $GIT_TAG ($(git rev-parse --short HEAD))"
else
    # Tag not found, try as a branch or commit hash
    git fetch origin "$GIT_TAG" 2>&1 | tail -1 >> "$LOG_FILE" || true
    if git rev-parse "$GIT_TAG" >/dev/null 2>&1; then
        git checkout "$GIT_TAG" 2>&1 | tail -1 >> "$LOG_FILE"
        log "Checked out commit $GIT_TAG ($(git rev-parse --short HEAD))"
    else
        log "ERROR: Could not find tag or commit '$GIT_TAG'. Aborting upgrade."
        exit 1
    fi
fi

# Rebuild
log "Installing dependencies..."
if command -v pnpm >/dev/null 2>&1; then
    pnpm install --frozen-lockfile 2>&1 | tail -3 >> "$LOG_FILE"
    log "Building..."
    pnpm build --filter @ensoul/ledger --filter @ensoul/abci-server 2>&1 | tail -3 >> "$LOG_FILE"
elif command -v npm >/dev/null 2>&1; then
    npm install 2>&1 | tail -3 >> "$LOG_FILE"
    log "Building..."
    npm run build 2>&1 | tail -3 >> "$LOG_FILE"
fi
log "Build complete."

# Place CometBFT binary in Cosmovisor upgrade directory
# (same binary, but Cosmovisor needs it in the right place to proceed)
UPGRADE_BIN_DIR="$CMT_HOME/cosmovisor/upgrades/$UPGRADE_NAME/bin"
mkdir -p "$UPGRADE_BIN_DIR"
if [ -f "$CMT_HOME/cosmovisor/genesis/bin/cometbft" ]; then
    cp "$CMT_HOME/cosmovisor/genesis/bin/cometbft" "$UPGRADE_BIN_DIR/cometbft"
    log "Placed CometBFT binary at $UPGRADE_BIN_DIR/cometbft"
elif [ -f "$HOME/go/bin/cometbft" ]; then
    cp "$HOME/go/bin/cometbft" "$UPGRADE_BIN_DIR/cometbft"
    log "Placed CometBFT binary from go/bin at $UPGRADE_BIN_DIR/cometbft"
fi

# Remove upgrade-info.json so the ABCI does not halt again on restart
rm -f "$UPGRADE_INFO"
log "Removed upgrade-info.json"

log "=========================================="
log "UPGRADE COMPLETE: $UPGRADE_NAME"
log "  ABCI will restart with new code."
log "  Cosmovisor will swap CometBFT binary and restart."
log "=========================================="
