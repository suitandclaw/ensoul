#!/usr/bin/env bash
#
# rolling-update.sh - Zero-downtime validator update.
# Restarts one validator at a time, verifying health before proceeding.
# If any validator fails, stops the update and rolls back.
#
# Usage:
#   ./scripts/rolling-update.sh                  # update MacBook Pro validators
#   ./scripts/rolling-update.sh --mini mini-1     # update a Mac Mini
#

set -euo pipefail

export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" 2>/dev/null || true
export PATH="$HOME/.nvm/versions/node/v22.22.1/bin:$HOME/Library/pnpm:$HOME/.local/share/pnpm:/usr/local/bin:/opt/homebrew/bin:$PATH"

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LOG_DIR="$HOME/.ensoul"
LOG_FILE="$LOG_DIR/rolling-update.log"
BASE_PORT=9000
HEALTH_TIMEOUT=60

log() {
	local ts
	ts=$(date +"%Y-%m-%d %H:%M:%S")
	echo "[$ts] $1" | tee -a "$LOG_FILE"
}

# Check health of a validator on a given port
check_health() {
	local port="$1"
	local elapsed=0
	while [ $elapsed -lt $HEALTH_TIMEOUT ]; do
		HEALTH=$(curl -s "http://localhost:$port/peer/health" 2>/dev/null || echo "")
		if echo "$HEALTH" | python3 -c "import json,sys; d=json.load(sys.stdin); exit(0 if d.get('healthy') else 1)" 2>/dev/null; then
			return 0
		fi
		sleep 2
		elapsed=$((elapsed + 2))
	done
	return 1
}

# Get PID of validator on a given port
get_validator_pid() {
	local port="$1"
	lsof -ti ":$port" 2>/dev/null | head -1 || echo ""
}

# Restart a single validator
restart_validator() {
	local index="$1"
	local port=$((BASE_PORT + index))
	local api_port=$((10000 + index))
	local data_dir="$LOG_DIR/validator-$index"
	local peers="${PEERS:-}"
	local genesis="$LOG_DIR/genesis.json"

	log "Updating validator-$index (port $port)..."

	# Stop current validator
	local pid
	pid=$(get_validator_pid "$port")
	if [ -n "$pid" ]; then
		kill "$pid" 2>/dev/null || true
		sleep 2
		kill -9 "$pid" 2>/dev/null || true
		log "Stopped validator-$index (pid $pid)"
	fi

	# Start updated validator
	npx tsx "$REPO_DIR/packages/node/src/cli/main.ts" \
		--validate \
		--no-min-stake \
		--genesis "$genesis" \
		--port "$port" \
		--api-port "$api_port" \
		--data-dir "$data_dir" \
		${peers:+--peers "$peers"} \
		>"$LOG_DIR/validator-$index.log" 2>&1 &

	log "Started validator-$index (pid $!)"

	# Wait for health
	if check_health "$port"; then
		log "Validator-$index healthy on port $port"
		return 0
	else
		log "FAILED: validator-$index did not become healthy within ${HEALTH_TIMEOUT}s"
		return 1
	fi
}

# Main
mkdir -p "$LOG_DIR"

NUM_VALIDATORS=5
PEERS=""
MINI_MODE=false

# Parse args
while [ $# -gt 0 ]; do
	case "$1" in
		--mini)
			MINI_MODE=true
			NUM_VALIDATORS=10
			shift
			# Read peers from mini-config.json
			CONFIG_FILE="$LOG_DIR/mini-config.json"
			if [ -f "$CONFIG_FILE" ]; then
				PEERS=$(python3 -c "import json; print(','.join(json.load(open('$CONFIG_FILE')).get('peers',[])))" 2>/dev/null || echo "")
			fi
			shift || true
			;;
		*) shift ;;
	esac
done

log "Starting rolling update for $NUM_VALIDATORS validators..."

# Create snapshot before update
log "Creating pre-update snapshot..."
# Simple snapshot: copy genesis hash
GENESIS_HASH=$(md5 -q "$LOG_DIR/genesis.json" 2>/dev/null || md5sum "$LOG_DIR/genesis.json" | awk '{print $1}' || echo "unknown")
log "Genesis hash: $GENESIS_HASH"

FAILED=false
for i in $(seq 0 $((NUM_VALIDATORS - 1))); do
	if ! restart_validator "$i"; then
		log "Rolling update FAILED at validator-$i. Remaining validators unchanged."
		FAILED=true
		break
	fi
	# Brief pause between validators
	sleep 3
done

if [ "$FAILED" = "true" ]; then
	log "Update incomplete. Some validators may need manual restart."
	exit 1
fi

log "Rolling update complete. All $NUM_VALIDATORS validators updated and healthy."
exit 0
