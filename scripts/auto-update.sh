#!/usr/bin/env bash
#
# auto-update.sh - Automatic update for Ensoul validators.
# Checks GitHub, pulls, rebuilds, restarts if version or genesis changed.
# Install: npx tsx packages/node/src/cli/main.ts --auto-update
#

set -euo pipefail

# Resolve PATH for launchd (minimal PATH doesn't include nvm/pnpm)
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" 2>/dev/null || true
export PATH="$HOME/.nvm/versions/node/v22.22.1/bin:$HOME/Library/pnpm:$HOME/.local/share/pnpm:/usr/local/bin:/opt/homebrew/bin:$PATH"

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LOG_DIR="$HOME/.ensoul"
LOG_FILE="$LOG_DIR/auto-update.log"
CONFIG_FILE="$LOG_DIR/mini-config.json"

mkdir -p "$LOG_DIR"

log() {
	local ts
	ts=$(date +"%Y-%m-%d %H:%M:%S")
	echo "[$ts] $1" >> "$LOG_FILE"
	echo "[$ts] $1"
}

cd "$REPO_DIR"

# 1. Check for new commits
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
OLD_VERSION=$(grep -oP '"\K[0-9]+\.[0-9]+\.[0-9]+' packages/node/src/version.ts 2>/dev/null || echo "unknown")
log "Current version: $OLD_VERSION"

# 3. Pull
log "Pulling latest code..."
git pull origin main --quiet 2>/dev/null || { log "Git pull failed. Skipping."; exit 0; }

# 4. Build (safe: revert on failure)
log "Building..."
if ! pnpm build >> "$LOG_FILE" 2>&1; then
	log "BUILD FAILED. Reverting."
	git reset --hard "$LOCAL" --quiet 2>/dev/null || true
	exit 1
fi

# 5. Check genesis change
NEEDS_RESTART=false
if [ -f "$REPO_DIR/genesis.json" ] && [ -f "$LOG_DIR/genesis.json" ]; then
	NEW_HASH=$(md5 -q "$REPO_DIR/genesis.json" 2>/dev/null || md5sum "$REPO_DIR/genesis.json" | awk '{print $1}')
	OLD_HASH=$(md5 -q "$LOG_DIR/genesis.json" 2>/dev/null || md5sum "$LOG_DIR/genesis.json" | awk '{print $1}')
	if [ "$NEW_HASH" != "$OLD_HASH" ]; then
		log "Genesis changed. Wiping chain data."
		cp "$REPO_DIR/genesis.json" "$LOG_DIR/genesis.json"
		for i in $(seq 0 9); do
			rm -rf "$LOG_DIR/validator-$i/chain" 2>/dev/null || true
		done
		NEEDS_RESTART=true
	fi
elif [ -f "$REPO_DIR/genesis.json" ]; then
	cp "$REPO_DIR/genesis.json" "$LOG_DIR/genesis.json"
	NEEDS_RESTART=true
fi

# 6. Check version change
NEW_VERSION=$(grep -oP '"\K[0-9]+\.[0-9]+\.[0-9]+' packages/node/src/version.ts 2>/dev/null || echo "unknown")
log "New version: $NEW_VERSION (was $OLD_VERSION)"

if [ "$OLD_VERSION" != "$NEW_VERSION" ]; then
	log "Version changed. Wiping chain data."
	for i in $(seq 0 9); do
		rm -rf "$LOG_DIR/validator-$i/chain" 2>/dev/null || true
	done
	NEEDS_RESTART=true
fi

if [ "$NEEDS_RESTART" = "false" ]; then
	log "Code updated, no restart needed."
	exit 0
fi

# 7. Restart validators
log "Restarting validators..."

# Read config from mini-config.json if available
TUNNEL_NAME=""
PEERS=""
if [ -f "$CONFIG_FILE" ]; then
	TUNNEL_NAME=$(python3 -c "import json; print(json.load(open('$CONFIG_FILE')).get('name',''))" 2>/dev/null || echo "")
	PEERS=$(python3 -c "import json; print(','.join(json.load(open('$CONFIG_FILE')).get('peers',[])))" 2>/dev/null || echo "")
fi

# Fallback: detect from running processes
if [ -z "$TUNNEL_NAME" ]; then
	for n in mini-1 mini-2 mini-3; do
		if pgrep -f "cloudflared.*$n" >/dev/null 2>&1; then TUNNEL_NAME="$n"; break; fi
	done
fi
if [ -z "$PEERS" ]; then
	PEERS=$(ps aux | grep "ensoul.*--peers" | grep -v grep | head -1 | sed 's/.*--peers //' | awk '{print $1}' || echo "https://v0.ensoul.dev")
fi

if [ -n "$TUNNEL_NAME" ] && [ -n "$PEERS" ] && [ -f "$REPO_DIR/scripts/start-mini.sh" ]; then
	log "Restarting via start-mini.sh: tunnel=$TUNNEL_NAME"
	bash "$REPO_DIR/scripts/start-mini.sh" stop 2>/dev/null || true
	sleep 2
	bash "$REPO_DIR/scripts/start-mini.sh" "$TUNNEL_NAME" "$PEERS" >> "$LOG_FILE" 2>&1 || log "Restart failed!"
elif [ -f "$REPO_DIR/scripts/start-all.sh" ]; then
	log "Restarting via start-all.sh..."
	bash "$REPO_DIR/scripts/start-all.sh" restart >> "$LOG_FILE" 2>&1 || log "Restart failed!"
else
	log "No restart script found. Stop and start validators manually."
fi

log "Update complete: $OLD_VERSION -> $NEW_VERSION"
