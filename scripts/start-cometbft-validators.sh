#!/usr/bin/env bash
#
# start-cometbft-validators.sh
#
# Starts ONE CometBFT node + ONE ABCI server on this machine.
# Each machine runs a single validator with aggregate voting power.
#
# Architecture (matches production Cosmos chains):
#   MBP:   v0 key, power=21.4M (14.3%)
#   Mini1: v5 key, power=42.8M (28.6%)
#   Mini2: v15 key, power=42.8M (28.6%)
#   Mini3: v25 key, power=42.8M (28.6%)
#   3 of 4 needed for consensus (71% > 67%)
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

# Each machine uses the FIRST validator's key (v0, v5, v15, v25)
case "$MACHINE" in
	mbp)   VALIDATOR=0;  TAILSCALE_IP="100.67.81.90" ;;
	mini1) VALIDATOR=5;  TAILSCALE_IP="100.86.108.114" ;;
	mini2) VALIDATOR=15; TAILSCALE_IP="100.117.84.28" ;;
	mini3) VALIDATOR=25; TAILSCALE_IP="100.127.140.26" ;;
	*)     log "ERROR: Unknown machine (hostname: $(hostname))"; exit 1 ;;
esac

log "Machine: $MACHINE, validator: v$VALIDATOR, IP: $TAILSCALE_IP"

# ── Stop ──────────────────────────────────────────────────────────────

if [ "${1:-}" = "stop" ]; then
	log "Stopping..."
	lsof -ti :26656 2>/dev/null | xargs kill 2>/dev/null || true
	lsof -ti :26657 2>/dev/null | xargs kill 2>/dev/null || true
	lsof -ti :26658 2>/dev/null | xargs kill 2>/dev/null || true
	# Also kill any old multi-validator processes
	for port in 26666 26676 26686 26696 26706 26716 26726 26736 26746; do
		lsof -ti ":$port" 2>/dev/null | xargs kill 2>/dev/null || true
	done
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

# ── Set up node directory ─────────────────────────────────────────────

NODE_DIR="$COMETBFT_DIR/node"
rm -rf "$NODE_DIR" /tmp/ensoul-abci
mkdir -p "$NODE_DIR/config" "$NODE_DIR/data"

# Initialize to get default config
"$COMETBFT_BIN" init --home "$NODE_DIR" 2>/dev/null || true

# Copy genesis from repo
cp "$REPO_DIR/cometbft-genesis.json" "$NODE_DIR/config/genesis.json"

# Copy validator key (from setup-cometbft-local.sh or convert script)
KEY_SRC="$COMETBFT_DIR/v$VALIDATOR/config/priv_validator_key.json"
if [ ! -f "$KEY_SRC" ]; then
	log "ERROR: No validator key at $KEY_SRC"
	log "Run: ./scripts/setup-cometbft-local.sh"
	exit 1
fi
cp "$KEY_SRC" "$NODE_DIR/config/priv_validator_key.json"

# Copy node key
NODE_KEY_SRC="$COMETBFT_DIR/v$VALIDATOR/config/node_key.json"
if [ -f "$NODE_KEY_SRC" ]; then
	cp "$NODE_KEY_SRC" "$NODE_DIR/config/node_key.json"
fi

# Fresh validator state
echo '{"height":"0","round":0,"step":0}' > "$NODE_DIR/data/priv_validator_state.json"

# ── Configure ─────────────────────────────────────────────────────────

CONFIG="$NODE_DIR/config/config.toml"

# ABCI connection
sed -i '' 's|proxy_app = .*|proxy_app = "tcp://127.0.0.1:26658"|' "$CONFIG"
sed -i '' "s|moniker = .*|moniker = \"ensoul-$MACHINE\"|" "$CONFIG"

# P2P: listen on all interfaces, advertise Tailscale IP
sed -i '' 's|laddr = "tcp://0.0.0.0:26656"|laddr = "tcp://0.0.0.0:26656"|' "$CONFIG"
sed -i '' "s|external_address = .*|external_address = \"$TAILSCALE_IP:26656\"|" "$CONFIG"

# Build persistent peers (all OTHER machines)
# Node IDs from the configs we generated
PEERS=""
for entry in "0:100.67.81.90" "5:100.86.108.114" "15:100.117.84.28" "25:100.127.140.26"; do
	v="${entry%%:*}"
	ip="${entry##*:}"
	[ "$v" = "$VALIDATOR" ] && continue  # Skip self
	nk_file="$REPO_DIR/cometbft-configs/v$v/node_key.json"
	if [ -f "$nk_file" ]; then
		# Derive node ID from node key
		node_id=$(python3 -c "
import json, hashlib, base64
nk = json.load(open('$nk_file'))
pk_b64 = nk['priv_key']['value']
pk_bytes = base64.b64decode(pk_b64)
pubkey = pk_bytes[32:64]
print(hashlib.sha256(pubkey).hexdigest()[:40])
" 2>/dev/null)
		[ -n "$PEERS" ] && PEERS="$PEERS,"
		PEERS="${PEERS}${node_id}@${ip}:26656"
	fi
done

sed -i '' "s|persistent_peers = .*|persistent_peers = \"$PEERS\"|" "$CONFIG"

# Network settings
sed -i '' 's/allow_duplicate_ip = false/allow_duplicate_ip = true/' "$CONFIG"
sed -i '' 's/addr_book_strict = true/addr_book_strict = false/' "$CONFIG"

# RPC on all interfaces (for tunnel access)
sed -i '' 's|laddr = "tcp://127.0.0.1:26657"|laddr = "tcp://0.0.0.0:26657"|' "$CONFIG"

log "Peers: $PEERS"

# ── Start ABCI server ────────────────────────────────────────────────

log "Starting ABCI server..."
cd "$REPO_DIR"

# Source nvm if available
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ -f "$NVM_DIR/nvm.sh" ]; then . "$NVM_DIR/nvm.sh"; fi
export PATH="$HOME/.local/share/pnpm:$PATH" 2>/dev/null || true

if ! command -v npx >/dev/null 2>&1; then
	log "ERROR: npx not found"
	exit 1
fi

npx tsx packages/abci-server/src/index.ts --port 26658 \
	> "$LOG_DIR/abci-server.log" 2>&1 &
ABCI_PID=$!
sleep 5

if ! kill -0 "$ABCI_PID" 2>/dev/null; then
	log "ERROR: ABCI server crashed"
	tail -5 "$LOG_DIR/abci-server.log"
	exit 1
fi
log "  ABCI: pid $ABCI_PID"

# ── Start CometBFT ───────────────────────────────────────────────────

log "Starting CometBFT..."
"$COMETBFT_BIN" start --home "$NODE_DIR" > "$LOG_DIR/cometbft.log" 2>&1 &
CMT_PID=$!
log "  CometBFT: pid $CMT_PID"

echo "{\"abci\": $ABCI_PID, \"cometbft\": $CMT_PID}" > "$COMETBFT_DIR/pids.json"

# ── Wait for peers and blocks ─────────────────────────────────────────

log ""
log "Waiting for peers and blocks..."
for i in $(seq 1 30); do
	height=$(curl -s http://localhost:26657/status 2>/dev/null | \
		python3 -c "import sys,json; print(json.load(sys.stdin)['result']['sync_info']['latest_block_height'])" 2>/dev/null || echo "0")
	peers=$(curl -s http://localhost:26657/net_info 2>/dev/null | \
		python3 -c "import sys,json; print(json.load(sys.stdin)['result']['n_peers'])" 2>/dev/null || echo "0")

	if [ "$height" != "0" ] && [ "$height" != "" ]; then
		log "  BLOCKS PRODUCING! Height: $height, Peers: $peers"
		break
	fi
	[ "$((i % 5))" = "0" ] && log "  Height: $height, Peers: $peers (waiting...)"
	sleep 5
done

log ""
log "=== STATUS ==="
curl -s http://localhost:26657/status 2>/dev/null | python3 -c "
import sys,json
d = json.load(sys.stdin)['result']
si = d['sync_info']
vi = d['validator_info']
print(f'  Height: {si[\"latest_block_height\"]}')
print(f'  Validator: {vi[\"address\"]}')
print(f'  Power: {vi[\"voting_power\"]}')
" 2>/dev/null || echo "  NOT RESPONDING"
curl -s http://localhost:26657/net_info 2>/dev/null | python3 -c "
import sys,json; print(f'  Peers: {json.load(sys.stdin)[\"result\"][\"n_peers\"]}')
" 2>/dev/null

log ""
log "Logs:"
log "  tail -f $LOG_DIR/cometbft.log"
log "  tail -f $LOG_DIR/abci-server.log"
log "To stop: ./scripts/start-cometbft-validators.sh stop"
