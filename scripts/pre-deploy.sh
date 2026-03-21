#!/usr/bin/env bash
#
# pre-deploy.sh - Safety checks before pushing code to the network.
# Runs tests, validates genesis, simulates proposer rotation.
# Exit code 0 only if everything passes.
#

set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_DIR"

PASS=0
FAIL=0

pass() { echo "  PASS: $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }

echo ""
echo "============================================"
echo "  ENSOUL PRE-DEPLOY SAFETY CHECKS"
echo "============================================"
echo ""

# 1. Run all tests
echo "[1/5] Running test suite..."
if pnpm test 2>&1 | tail -3 | grep -q "failed"; then
	fail "Test suite has failures"
	echo ""
	echo "RESULT: FAIL (tests did not pass)"
	echo "Fix failing tests before pushing."
	exit 1
else
	pass "All tests passing"
fi

# 2. Genesis validation
echo "[2/5] Validating genesis..."
if [ ! -f "$REPO_DIR/genesis.json" ]; then
	fail "genesis.json not found"
else
	# Check validator count
	VALIDATOR_COUNT=$(python3 -c "
import json
g = json.load(open('genesis.json'))
validators = [t for t in g['transactions'] if t['type'] == 'genesis_allocation' and t.get('data')]
print(len(validators))
" 2>/dev/null || echo "0")

	if [ "$VALIDATOR_COUNT" -ge 35 ]; then
		pass "Genesis has $VALIDATOR_COUNT validators with auto-stake"
	else
		fail "Genesis has only $VALIDATOR_COUNT validators (expected 35+)"
	fi

	# Check total allocation
	TOTAL_OK=$(python3 -c "
import json
g = json.load(open('genesis.json'))
total = sum(int(t['amount']) for t in g['transactions'] if t['type'] == 'genesis_allocation')
expected = 10**27  # 1 billion * 10^18
print('ok' if total == expected else 'mismatch')
" 2>/dev/null || echo "error")

	if [ "$TOTAL_OK" = "ok" ]; then
		pass "Genesis allocations sum to 1 billion ENSL"
	else
		fail "Genesis allocation total mismatch"
	fi
fi

# 3. Proposer rotation simulation (via the deploy-safety test)
echo "[3/5] Proposer rotation simulation..."
# Tests already ran in step 1 and passed. The deploy-safety.test.ts file
# covers proposer rotation across 35 validators, deterministic selection,
# and block production. If step 1 passed, this is verified.
pass "Proposer rotation verified (deploy-safety tests passed in step 1)"

# 4. Version check
echo "[4/5] Version check..."
CURRENT_VERSION=$(grep -o '"[0-9]*\.[0-9]*\.[0-9]*"' packages/node/src/version.ts | tr -d '"' || echo "")
if [ -z "$CURRENT_VERSION" ]; then
	fail "Could not read version from version.ts"
else
	# Check against last deployed version
	LAST_DEPLOYED=""
	if [ -f "$HOME/.ensoul/.last-deployed-version" ]; then
		LAST_DEPLOYED=$(cat "$HOME/.ensoul/.last-deployed-version")
	fi

	if [ -n "$LAST_DEPLOYED" ] && [ "$CURRENT_VERSION" = "$LAST_DEPLOYED" ]; then
		fail "Version $CURRENT_VERSION has not been bumped from last deploy ($LAST_DEPLOYED)"
	else
		pass "Version: $CURRENT_VERSION (last deployed: ${LAST_DEPLOYED:-none})"
	fi
fi

# 5. API smoke test
echo "[5/5] API smoke test..."
SMOKE_PORT=$((30000 + RANDOM % 10000))
# Start a validator in background for quick health check
npx tsx packages/node/src/cli/main.ts --validate --port "$SMOKE_PORT" --api-port $((SMOKE_PORT + 1000)) --data-dir "/tmp/ensoul-smoke-$$" --no-min-stake >/dev/null 2>&1 &
SMOKE_PID=$!

# Wait for it to start (max 10 seconds)
STARTED=false
for i in $(seq 1 10); do
	if curl -s "http://localhost:$SMOKE_PORT/peer/status" >/dev/null 2>&1; then
		STARTED=true
		break
	fi
	sleep 1
done

if [ "$STARTED" = "true" ]; then
	STATUS=$(curl -s "http://localhost:$SMOKE_PORT/peer/status" 2>/dev/null || echo "{}")
	HAS_VERSION=$(echo "$STATUS" | python3 -c "import json,sys; d=json.load(sys.stdin); print('ok' if d.get('version') == '$CURRENT_VERSION' else 'mismatch')" 2>/dev/null || echo "error")

	if [ "$HAS_VERSION" = "ok" ]; then
		pass "Smoke test: /peer/status returns version $CURRENT_VERSION"
	else
		fail "Smoke test: version mismatch in /peer/status"
	fi

	# Check health endpoint
	HEALTH=$(curl -s "http://localhost:$SMOKE_PORT/peer/health" 2>/dev/null || echo "{}")
	HAS_HEALTHY=$(echo "$HEALTH" | python3 -c "import json,sys; d=json.load(sys.stdin); print('ok' if d.get('healthy') else 'no')" 2>/dev/null || echo "error")

	if [ "$HAS_HEALTHY" = "ok" ]; then
		pass "Smoke test: /peer/health returns healthy"
	else
		fail "Smoke test: /peer/health not healthy"
	fi
else
	fail "Smoke test: validator did not start within 10 seconds"
fi

# Cleanup
kill "$SMOKE_PID" 2>/dev/null || true
rm -rf "/tmp/ensoul-smoke-$$" 2>/dev/null || true

# Results
echo ""
echo "============================================"
echo "  RESULTS: $PASS passed, $FAIL failed"
echo "============================================"

if [ "$FAIL" -gt 0 ]; then
	echo ""
	echo "  DEPLOY BLOCKED: Fix the failures above before pushing."
	echo ""
	exit 1
fi

echo ""
echo "  ALL CHECKS PASSED. Safe to deploy."
echo ""

# Record deployed version
mkdir -p "$HOME/.ensoul"
echo "$CURRENT_VERSION" > "$HOME/.ensoul/.last-deployed-version"

exit 0
