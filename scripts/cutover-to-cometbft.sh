#!/usr/bin/env bash
#
# cutover-to-cometbft.sh: Automated cutover from custom consensus to CometBFT.
#
# Detects the machine (MBP or Mini), stops old validators, starts CometBFT
# nodes with the Ensoul ABCI server, and verifies block production.
#
# Usage:
#   ./scripts/cutover-to-cometbft.sh           # execute cutover
#   ./scripts/cutover-to-cometbft.sh --dry-run  # show what would happen
#   ./scripts/cutover-to-cometbft.sh --rollback  # revert to old validators
#
# Does NOT touch: cloudflared tunnel, explorer, monitor, API, agents.
#

set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ENSOUL_DIR="$HOME/.ensoul"
COMETBFT_DIR="$HOME/.cometbft-ensoul"
COMETBFT_BIN="$HOME/go/bin/cometbft"
LOG_DIR="$ENSOUL_DIR"
ROLLBACK_TIMEOUT=60

log() { echo "[$(date +%H:%M:%S)] $1"; }

# ── Detect Machine ────────────────────────────────────────────────────

detect_machine() {
	local hostname
	hostname=$(hostname)
	case "$hostname" in
		*MacBook*|*MBP*|Suits*)
			echo "mbp"
			;;
		*[Hh]amster*)
			echo "mini1"
			;;
		*[Mm]egaphone*)
			echo "mini2"
			;;
		*[Ss]nitch*)
			echo "mini3"
			;;
		*)
			# Fallback: check validator count
			local count=0
			for i in $(seq 0 9); do
				[ -d "$ENSOUL_DIR/validator-$i" ] && count=$((count + 1))
			done
			if [ "$count" -le 5 ]; then
				echo "mbp"
			else
				echo "mini-unknown"
			fi
			;;
	esac
}

MACHINE=$(detect_machine)
case "$MACHINE" in
	mbp)    NUM_OLD_VALIDATORS=5;  OLD_BASE_PORT=9000 ;;
	mini*)  NUM_OLD_VALIDATORS=10; OLD_BASE_PORT=9000 ;;
esac

log "Machine: $MACHINE ($NUM_OLD_VALIDATORS old validators)"

# ── Preflight Checks ─────────────────────────────────────────────────

preflight() {
	local errors=0

	# CometBFT binary
	if [ ! -x "$COMETBFT_BIN" ]; then
		log "ERROR: CometBFT binary not found at $COMETBFT_BIN"
		errors=$((errors + 1))
	else
		local ver
		ver=$("$COMETBFT_BIN" version 2>&1)
		log "CometBFT version: $ver"
	fi

	# Converted keys
	local key_count=0
	for i in $(seq 0 $((NUM_OLD_VALIDATORS - 1))); do
		if [ -f "$COMETBFT_DIR/validator-$i/config/priv_validator_key.json" ]; then
			key_count=$((key_count + 1))
		fi
	done
	if [ "$key_count" -eq 0 ]; then
		log "ERROR: No converted CometBFT keys found in $COMETBFT_DIR"
		log "  Run: npx tsx scripts/convert-keys-to-cometbft.ts --genesis genesis-config-v3.json"
		errors=$((errors + 1))
	else
		log "Converted keys found: $key_count"
	fi

	# Production genesis
	if [ ! -f "$COMETBFT_DIR/genesis.json" ]; then
		log "ERROR: Production genesis not found at $COMETBFT_DIR/genesis.json"
		log "  Run: npx tsx scripts/generate-cometbft-genesis.ts"
		errors=$((errors + 1))
	else
		log "Production genesis: OK"
	fi

	# ABCI server package
	if [ ! -f "$REPO_DIR/packages/abci-server/src/index.ts" ]; then
		log "ERROR: ABCI server not found"
		errors=$((errors + 1))
	else
		log "ABCI server: OK"
	fi

	# Tunnel
	if pgrep -f cloudflared >/dev/null 2>&1; then
		log "Tunnel: running (will NOT be touched)"
	else
		log "WARNING: Tunnel not running"
	fi

	return $errors
}

# ── Stop Old Validators ──────────────────────────────────────────────

stop_old_validators() {
	log "Stopping old custom consensus validators..."
	for i in $(seq 0 $((NUM_OLD_VALIDATORS - 1))); do
		local port=$((OLD_BASE_PORT + i))
		local pid
		pid=$(lsof -ti ":$port" 2>/dev/null | head -1)
		if [ -n "$pid" ]; then
			# Filter out cloudflared (we must not kill it)
			local proc_name
			proc_name=$(ps -p "$pid" -o comm= 2>/dev/null || echo "")
			if echo "$proc_name" | grep -q "cloudflare"; then
				continue
			fi
			kill "$pid" 2>/dev/null || true
			log "  Stopped validator-$i (port $port, pid $pid)"
		fi
	done
	sleep 3
	log "Old validators stopped"
}

# ── Start CometBFT Nodes ─────────────────────────────────────────────

start_cometbft() {
	log "Starting CometBFT ABCI server..."

	# Clear stale ABCI state (fresh genesis needs fresh state)
	rm -rf /tmp/ensoul-abci

	# Start the ABCI server (single process for all validators on this machine)
	local abci_port=26658
	cd "$REPO_DIR"
	npx tsx "$REPO_DIR/packages/abci-server/src/index.ts" --port "$abci_port" \
		> "$LOG_DIR/abci-server.log" 2>&1 &
	local abci_pid=$!
	log "  ABCI server started (pid $abci_pid, port $abci_port)"
	sleep 4

	# For the cutover, we run one CometBFT node using the tunnel validator's key
	# (validator-0 on this machine, which is the one CometBFT consensus sees)
	local cmt_home="$COMETBFT_DIR/node"
	rm -rf "$cmt_home"
	mkdir -p "$cmt_home/config" "$cmt_home/data"

	# Initialize with defaults then overwrite
	"$COMETBFT_BIN" init --home "$cmt_home" 2>/dev/null || true

	# Copy production genesis (4 validators) and this machine's key
	if [ -f "$REPO_DIR/cometbft-genesis.json" ]; then
		cp "$REPO_DIR/cometbft-genesis.json" "$cmt_home/config/genesis.json"
	elif [ -f "$COMETBFT_DIR/genesis-production.json" ]; then
		cp "$COMETBFT_DIR/genesis-production.json" "$cmt_home/config/genesis.json"
	else
		log "ERROR: No production genesis found"
		return 1
	fi

	cp "$COMETBFT_DIR/validator-0/config/priv_validator_key.json" "$cmt_home/config/"
	echo '{"height":"0","round":0,"step":0}' > "$cmt_home/data/priv_validator_state.json"

	# Configure proxy_app to point to our ABCI server
	sed -i '' "s|proxy_app = .*|proxy_app = \"tcp://127.0.0.1:$abci_port\"|" "$cmt_home/config/config.toml"

	# Allow duplicate IPs and disable strict address book (private network)
	sed -i '' 's/allow_duplicate_ip = false/allow_duplicate_ip = true/' "$cmt_home/config/config.toml"
	sed -i '' 's/addr_book_strict = true/addr_book_strict = false/' "$cmt_home/config/config.toml"

	# Configure persistent peers (Minis connect to MBP, MBP accepts connections)
	# For Minis, the peer is set via start-cometbft-mini.sh argument

	# Bind RPC to 0.0.0.0 so the tunnel can expose it
	sed -i '' 's|laddr = "tcp://127.0.0.1:26657"|laddr = "tcp://0.0.0.0:26657"|' "$cmt_home/config/config.toml"

	log "Starting CometBFT..."
	"$COMETBFT_BIN" start --home "$cmt_home" \
		> "$LOG_DIR/cometbft.log" 2>&1 &
	local cmt_pid=$!
	log "  CometBFT started (pid $cmt_pid)"

	# Save PIDs
	echo "{\"abci\": $abci_pid, \"cometbft\": $cmt_pid}" > "$COMETBFT_DIR/pids.json"
}

# ── Verify Health ─────────────────────────────────────────────────────

verify_health() {
	local timeout=$1
	local elapsed=0
	log "Waiting for first block (timeout: ${timeout}s)..."

	while [ $elapsed -lt "$timeout" ]; do
		local height
		height=$(curl -s http://localhost:26657/status 2>/dev/null | \
			python3 -c "import sys,json; print(json.load(sys.stdin)['result']['sync_info']['latest_block_height'])" 2>/dev/null || echo "0")

		if [ "$height" != "0" ] && [ "$height" != "" ]; then
			log "CometBFT producing blocks! Height: $height"
			return 0
		fi

		sleep 5
		elapsed=$((elapsed + 5))
	done

	log "ERROR: No blocks produced within ${timeout}s"
	return 1
}

# ── Rollback ──────────────────────────────────────────────────────────

rollback() {
	log "ROLLING BACK to custom consensus..."

	# Kill CometBFT processes
	if [ -f "$COMETBFT_DIR/pids.json" ]; then
		local abci_pid cmt_pid
		abci_pid=$(python3 -c "import json; print(json.load(open('$COMETBFT_DIR/pids.json')).get('abci',0))" 2>/dev/null || echo 0)
		cmt_pid=$(python3 -c "import json; print(json.load(open('$COMETBFT_DIR/pids.json')).get('cometbft',0))" 2>/dev/null || echo 0)
		kill "$abci_pid" 2>/dev/null || true
		kill "$cmt_pid" 2>/dev/null || true
	fi
	lsof -ti :26658 2>/dev/null | xargs kill 2>/dev/null || true
	lsof -ti :26657 2>/dev/null | xargs kill 2>/dev/null || true
	lsof -ti :26656 2>/dev/null | xargs kill 2>/dev/null || true
	sleep 2

	# Restart old validators using the appropriate start script
	case "$MACHINE" in
		mbp)
			log "Restarting MBP validators via start-all.sh..."
			"$REPO_DIR/scripts/start-all.sh"
			;;
		mini1)
			log "Restarting Mini 1 validators..."
			"$REPO_DIR/scripts/start-mini.sh" mini-1 "https://v0.ensoul.dev,https://v2.ensoul.dev,https://v3.ensoul.dev"
			;;
		mini2)
			log "Restarting Mini 2 validators..."
			"$REPO_DIR/scripts/start-mini.sh" mini-2 "https://v0.ensoul.dev,https://v1.ensoul.dev,https://v3.ensoul.dev"
			;;
		mini3)
			log "Restarting Mini 3 validators..."
			"$REPO_DIR/scripts/start-mini.sh" mini-3 "https://v0.ensoul.dev,https://v1.ensoul.dev,https://v2.ensoul.dev"
			;;
	esac

	log "Rollback complete"
}

# ── Main ──────────────────────────────────────────────────────────────

case "${1:-}" in
	--dry-run)
		log "DRY RUN: checking prerequisites only"
		preflight || exit 1
		log "All checks passed. Run without --dry-run to execute cutover."
		;;
	--rollback)
		rollback
		;;
	*)
		log ""
		log "=== ENSOUL COMETBFT CUTOVER ==="
		log ""

		# Preflight
		if ! preflight; then
			log "Preflight checks failed. Fix errors above and retry."
			exit 1
		fi
		log ""

		# Stop old validators
		stop_old_validators

		# Start CometBFT
		start_cometbft

		# Verify
		if verify_health "$ROLLBACK_TIMEOUT"; then
			log ""
			log "=== CUTOVER SUCCESSFUL ==="
			log ""
			log "CometBFT is running. Services (explorer, monitor, API) need"
			log "to be reconnected to CometBFT RPC at http://localhost:26657"
			log ""
			log "To rollback: ./scripts/cutover-to-cometbft.sh --rollback"
		else
			log ""
			log "Cutover FAILED. Initiating rollback..."
			rollback
			exit 1
		fi
		;;
esac
