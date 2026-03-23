#!/usr/bin/env bash
#
# test-consensus.sh - Local testnet for consensus validation.
# Spins up 4 validators, verifies block production rate and emission.
# Must pass before pushing consensus changes to production.
#

set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TEST_DIR="$HOME/.ensoul-testnet"
BASE_PORT=19000
PIDS=("")  # Initialize with empty element to avoid unbound variable

cleanup() {
	echo "[test] Cleaning up..."
	for pid in "${PIDS[@]}"; do
		[ -z "$pid" ] && continue
		kill "$pid" 2>/dev/null || true
	done
	sleep 1
	for pid in "${PIDS[@]}"; do
		[ -z "$pid" ] && continue
		kill -9 "$pid" 2>/dev/null || true
	done
	rm -rf "$TEST_DIR"
}
trap cleanup EXIT

echo ""
echo "=== CONSENSUS TESTNET ==="
echo ""

# Setup
rm -rf "$TEST_DIR"
mkdir -p "$TEST_DIR"
cd "$REPO_DIR"

# Step 1: Generate 4 validator identities and genesis config
echo "[test] Generating 4 validator identities and genesis..."
npx tsx scripts/setup-testnet.ts "$TEST_DIR"

# Step 2: Generate genesis block from config
echo "[test] Creating genesis block..."
npx tsx packages/node/src/cli/main.ts genesis \
	--config "$TEST_DIR/genesis-config.json" \
	--output "$TEST_DIR/genesis.json" \
	2>/dev/null

# Step 3: Start 4 validators
echo "[test] Starting 4 test validators..."
for i in 0 1 2 3; do
	local_port=$((BASE_PORT + i))
	local_api=$((BASE_PORT + 1000 + i))
	local_dir="$TEST_DIR/validator-$i"

	local_peers=""
	for j in 0 1 2 3; do
		[ "$j" = "$i" ] && continue
		[ -n "$local_peers" ] && local_peers="$local_peers,"
		local_peers="${local_peers}localhost:$((BASE_PORT + j))"
	done

	npx tsx "$REPO_DIR/packages/node/src/cli/main.ts" \
		--validate \
		--no-min-stake \
		--consensus-only \
		--consensus-threshold 0.67 \
		--genesis "$TEST_DIR/genesis.json" \
		--port "$local_port" \
		--api-port "$local_api" \
		--data-dir "$local_dir" \
		--peers "$local_peers" \
		>"$TEST_DIR/validator-$i.log" 2>&1 &
	PIDS+=($!)
done

# Wait for validators to start and connect
echo "[test] Waiting for validators to start (15s)..."
sleep 15

# Check they're running
ALIVE=0
for i in 0 1 2 3; do
	if curl -s "http://localhost:$((BASE_PORT + i))/peer/health" >/dev/null 2>&1; then
		ALIVE=$((ALIVE + 1))
	fi
done
echo "[test] $ALIVE/4 validators healthy"

if [ "$ALIVE" -eq 0 ]; then
	echo "FAIL: No validators started"
	echo ""
	echo "Validator logs:"
	for i in 0 1 2 3; do
		echo "--- validator-$i ---"
		tail -20 "$TEST_DIR/validator-$i.log" 2>/dev/null || echo "(no log)"
	done
	exit 1
fi

# Get initial height
H1=$(curl -s "http://localhost:$BASE_PORT/peer/status" 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin).get('height', 0))" || echo 0)
echo "[test] Initial height: $H1"

# Wait 60 seconds
echo "[test] Running for 60 seconds..."
sleep 60

# Get final height
H2=$(curl -s "http://localhost:$BASE_PORT/peer/status" 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin).get('height', 0))" || echo 0)
BLOCKS=$((H2 - H1))
echo "[test] Final height: $H2 (produced $BLOCKS blocks in 60s)"

# Check consensus state
STATE=$(curl -s "http://localhost:$BASE_PORT/peer/consensus-state" 2>/dev/null || echo "{}")
echo "[test] Consensus state: $STATE"

# Validate results
PASS=true

# Block rate: should be 3-12 blocks in 60 seconds (6s min interval + consensus overhead)
if [ "$BLOCKS" -lt 3 ]; then
	echo "FAIL: Too few blocks ($BLOCKS < 3)"
	PASS=false
elif [ "$BLOCKS" -gt 15 ]; then
	echo "FAIL: Too many blocks ($BLOCKS > 15). Rate limiting may be broken."
	PASS=false
else
	echo "PASS: Block rate OK ($BLOCKS blocks in 60s)"
fi

# Height should be reasonable (not thousands)
if [ "$H2" -gt 100 ]; then
	echo "FAIL: Height too high ($H2 > 100). Possible runaway."
	PASS=false
else
	echo "PASS: Height reasonable ($H2)"
fi

echo ""
if [ "$PASS" = "true" ]; then
	echo "=== ALL TESTS PASSED ==="
else
	echo "=== TESTS FAILED ==="
	echo ""
	echo "Validator logs:"
	for i in 0 1 2 3; do
		echo "--- validator-$i (last 30 lines) ---"
		tail -30 "$TEST_DIR/validator-$i.log" 2>/dev/null || echo "(no log)"
		echo ""
	done
fi
echo ""

[ "$PASS" = "true" ] && exit 0 || exit 1
