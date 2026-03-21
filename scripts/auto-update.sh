#!/usr/bin/env bash
#
# auto-update.sh - Automatic update script for Ensoul validators.
#
# Checks GitHub for new commits, pulls, rebuilds, and restarts
# validators if the version changed. Safe: if build fails, the
# old version keeps running.
#
# Install as a launchd job:
#   npx tsx packages/node/src/cli/main.ts --auto-update
#
# Or run manually:
#   ./scripts/auto-update.sh
#

set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LOG_DIR="$HOME/.ensoul"
LOG_FILE="$LOG_DIR/auto-update.log"

mkdir -p "$LOG_DIR"

log() {
	local ts
	ts=$(date +"%Y-%m-%d %H:%M:%S")
	echo "[$ts] $1" >> "$LOG_FILE"
	echo "[$ts] $1"
}

cd "$REPO_DIR"

# 1. Check for new commits on main
log "Checking for updates..."
git fetch origin main --quiet 2>/dev/null || { log "Git fetch failed. Skipping."; exit 0; }

LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/main)

if [ "$LOCAL" = "$REMOTE" ]; then
	log "Already up to date ($LOCAL)."
	exit 0
fi

log "New commits found: $LOCAL -> $REMOTE"

# 2. Save current version
OLD_VERSION=$(node -e "console.log(require('./packages/node/package.json').version)" 2>/dev/null || echo "unknown")
log "Current version: $OLD_VERSION"

# 3. Pull latest code
log "Pulling latest code..."
git pull origin main --quiet 2>/dev/null || { log "Git pull failed. Skipping update."; exit 0; }

# 4. Build
log "Building..."
if ! pnpm build >> "$LOG_FILE" 2>&1; then
	log "BUILD FAILED. Reverting to previous commit to keep running version stable."
	git reset --hard "$LOCAL" --quiet 2>/dev/null || true
	exit 1
fi

# 5. Check for genesis changes
if [ -f "$REPO_DIR/genesis.json" ] && [ -f "$LOG_DIR/genesis.json" ]; then
	NEW_HASH=$(shasum -a 256 "$REPO_DIR/genesis.json" | awk '{print $1}')
	OLD_HASH=$(shasum -a 256 "$LOG_DIR/genesis.json" | awk '{print $1}')
	if [ "$NEW_HASH" != "$OLD_HASH" ]; then
		log "Genesis changed ($OLD_HASH -> $NEW_HASH). Updating and wiping chain data."
		cp "$REPO_DIR/genesis.json" "$LOG_DIR/genesis.json"
		for i in $(seq 0 9); do
			if [ -d "$LOG_DIR/validator-$i/chain" ]; then
				rm -rf "$LOG_DIR/validator-$i/chain"
				log "Wiped chain data for validator-$i"
			fi
		done
		log "Genesis changed. Chain data wiped. Validators will sync from network."
	fi
elif [ -f "$REPO_DIR/genesis.json" ] && [ ! -f "$LOG_DIR/genesis.json" ]; then
	cp "$REPO_DIR/genesis.json" "$LOG_DIR/genesis.json"
	log "Copied genesis.json to $LOG_DIR/genesis.json"
fi

# 6. Check if version changed
NEW_VERSION=$(node -e "console.log(require('./packages/node/package.json').version)" 2>/dev/null || echo "unknown")
log "New version: $NEW_VERSION (was $OLD_VERSION)"

if [ "$OLD_VERSION" = "$NEW_VERSION" ] && [ "${NEW_HASH:-}" = "${OLD_HASH:-}" ]; then
	log "Version and genesis unchanged. Code updated but no restart needed."
	exit 0
fi

# 7. Wipe chain data on version change (genesis processing may have changed)
if [ "$OLD_VERSION" != "$NEW_VERSION" ]; then
	log "Version changed ($OLD_VERSION -> $NEW_VERSION). Wiping chain data."
	for i in $(seq 0 9); do
		if [ -d "$LOG_DIR/validator-$i/chain" ]; then
			rm -rf "$LOG_DIR/validator-$i/chain"
			log "Wiped chain data for validator-$i"
		fi
	done
fi

# 8. Restart validators
log "Restarting validators (version: $OLD_VERSION -> $NEW_VERSION)..."

# Try start-mini.sh first (Mac Mini), then start-all.sh (MacBook Pro)
if [ -f "$REPO_DIR/scripts/start-mini.sh" ]; then
	# Detect which mini this is from the tunnel config
	TUNNEL_NAME=""
	if pgrep -f "cloudflared.*mini-1" >/dev/null 2>&1; then TUNNEL_NAME="mini-1"; fi
	if pgrep -f "cloudflared.*mini-2" >/dev/null 2>&1; then TUNNEL_NAME="mini-2"; fi
	if pgrep -f "cloudflared.*mini-3" >/dev/null 2>&1; then TUNNEL_NAME="mini-3"; fi

	if [ -n "$TUNNEL_NAME" ]; then
		# Read peers from the running validator's command line
		PEERS=$(ps aux | grep "ensoul.*--peers" | grep -v grep | head -1 | sed 's/.*--peers //' | awk '{print $1}' || echo "")
		if [ -z "$PEERS" ]; then
			PEERS="https://v0.ensoul.dev"
		fi
		log "Restarting via start-mini.sh: tunnel=$TUNNEL_NAME peers=$PEERS"
		bash "$REPO_DIR/scripts/start-mini.sh" stop 2>/dev/null || true
		sleep 2
		bash "$REPO_DIR/scripts/start-mini.sh" "$TUNNEL_NAME" "$PEERS" >> "$LOG_FILE" 2>&1 || log "Restart failed!"
	else
		log "Could not detect tunnel name. Stopping validators only."
		bash "$REPO_DIR/scripts/start-mini.sh" stop 2>/dev/null || true
	fi
elif [ -f "$REPO_DIR/scripts/start-all.sh" ]; then
	log "Restarting via start-all.sh..."
	bash "$REPO_DIR/scripts/start-all.sh" restart >> "$LOG_FILE" 2>&1 || log "Restart failed!"
fi

log "Update complete: $OLD_VERSION -> $NEW_VERSION"
