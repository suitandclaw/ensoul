#!/usr/bin/env bash
#
# start-cometbft-validators.sh
#
# Starts all CometBFT validators on this machine plus one shared ABCI server.
# Auto-detects the machine and validator range.
#
# Prerequisites:
#   1. Go installed: brew install go
#   2. CometBFT installed: go install github.com/cometbft/cometbft/cmd/cometbft@v0.38.17
#   3. Setup complete: ./scripts/setup-cometbft-local.sh
#
# Usage:
#   ./scripts/start-cometbft-validators.sh
#   ./scripts/start-cometbft-validators.sh stop
#

set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
COMETBFT_DIR="$HOME/.cometbft-ensoul"
COMETBFT_BIN="$HOME/go/bin/cometbft"
LOG_DIR="$HOME/.ensoul"

log() { echo "[$(date +%H:%M:%S)] $1"; }

# ── Detect machine ────────────────────────────────────────────────────

detect_machine() {
	local hostname
	hostname=$(hostname)
	case "$hostname" in
		*MacBook*|*MBP*|Suits*)  echo "mbp" ;;
		*[Hh]amster*)            echo "mini1" ;;
		*[Mm]egaphone*)          echo "mini2" ;;
		*[Ss]nitch*)             echo "mini3" ;;
		*)                       echo "unknown" ;;
	esac
}

MACHINE=$(detect_machine)

case "$MACHINE" in
	mbp)   VSTART=0;  VEND=4  ;;
	mini1) VSTART=5;  VEND=14 ;;
	mini2) VSTART=15; VEND=24 ;;
	mini3) VSTART=25; VEND=34 ;;
	*)     log "ERROR: Unknown machine"; exit 1 ;;
esac

VCOUNT=$((VEND - VSTART + 1))
log "Machine: $MACHINE (v$VSTART through v$VEND, $VCOUNT validators)"

# ── Stop ──────────────────────────────────────────────────────────────

if [ "${1:-}" = "stop" ]; then
	log "Stopping all CometBFT processes..."
	for vi in $(seq "$VSTART" "$VEND"); do
		LOCAL_IDX=$((vi - VSTART))
		P2P_PORT=$((26656 + LOCAL_IDX * 10))
		pid=$(lsof -ti ":$P2P_PORT" 2>/dev/null | head -1)
		if [ -n "$pid" ]; then
			kill "$pid" 2>/dev/null || true
			log "  v$vi (port $P2P_PORT): stopped"
		fi
	done
	# Stop ABCI server
	pid=$(lsof -ti :26658 2>/dev/null | head -1)
	if [ -n "$pid" ]; then
		kill "$pid" 2>/dev/null || true
		log "  ABCI server: stopped"
	fi
	log "Done"
	exit 0
fi

# ── Preflight ─────────────────────────────────────────────────────────

if [ ! -x "$COMETBFT_BIN" ]; then
	log "ERROR: CometBFT not found at $COMETBFT_BIN"
	log "Install: brew install go && go install github.com/cometbft/cometbft/cmd/cometbft@v0.38.17"
	exit 1
fi
log "CometBFT: $($COMETBFT_BIN version 2>&1)"

# Check all validator dirs exist
MISSING=0
for vi in $(seq "$VSTART" "$VEND"); do
	if [ ! -f "$COMETBFT_DIR/v$vi/config/genesis.json" ]; then
		log "ERROR: Missing config for v$vi"
		MISSING=$((MISSING + 1))
	fi
done
if [ "$MISSING" -gt 0 ]; then
	log "Run: ./scripts/setup-cometbft-local.sh"
	exit 1
fi

# ── Clear stale state ─────────────────────────────────────────────────

rm -rf /tmp/ensoul-abci
for vi in $(seq "$VSTART" "$VEND"); do
	rm -rf "$COMETBFT_DIR/v$vi/data/blockstore.db"
	rm -rf "$COMETBFT_DIR/v$vi/data/state.db"
	rm -rf "$COMETBFT_DIR/v$vi/data/evidence.db"
	rm -rf "$COMETBFT_DIR/v$vi/data/tx_index.db"
	rm -rf "$COMETBFT_DIR/v$vi/data/cs.wal"
	echo '{"height":"0","round":0,"step":0}' > "$COMETBFT_DIR/v$vi/data/priv_validator_state.json"
done

# ── Start ABCI server ────────────────────────────────────────────────

log "Starting ABCI server (port 26658)..."
cd "$REPO_DIR"

# Source nvm if available (for Minis)
if [ -f "$HOME/.nvm/nvm.sh" ]; then
	export NVM_DIR="$HOME/.nvm"
	. "$NVM_DIR/nvm.sh"
fi

npx tsx packages/abci-server/src/index.ts --port 26658 \
	> "$LOG_DIR/abci-server.log" 2>&1 &
ABCI_PID=$!
log "  ABCI server: pid $ABCI_PID"
sleep 4

# ── Start CometBFT validators ────────────────────────────────────────

log "Starting $VCOUNT CometBFT validators..."
PIDS=""
for vi in $(seq "$VSTART" "$VEND"); do
	LOCAL_IDX=$((vi - VSTART))
	P2P_PORT=$((26656 + LOCAL_IDX * 10))

	"$COMETBFT_BIN" start --home "$COMETBFT_DIR/v$vi" \
		> "$LOG_DIR/cometbft-v$vi.log" 2>&1 &
	pid=$!
	PIDS="$PIDS $pid"
	log "  v$vi: pid $pid, p2p=$P2P_PORT"
done

# ── Wait and verify ──────────────────────────────────────────────────

log ""
log "Waiting for peers..."
sleep 15

# Check the first validator's status
RPC_PORT=$((26657))
HEIGHT=$(curl -s "http://localhost:$RPC_PORT/status" 2>/dev/null | \
	python3 -c "import sys,json; print(json.load(sys.stdin)['result']['sync_info']['latest_block_height'])" 2>/dev/null || echo "0")
PEERS=$(curl -s "http://localhost:$RPC_PORT/net_info" 2>/dev/null | \
	python3 -c "import sys,json; print(json.load(sys.stdin)['result']['n_peers'])" 2>/dev/null || echo "0")

log ""
log "=== STATUS ==="
log "  Height: $HEIGHT (0 is normal if waiting for 24+ validators)"
log "  Peers: $PEERS"
log "  ABCI: pid $ABCI_PID"
log "  Validators: $VCOUNT running"
log ""
log "Logs:"
log "  tail -f $LOG_DIR/abci-server.log"
log "  tail -f $LOG_DIR/cometbft-v$VSTART.log"
log ""
log "To stop: ./scripts/start-cometbft-validators.sh stop"
