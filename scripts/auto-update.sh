#!/usr/bin/env bash
#
# auto-update.sh - Automatic update for Ensoul validators.
# Checks GitHub, pulls, tests, and does rolling restart.
# Network never has all validators down simultaneously.
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
SNAPSHOT_DIR="$LOG_DIR/snapshots"

mkdir -p "$LOG_DIR" "$SNAPSHOT_DIR"

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

# 2. Save current version and genesis hash
OLD_VERSION=$(grep -o '"[0-9]*\.[0-9]*\.[0-9]*"' packages/node/src/version.ts 2>/dev/null | tr -d '"' || echo "unknown")
OLD_GENESIS_HASH=$(md5 -q "$LOG_DIR/genesis.json" 2>/dev/null || md5sum "$LOG_DIR/genesis.json" 2>/dev/null | awk '{print $1}' || echo "none")
log "Current: version=$OLD_VERSION genesis=$OLD_GENESIS_HASH"

# 3. Create snapshot before update
log "Creating pre-update snapshot..."
SNAP_NAME=$(date +"%Y%m%d-%H%M%S")
SNAP_DIR="$SNAPSHOT_DIR/$SNAP_NAME"
mkdir -p "$SNAP_DIR"
echo "{\"version\":\"$OLD_VERSION\",\"genesis\":\"$OLD_GENESIS_HASH\",\"commit\":\"$LOCAL\",\"timestamp\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}" > "$SNAP_DIR/meta.json"
# Copy chain data for first validator as representative snapshot
if [ -d "$LOG_DIR/validator-0/chain" ]; then
	cp -r "$LOG_DIR/validator-0/chain" "$SNAP_DIR/chain" 2>/dev/null || true
fi
log "Snapshot saved: $SNAP_DIR"

# Prune old snapshots (keep last 5)
ls -dt "$SNAPSHOT_DIR"/*/ 2>/dev/null | tail -n +6 | xargs rm -rf 2>/dev/null || true

# 4. Pull latest code
log "Pulling latest code..."
git pull origin main --quiet 2>/dev/null || { log "Git pull failed. Skipping."; exit 0; }

# 5. Build (safe: revert on failure)
log "Building..."
if ! pnpm build >> "$LOG_FILE" 2>&1; then
	log "BUILD FAILED. Reverting to $LOCAL."
	git reset --hard "$LOCAL" --quiet 2>/dev/null || true
	exit 1
fi

# 6. Run tests (unit tests only, not full smoke test)
log "Running tests..."
if ! pnpm test >> "$LOG_FILE" 2>&1; then
	log "TESTS FAILED. Keeping current running version. Code reverted."
	git reset --hard "$LOCAL" --quiet 2>/dev/null || true
	pnpm build >> "$LOG_FILE" 2>&1 || true
	exit 1
fi
log "Tests passed."

# 7. Check what changed
NEW_VERSION=$(grep -o '"[0-9]*\.[0-9]*\.[0-9]*"' packages/node/src/version.ts 2>/dev/null | tr -d '"' || echo "unknown")
NEEDS_RESTART=false
NEEDS_CHAIN_WIPE=false

# Genesis change
if [ -f "$REPO_DIR/genesis.json" ]; then
	NEW_GENESIS_HASH=$(md5 -q "$REPO_DIR/genesis.json" 2>/dev/null || md5sum "$REPO_DIR/genesis.json" | awk '{print $1}')
	if [ "$NEW_GENESIS_HASH" != "$OLD_GENESIS_HASH" ]; then
		log "Genesis changed ($OLD_GENESIS_HASH -> $NEW_GENESIS_HASH)."
		cp "$REPO_DIR/genesis.json" "$LOG_DIR/genesis.json"
		NEEDS_CHAIN_WIPE=true
		NEEDS_RESTART=true
	fi
fi

# Version change
if [ "$OLD_VERSION" != "$NEW_VERSION" ]; then
	log "Version changed: $OLD_VERSION -> $NEW_VERSION"
	NEEDS_RESTART=true
fi

if [ "$NEEDS_RESTART" = "false" ]; then
	log "Code updated, no restart needed (version=$NEW_VERSION)."
	exit 0
fi

# 8. Wipe chain data if genesis changed
if [ "$NEEDS_CHAIN_WIPE" = "true" ]; then
	log "Wiping chain data (genesis changed)..."
	for i in $(seq 0 9); do
		rm -rf "$LOG_DIR/validator-$i/chain" 2>/dev/null || true
	done
fi

# 9. Rolling restart (one validator at a time)
log "Starting rolling restart ($OLD_VERSION -> $NEW_VERSION)..."

if [ -f "$REPO_DIR/scripts/rolling-update.sh" ]; then
	# Detect if this is a Mini
	MINI_FLAG=""
	if [ -f "$CONFIG_FILE" ]; then
		TUNNEL_NAME=$(python3 -c "import json; print(json.load(open('$CONFIG_FILE')).get('name',''))" 2>/dev/null || echo "")
		if [ -n "$TUNNEL_NAME" ]; then
			MINI_FLAG="--mini $TUNNEL_NAME"
		fi
	fi

	if bash "$REPO_DIR/scripts/rolling-update.sh" $MINI_FLAG >> "$LOG_FILE" 2>&1; then
		log "Rolling restart complete."
	else
		log "Rolling restart FAILED. Attempting rollback..."
		# Restore snapshot
		if [ -d "$SNAP_DIR/chain" ] && [ -d "$LOG_DIR/validator-0" ]; then
			rm -rf "$LOG_DIR/validator-0/chain" 2>/dev/null || true
			cp -r "$SNAP_DIR/chain" "$LOG_DIR/validator-0/chain" 2>/dev/null || true
			log "Snapshot restored for validator-0."
		fi
		git reset --hard "$LOCAL" --quiet 2>/dev/null || true
		pnpm build >> "$LOG_FILE" 2>&1 || true
		log "Rolled back to $OLD_VERSION ($LOCAL)."
		exit 1
	fi
else
	# Fallback: stop all, start all
	log "No rolling-update.sh found. Doing stop/start."
	if [ -f "$REPO_DIR/scripts/start-mini.sh" ]; then
		bash "$REPO_DIR/scripts/start-mini.sh" stop 2>/dev/null || true
		sleep 2
		TUNNEL_NAME=$(python3 -c "import json; print(json.load(open('$CONFIG_FILE')).get('name',''))" 2>/dev/null || echo "")
		PEERS=$(python3 -c "import json; print(','.join(json.load(open('$CONFIG_FILE')).get('peers',[])))" 2>/dev/null || echo "https://v0.ensoul.dev")
		if [ -n "$TUNNEL_NAME" ] && [ -n "$PEERS" ]; then
			bash "$REPO_DIR/scripts/start-mini.sh" "$TUNNEL_NAME" "$PEERS" >> "$LOG_FILE" 2>&1 || log "Restart failed!"
		fi
	elif [ -f "$REPO_DIR/scripts/start-all.sh" ]; then
		bash "$REPO_DIR/scripts/start-all.sh" restart >> "$LOG_FILE" 2>&1 || log "Restart failed!"
	fi
fi

log "Update complete: $OLD_VERSION -> $NEW_VERSION"
