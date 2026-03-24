#!/usr/bin/env bash
#
# start-cometbft-mini.sh: Start CometBFT + ABCI server on a Mac Mini.
#
# Uses the tunnel validator's converted key (validator-0 on the Mini,
# which maps to V5/V15/V25 in the genesis depending on the machine).
#
# The genesis must match exactly across all machines. Copy it from MBP
# or generate it using scripts/generate-cometbft-genesis.ts.
#
# Usage:
#   ./scripts/start-cometbft-mini.sh <mbp-node-id>
#
# Example:
#   ./scripts/start-cometbft-mini.sh abc123def456@v0.ensoul.dev:26656
#
# The mbp-node-id is shown in MBP's CometBFT logs or via:
#   curl -s http://localhost:26657/status | jq .result.node_info.id
#

set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
HOME_DIR="$HOME"
COMETBFT_DIR="$HOME_DIR/.cometbft-ensoul"
ENSOUL_DIR="$HOME_DIR/.ensoul"
LOG_DIR="$ENSOUL_DIR"
COMETBFT_BIN="$HOME_DIR/go/bin/cometbft"

log() { echo "[$(date +%H:%M:%S)] $1"; }

MBP_PEER="${1:-}"

if [ -z "$MBP_PEER" ]; then
	echo "Usage: $0 <mbp-node-id>@<mbp-address>:26656"
	echo ""
	echo "Get the MBP node ID by running on MBP:"
	echo "  curl -s http://localhost:26657/status | python3 -c \"import sys,json; print(json.load(sys.stdin)['result']['node_info']['id'])\""
	echo ""
	echo "Then pass: <node-id>@v0.ensoul.dev:26656"
	exit 1
fi

# ── Preflight ─────────────────────────────────────────────────────────

if [ ! -x "$COMETBFT_BIN" ]; then
	log "ERROR: CometBFT binary not found at $COMETBFT_BIN"
	log "Install: brew install go && go install github.com/cometbft/cometbft/cmd/cometbft@v0.38.17"
	exit 1
fi
log "CometBFT: $($COMETBFT_BIN version 2>&1)"

if [ ! -f "$COMETBFT_DIR/validator-0/config/priv_validator_key.json" ]; then
	log "ERROR: No converted CometBFT keys found"
	log "Run: cd ~/ensoul && npx tsx scripts/convert-keys-to-cometbft.ts --genesis genesis-config-v3.json"
	exit 1
fi

if [ ! -f "$COMETBFT_DIR/genesis-production.json" ]; then
	log "ERROR: Production genesis not found at $COMETBFT_DIR/genesis-production.json"
	log "Copy from MBP or generate: npx tsx scripts/generate-cometbft-genesis.ts"
	exit 1
fi

# ── Set up CometBFT node ─────────────────────────────────────────────

CMT_HOME="$COMETBFT_DIR/node"
log "Setting up CometBFT node at $CMT_HOME..."

rm -rf "$CMT_HOME"
mkdir -p "$CMT_HOME/config" "$CMT_HOME/data"

# Initialize with defaults then overwrite
"$COMETBFT_BIN" init --home "$CMT_HOME" 2>/dev/null || true

# Copy production genesis and validator key
cp "$COMETBFT_DIR/genesis-production.json" "$CMT_HOME/config/genesis.json"
cp "$COMETBFT_DIR/validator-0/config/priv_validator_key.json" "$CMT_HOME/config/"
echo '{"height":"0","round":0,"step":0}' > "$CMT_HOME/data/priv_validator_state.json"

# Configure
sed -i '' "s|proxy_app = .*|proxy_app = \"tcp://127.0.0.1:26658\"|" "$CMT_HOME/config/config.toml"
sed -i '' "s|persistent_peers = .*|persistent_peers = \"$MBP_PEER\"|" "$CMT_HOME/config/config.toml"
sed -i '' 's/allow_duplicate_ip = false/allow_duplicate_ip = true/' "$CMT_HOME/config/config.toml"
sed -i '' 's/addr_book_strict = true/addr_book_strict = false/' "$CMT_HOME/config/config.toml"

log "Config: peer=$MBP_PEER"

# ── Start ABCI server ────────────────────────────────────────────────

log "Starting ABCI server..."
rm -rf /tmp/ensoul-abci
cd "$REPO_DIR"
npx tsx packages/abci-server/src/index.ts --port 26658 \
	> "$LOG_DIR/abci-server.log" 2>&1 &
ABCI_PID=$!
log "ABCI server: pid $ABCI_PID"
sleep 4

# ── Start CometBFT ───────────────────────────────────────────────────

log "Starting CometBFT..."
"$COMETBFT_BIN" start --home "$CMT_HOME" \
	> "$LOG_DIR/cometbft.log" 2>&1 &
CMT_PID=$!
log "CometBFT: pid $CMT_PID"

echo "{\"abci\": $ABCI_PID, \"cometbft\": $CMT_PID}" > "$COMETBFT_DIR/pids.json"

# ── Wait for sync ────────────────────────────────────────────────────

log "Waiting for sync..."
for i in $(seq 1 60); do
	height=$(curl -s http://localhost:26657/status 2>/dev/null | \
		python3 -c "import sys,json; d=json.load(sys.stdin)['result']['sync_info']; print(f'{d[\"latest_block_height\"]} catching_up={d[\"catching_up\"]}' )" 2>/dev/null || echo "0")

	if [ "$height" != "0" ]; then
		log "  Height: $height"
		if echo "$height" | grep -q "catching_up=false"; then
			log "Sync complete!"
			break
		fi
	fi
	sleep 5
done

# ── Verify ────────────────────────────────────────────────────────────

log ""
log "=== STATUS ==="
curl -s http://localhost:26657/status 2>/dev/null | python3 -c "
import sys,json
d = json.load(sys.stdin)['result']
si = d['sync_info']
vi = d['validator_info']
print(f'  Height: {si[\"latest_block_height\"]}')
print(f'  Catching up: {si[\"catching_up\"]}')
print(f'  Validator: {vi[\"address\"]}')
print(f'  Power: {vi[\"voting_power\"]}')
" 2>/dev/null || echo "  NOT RESPONDING"

log ""
log "Logs:"
log "  tail -f $LOG_DIR/cometbft.log"
log "  tail -f $LOG_DIR/abci-server.log"
log ""
log "To stop:"
log "  kill $ABCI_PID $CMT_PID"
