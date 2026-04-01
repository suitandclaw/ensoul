#!/usr/bin/env bash
#
# pre-deploy-check.sh
#
# Safety gate that MUST pass before any ABCI deployment to production.
# Enforces Rule 18: every ABCI change tested before deployment.
#
# Usage:
#   ./scripts/pre-deploy-check.sh
#
# Exit codes:
#   0  All checks passed, safe to deploy
#   1  One or more checks failed, do NOT deploy
#

set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_DIR"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m'

PASS=0
FAIL=0

pass() { echo -e "${GREEN}PASS${NC}: $1"; PASS=$((PASS + 1)); }
fail() { echo -e "${RED}FAIL${NC}: $1"; FAIL=$((FAIL + 1)); }
warn() { echo -e "${YELLOW}WARN${NC}: $1"; }

echo ""
echo "  ENSOUL PRE-DEPLOY CHECK"
echo "  Rule 18 enforcement: verify before any production ABCI deployment"
echo ""

# ── Step 1: Test suite ──────────────────────────────────────────────

echo "--- Step 1: Run test suite ---"
if pnpm test 2>&1 | tail -5 | grep -q "Tests.*passed"; then
    TEST_SUMMARY=$(pnpm test 2>&1 | grep "Tests" | tail -1)
    pass "Tests: $TEST_SUMMARY"
else
    TEST_OUTPUT=$(pnpm test 2>&1 | tail -10)
    fail "Tests failing. Output:"
    echo "$TEST_OUTPUT"
fi

# ── Step 2: Build check ────────────────────────────────────────────

echo ""
echo "--- Step 2: Build check ---"
if pnpm build 2>&1 | tail -3 | grep -q "Tasks.*successful"; then
    BUILD_SUMMARY=$(pnpm build 2>&1 | grep "Tasks" | tail -1)
    pass "Build: $BUILD_SUMMARY"
else
    BUILD_OUTPUT=$(pnpm build 2>&1 | tail -10)
    fail "Build failing. Output:"
    echo "$BUILD_OUTPUT"
fi

# ── Step 3: Version bump check ─────────────────────────────────────

echo ""
echo "--- Step 3: Version check ---"
VERSION=$(grep 'VERSION' packages/node/src/version.ts | grep -oP '"[^"]*"' | tr -d '"' 2>/dev/null || echo "unknown")
echo "  Current version: $VERSION"
LAST_DEPLOYED=$(curl -s --connect-timeout 5 http://178.156.199.91:26657/abci_info 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin)['result']['response'].get('version','unknown'))" 2>/dev/null || echo "unknown")
echo "  Last deployed: $LAST_DEPLOYED"
if [ "$VERSION" != "$LAST_DEPLOYED" ] && [ "$LAST_DEPLOYED" != "unknown" ]; then
    pass "Version changed: $LAST_DEPLOYED -> $VERSION"
else
    warn "Version unchanged or could not verify deployed version"
fi

# ── Step 4: State compatibility check ──────────────────────────────

echo ""
echo "--- Step 4: State compatibility check ---"

# Fetch live appHash
LIVE_HASH=$(curl -s --connect-timeout 5 http://178.156.199.91:26657/status 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin)['result']['sync_info']['latest_app_hash'])" 2>/dev/null || echo "")

if [ -z "$LIVE_HASH" ]; then
    # Try alternate validator
    LIVE_HASH=$(curl -s --connect-timeout 5 http://5.78.199.4:26657/status 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin)['result']['sync_info']['latest_app_hash'])" 2>/dev/null || echo "")
fi

if [ -n "$LIVE_HASH" ]; then
    echo "  Live chain appHash: ${LIVE_HASH:0:16}..."
    # TODO: Full state compatibility check
    # To implement fully:
    #   1. Export current ABCI state from a validator (state.json)
    #   2. Start a temp ABCI instance on a random port with the NEW code
    #   3. Load the state, compute appHash
    #   4. Compare with LIVE_HASH
    #   5. If different, the new code changes the hash and will cause a consensus split
    #   6. Kill the temp ABCI
    # For now, we verify the hash is available and record it for manual comparison.
    warn "State compat check: manual verification required. Compare appHash after deploying to one validator."
else
    warn "Could not fetch live appHash (chain may be down)"
fi

# ── Step 5: Diff check ─────────────────────────────────────────────

echo ""
echo "--- Step 5: Change summary ---"
CHANGED=$(git diff --name-only HEAD~1 2>/dev/null | grep -E "abci-server|ledger" | head -10)
if [ -n "$CHANGED" ]; then
    echo "  Consensus-affecting files changed:"
    echo "$CHANGED" | sed 's/^/    /'
    warn "Review these changes carefully. Height-gate any new state logic."
else
    pass "No consensus-affecting files changed since last commit"
fi

# ── Summary ─────────────────────────────────────────────────────────

echo ""
echo "============================================"
if [ "$FAIL" -gt 0 ]; then
    echo -e "  ${RED}BLOCKED${NC}: $FAIL check(s) failed. Do NOT deploy."
    echo "============================================"
    exit 1
else
    echo -e "  ${GREEN}SAFE TO DEPLOY${NC}"
    echo "  Passed: $PASS"
    echo "  Deploy via SOP 2: one validator first, verify 50 blocks, batches of 3"
    echo "============================================"
    exit 0
fi
