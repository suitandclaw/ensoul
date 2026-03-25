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

# SAFETY: never wipe a live chain's data directory
if [ -d "$NODE_DIR/data/blockstore.db" ]; then
	log "Existing chain data found. Preserving it."
else
	log "No existing chain data. Initializing fresh node."
	mkdir -p "$NODE_DIR/config" "$NODE_DIR/data"
	"$COMETBFT_BIN" init --home "$NODE_DIR" 2>/dev/null || true
fi

# Clear ABCI server state (it reloads from persisted snapshot)
rm -rf /tmp/ensoul-abci

# Ensure config directory exists
mkdir -p "$NODE_DIR/config" "$NODE_DIR/data"

# Copy genesis from repo (config files are safe to overwrite)
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

# Only write fresh validator state if none exists (first run)
if [ ! -f "$NODE_DIR/data/priv_validator_state.json" ]; then
	echo '{"height":"0","round":0,"step":0}' > "$NODE_DIR/data/priv_validator_state.json"
fi

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

# Only replace the [p2p] section persistent_peers, not mempool gossip settings
python3 -c "
lines = open('$CONFIG').readlines()
out = []
for l in lines:
    if l.strip().startswith('persistent_peers =') and 'gossip' not in l:
        out.append('persistent_peers = \"$PEERS\"\n')
    else:
        out.append(l)
open('$CONFIG', 'w').writelines(out)
"

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

# ── Verify services survived the restart ──────────────────────────────
# Explorer, monitor, API, and cloudflared must not be affected by
# validator restarts. If any are down, restart them.

if [ "$MACHINE" = "mbp" ]; then
	log "Checking services..."

	if ! curl -s http://localhost:3000/ >/dev/null 2>&1; then
		log "  Explorer (3000) is DOWN. Restarting..."
		cd "$REPO_DIR"
		ENSOUL_PEERS="" ENSOUL_VALIDATOR_COUNT=4 \
		npx tsx packages/explorer/start.ts --port 3000 --network-peers "http://localhost:9000" \
			> "$LOG_DIR/explorer.log" 2>&1 &
		log "  Explorer restarted (pid $!)"
	else
		log "  Explorer: OK"
	fi

	if ! curl -s http://localhost:4000/ >/dev/null 2>&1; then
		log "  Monitor (4000) is DOWN. Restarting..."
		cd "$REPO_DIR"
		ENSOUL_STATUS_PASSWORD="ensoul-status-2026" \
		npx tsx packages/monitor/start.ts --port 4000 \
			> "$LOG_DIR/monitor.log" 2>&1 &
		log "  Monitor restarted (pid $!)"
	else
		log "  Monitor: OK"
	fi

	if ! curl -s http://localhost:5050/health >/dev/null 2>&1; then
		log "  API (5050) is DOWN. Restarting..."
		cd "$REPO_DIR"
		ONBOARDING_KEY_PATH="genesis-keys/onboarding.json" \
		TREASURY_KEY_PATH="genesis-keys/treasury.json" \
		ENSOUL_PIONEER_KEY="REDACTED_PIONEER_KEY" \
		npx tsx packages/api/start.ts --port 5050 \
			> "$LOG_DIR/api.log" 2>&1 &
		log "  API restarted (pid $!)"
	else
		log "  API: OK"
	fi

	if ! curl -s http://localhost:9000/peer/health >/dev/null 2>&1; then
		log "  Compat proxy (9000) is DOWN. Restarting..."
		cd "$REPO_DIR"
		npx tsx packages/abci-server/src/compat-proxy.ts --port 9000 \
			> "$LOG_DIR/compat-proxy.log" 2>&1 &
		log "  Proxy restarted (pid $!)"
	else
		log "  Compat proxy: OK"
	fi
fi

# On Minis, check if the compat proxy survived
if [ "$MACHINE" != "mbp" ]; then
	if ! curl -s http://localhost:9000/peer/health >/dev/null 2>&1; then
		log "  Compat proxy (9000) is DOWN. Restarting..."
		cd "$REPO_DIR"
		npx tsx packages/abci-server/src/compat-proxy.ts --port 9000 \
			> "$LOG_DIR/compat-proxy.log" 2>&1 &
		log "  Proxy restarted (pid $!)"
	else
		log "  Compat proxy: OK"
	fi
fi

log ""
log "Logs:"
log "  tail -f $LOG_DIR/cometbft.log"
log "  tail -f $LOG_DIR/abci-server.log"
log "To stop: ./scripts/start-cometbft-validators.sh stop"
