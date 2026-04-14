#!/usr/bin/env bash
# kill.sh - stops the resurrection agent and wipes ALL local state.
#
# Preserves ONLY: ~/ensoul-key-vault/resurrection-agent-seed.json
# (the seed + on-chain pointer + narrative cache)
#
# Everything else in ~/.ensoul/resurrection-agent/ is destroyed.
#
# Run this via cron on Fri at 16:00:00 EST (America/New_York).

set -euo pipefail

AGENT_DIR="$HOME/.ensoul/resurrection-agent"
VAULT_FILE="$HOME/ensoul-key-vault/resurrection-agent-seed.json"

log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] [kill] $*"; }

log "Beginning kill sequence"

# Step 1: Stop the agent process if running.
if pgrep -f "resurrection-agent/src/agent" > /dev/null; then
	log "Stopping agent process"
	pkill -TERM -f "resurrection-agent/src/agent" || true
	sleep 3
	if pgrep -f "resurrection-agent/src/agent" > /dev/null; then
		log "Process still alive, sending SIGKILL"
		pkill -KILL -f "resurrection-agent/src/agent" || true
	fi
else
	log "No agent process running"
fi

# Step 2: Verify vault exists BEFORE we wipe. If not, refuse to wipe.
if [ ! -f "$VAULT_FILE" ]; then
	log "REFUSING TO WIPE: vault file $VAULT_FILE not found."
	log "Without the vault, resurrection is impossible. Aborting."
	exit 1
fi
log "Vault verified at $VAULT_FILE"

# Step 3: Wipe local state.
if [ -d "$AGENT_DIR" ]; then
	log "Wiping $AGENT_DIR"
	# Move-then-remove pattern to ensure atomic-ish behavior
	MV="${AGENT_DIR}.wiping-$(date +%s)"
	mv "$AGENT_DIR" "$MV"
	rm -rf "$MV"
else
	log "No agent data dir to wipe"
fi

# Step 4: Confirm wipe
if [ -d "$AGENT_DIR" ]; then
	log "ERROR: agent dir still exists after wipe"
	exit 1
fi

log "Kill complete. Local state wiped. Vault preserved."
log "Resurrection can now begin on a different machine with:"
log "  cd ~/ensoul/packages/resurrection-agent && npm run resurrect"
