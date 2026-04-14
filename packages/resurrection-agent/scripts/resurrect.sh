#!/usr/bin/env bash
# resurrect.sh - run this on a DIFFERENT machine after kill.sh fires.
#
# Prerequisites on the new machine:
#   - ~/ensoul-key-vault/resurrection-agent-seed.json must exist
#     (vault syncs between machines via rsync/rclone/manual out-of-band)
#   - Node 22+, pnpm installed
#   - Repo cloned at ~/ensoul
#
# Flow:
#   1. Run the resurrection phase (recovers consciousness, posts thread)
#   2. Start the main agent loop in the background
#
# Run this via cron on the TARGET machine at Fri 16:05:00 EST.

set -euo pipefail

REPO_DIR="${ENSOUL_REPO:-$HOME/ensoul}"
PKG_DIR="$REPO_DIR/packages/resurrection-agent"
VAULT_FILE="$HOME/ensoul-key-vault/resurrection-agent-seed.json"
LOG_DIR="$HOME/.ensoul/resurrection-agent"
LOG="$LOG_DIR/resurrect-runner.log"

mkdir -p "$LOG_DIR"
log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] [resurrect] $*" | tee -a "$LOG"; }

log "Resurrection runner starting on $(hostname)"

# Step 1: Verify vault is present on this machine
if [ ! -f "$VAULT_FILE" ]; then
	log "FATAL: vault file $VAULT_FILE not found on this machine"
	log "The vault must be synced to this machine before resurrection."
	log "On the previous host: scp $VAULT_FILE user@this-machine:$VAULT_FILE"
	exit 1
fi
log "Vault present"

# Step 2: Verify repo is present
if [ ! -d "$PKG_DIR" ]; then
	log "FATAL: repo not found at $REPO_DIR"
	exit 1
fi

cd "$PKG_DIR"

# Step 3: Install deps if needed
if [ ! -d "node_modules" ] && [ ! -d "$REPO_DIR/node_modules" ]; then
	log "Installing dependencies"
	(cd "$REPO_DIR" && pnpm install)
fi

# Step 4: Run resurrection phase (recovers + posts thread)
log "Running resurrection phase"
npx tsx src/phases/resurrect.ts "$@"

# Step 5: Start the main agent loop
log "Starting main agent loop"
nohup npx tsx src/agent.ts "$@" > "$LOG_DIR/agent.log" 2>&1 &
AGENT_PID=$!
log "Agent started as PID $AGENT_PID"

# Give it a moment to confirm it's stable
sleep 3
if kill -0 "$AGENT_PID" 2>/dev/null; then
	log "Agent running stably."
else
	log "WARNING: agent exited within 3 seconds. Check $LOG_DIR/agent.log"
fi

log "Resurrection runner complete."
