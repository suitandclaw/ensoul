#!/usr/bin/env bash
#
# auto-update.sh - Pull latest code, build, restart validators if version changed.
# Designed to run unattended via launchd every 15 minutes.
# Install: npx tsx packages/node/src/cli/main.ts --auto-update
#

# Do NOT use set -e. We handle errors explicitly.
set -uo pipefail

# Resolve PATH for launchd
export NVM_DIR="$HOME/.nvm"
if [ -s "$NVM_DIR/nvm.sh" ]; then
	. "$NVM_DIR/nvm.sh" 2>/dev/null
fi
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
}

cd "$REPO_DIR" || { log "Cannot cd to $REPO_DIR"; exit 1; }

# Get running version from local validator (if running)
RUNNING_VERSION=$(curl -s --connect-timeout 3 http://localhost:9000/peer/health 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin).get('version',''))" 2>/dev/null || echo "")
log "Check: running=$RUNNING_VERSION"

# Fetch latest from GitHub
git fetch origin main --quiet 2>/dev/null || { log "Git fetch failed."; exit 0; }

LOCAL=$(git rev-parse HEAD 2>/dev/null || echo "")
REMOTE=$(git rev-parse origin/main 2>/dev/null || echo "")

if [ "$LOCAL" = "$REMOTE" ]; then
	# Code is current. Check if running version matches built version.
	BUILT_VERSION=$(grep -o '"[0-9]*\.[0-9]*\.[0-9]*"' packages/node/src/version.ts 2>/dev/null | tr -d '"' || echo "")
	if [ -n "$BUILT_VERSION" ] && [ -n "$RUNNING_VERSION" ] && [ "$BUILT_VERSION" = "$RUNNING_VERSION" ]; then
		log "Up to date: $BUILT_VERSION"
		exit 0
	fi
	if [ -z "$RUNNING_VERSION" ]; then
		log "Validators not running. Skipping."
		exit 0
	fi
	if [ -n "$BUILT_VERSION" ] && [ "$BUILT_VERSION" != "$RUNNING_VERSION" ]; then
		log "Running $RUNNING_VERSION but built $BUILT_VERSION. Need restart."
	fi
else
	# New code available
	OLD_VERSION=$(grep -o '"[0-9]*\.[0-9]*\.[0-9]*"' packages/node/src/version.ts 2>/dev/null | tr -d '"' || echo "unknown")
	log "New code: $LOCAL -> $REMOTE (current: $OLD_VERSION)"

	git pull origin main --quiet 2>/dev/null || { log "Git pull failed."; exit 0; }

	# Check for genesis change
	if [ -f "$REPO_DIR/genesis.json" ] && [ -f "$LOG_DIR/genesis.json" ]; then
		NEW_HASH=$(shasum -a 256 "$REPO_DIR/genesis.json" 2>/dev/null | awk '{print $1}' || md5sum "$REPO_DIR/genesis.json" 2>/dev/null | awk '{print $1}' || echo "")
		OLD_HASH=$(shasum -a 256 "$LOG_DIR/genesis.json" 2>/dev/null | awk '{print $1}' || md5sum "$LOG_DIR/genesis.json" 2>/dev/null | awk '{print $1}' || echo "")
		if [ -n "$NEW_HASH" ] && [ -n "$OLD_HASH" ] && [ "$NEW_HASH" != "$OLD_HASH" ]; then
			log "Genesis changed. Wiping chain data."
			cp "$REPO_DIR/genesis.json" "$LOG_DIR/genesis.json"
			for i in $(seq 0 9); do
				rm -rf "$LOG_DIR/validator-$i/chain" 2>/dev/null
			done
		fi
	elif [ -f "$REPO_DIR/genesis.json" ]; then
		cp "$REPO_DIR/genesis.json" "$LOG_DIR/genesis.json"
	fi

	# Build
	log "Building..."
	if ! pnpm install --frozen-lockfile >> "$LOG_FILE" 2>&1; then
		log "pnpm install failed."
	fi
	if ! pnpm build >> "$LOG_FILE" 2>&1; then
		log "BUILD FAILED. Reverting."
		git reset --hard "$LOCAL" --quiet 2>/dev/null
		exit 1
	fi

	BUILT_VERSION=$(grep -o '"[0-9]*\.[0-9]*\.[0-9]*"' packages/node/src/version.ts 2>/dev/null | tr -d '"' || echo "unknown")
	log "Built $BUILT_VERSION"
fi

# Restart validators
log "Restarting validators..."

if [ -f "$REPO_DIR/scripts/start-mini.sh" ] && [ -f "$CONFIG_FILE" ]; then
	TUNNEL_NAME=$(python3 -c "import json; print(json.load(open('$CONFIG_FILE')).get('name',''))" 2>/dev/null || echo "")
	PEERS=$(python3 -c "import json; print(','.join(json.load(open('$CONFIG_FILE')).get('peers',[])))" 2>/dev/null || echo "")
	if [ -n "$TUNNEL_NAME" ] && [ -n "$PEERS" ]; then
		bash "$REPO_DIR/scripts/start-mini.sh" stop 2>/dev/null
		sleep 3
		bash "$REPO_DIR/scripts/start-mini.sh" "$TUNNEL_NAME" "$PEERS" >> "$LOG_FILE" 2>&1
		log "Restarted via start-mini.sh ($TUNNEL_NAME)"
		exit 0
	fi
fi

if [ -f "$REPO_DIR/scripts/start-all.sh" ]; then
	bash "$REPO_DIR/scripts/start-all.sh" stop 2>/dev/null
	sleep 3
	bash "$REPO_DIR/scripts/start-all.sh" >> "$LOG_FILE" 2>&1
	log "Restarted via start-all.sh"
	exit 0
fi

log "No restart script found."
