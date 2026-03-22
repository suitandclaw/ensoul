#!/bin/bash
#
# cloud-validator-setup.sh
#
# Turns a fresh Ubuntu 22.04+ VPS into a running Ensoul validator.
# Completely unattended. No prompts.
#
# Usage:
#   curl -sL https://raw.githubusercontent.com/suitandclaw/ensoul/main/scripts/cloud-validator-setup.sh | bash
#
# Or with a seed:
#   curl -sL https://raw.githubusercontent.com/suitandclaw/ensoul/main/scripts/cloud-validator-setup.sh | bash -s -- --seed YOUR_HEX_SEED
#

set -euo pipefail

REPO_URL="https://github.com/suitandclaw/ensoul.git"
ENSOUL_DIR="$HOME/ensoul"
DATA_DIR="$HOME/.ensoul"
PEERS="https://v0.ensoul.dev,https://v1.ensoul.dev,https://v2.ensoul.dev,https://v3.ensoul.dev"
API="https://api.ensoul.dev"
LOG_FILE="$DATA_DIR/cloud-setup.log"
SEED_ARG=""
PIONEER_MODE=false
PIONEER_KEY="${PIONEER_KEY:-}"

# Parse args
while [ $# -gt 0 ]; do
	case "$1" in
		--seed) SEED_ARG="$2"; shift 2 ;;
		--pioneer) PIONEER_MODE=true; shift ;;
		*) shift ;;
	esac
done

mkdir -p "$DATA_DIR"

log() {
	local ts
	ts=$(date +"%Y-%m-%d %H:%M:%S")
	echo "[$ts] $1" | tee -a "$LOG_FILE"
}

log "Starting Ensoul cloud validator setup..."

# 1. Install Node.js 22 via nvm
log "Installing Node.js 22..."
if ! command -v node >/dev/null 2>&1 || [ "$(node -v | cut -d. -f1 | tr -d v)" -lt 22 ]; then
	export NVM_DIR="$HOME/.nvm"
	if [ ! -s "$NVM_DIR/nvm.sh" ]; then
		curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
	fi
	. "$NVM_DIR/nvm.sh"
	nvm install 22
	nvm use 22
fi
log "Node.js $(node -v) installed."

# 2. Install pnpm
log "Installing pnpm..."
if ! command -v pnpm >/dev/null 2>&1; then
	npm install -g pnpm
fi
log "pnpm $(pnpm -v) installed."

# 3. Clone repo
log "Cloning Ensoul repository..."
if [ -d "$ENSOUL_DIR" ]; then
	cd "$ENSOUL_DIR"
	git pull origin main --quiet || true
else
	git clone "$REPO_URL" "$ENSOUL_DIR"
	cd "$ENSOUL_DIR"
fi

# 4. Build
log "Building..."
pnpm install --frozen-lockfile 2>&1 | tail -3
pnpm build 2>&1 | tail -3
log "Build complete."

# 5. Copy genesis
log "Setting up genesis..."
cp "$ENSOUL_DIR/genesis.json" "$DATA_DIR/genesis.json"

# 6. Generate or import identity
if [ -n "$SEED_ARG" ]; then
	log "Importing identity from seed..."
	npx tsx "$ENSOUL_DIR/packages/node/src/cli/main.ts" --import-seed "$SEED_ARG" --data-dir "$DATA_DIR" 2>&1 | tee -a "$LOG_FILE"
else
	log "Identity will be generated on first start."
fi

# 7. Start validator
log "Starting validator..."
npx tsx "$ENSOUL_DIR/packages/node/src/cli/main.ts" \
	--validate \
	--no-min-stake \
	--consensus-only \
	--consensus-threshold 0.67 \
	--genesis "$DATA_DIR/genesis.json" \
	--peers "$PEERS" \
	--data-dir "$DATA_DIR" \
	--port 9000 \
	>"$DATA_DIR/validator.log" 2>&1 &
VALIDATOR_PID=$!
log "Validator started (PID $VALIDATOR_PID)."

# 8. Wait for sync
log "Waiting for validator to sync..."
SYNCED=false
for i in $(seq 1 60); do
	HEALTH=$(curl -s http://localhost:9000/peer/health 2>/dev/null || echo "{}")
	HEALTHY=$(echo "$HEALTH" | python3 -c "import sys,json; print(json.load(sys.stdin).get('healthy', False))" 2>/dev/null || echo "False")
	if [ "$HEALTHY" = "True" ]; then
		SYNCED=true
		break
	fi
	sleep 5
done

if [ "$SYNCED" = "false" ]; then
	log "WARNING: Validator did not become healthy within 5 minutes. Continuing anyway."
fi

# 9. Get DID and register
DID=$(curl -s http://localhost:9000/peer/status 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin).get('did', ''))" 2>/dev/null || echo "")
PUBKEY=""

if [ -f "$DATA_DIR/identity.json" ]; then
	PUBKEY=$(python3 -c "import json; print(json.load(open('$DATA_DIR/identity.json')).get('publicKey', ''))" 2>/dev/null || echo "")
fi

if [ -n "$DID" ] && [ -n "$PUBKEY" ]; then
	HOSTNAME=$(hostname)
	if [ "$PIONEER_MODE" = "true" ] && [ -n "$PIONEER_KEY" ]; then
		log "Registering as Pioneer validator: $DID"
		REG_RESP=$(curl -s -X POST "$API/v1/validators/register-pioneer" \
			-H "Content-Type: application/json" \
			-H "X-Ensoul-Pioneer-Key: $PIONEER_KEY" \
			-d "{\"did\":\"$DID\",\"publicKey\":\"$PUBKEY\",\"name\":\"pioneer-$HOSTNAME\"}" \
			2>/dev/null || echo "{}")
	else
		log "Registering validator: $DID"
		REG_RESP=$(curl -s -X POST "$API/v1/validators/register" \
			-H "Content-Type: application/json" \
			-d "{\"did\":\"$DID\",\"publicKey\":\"$PUBKEY\",\"name\":\"cloud-$HOSTNAME\"}" \
			2>/dev/null || echo "{}")
	fi
	log "Registration response: $REG_RESP"
else
	log "WARNING: Could not read DID or publicKey. Manual registration needed."
fi

# 10. Install auto-update
log "Installing auto-update..."
npx tsx "$ENSOUL_DIR/packages/node/src/cli/main.ts" --auto-update 2>&1 | tee -a "$LOG_FILE" || true

# 11. Summary
HEIGHT=$(curl -s http://localhost:9000/peer/status 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin).get('height', 0))" 2>/dev/null || echo "0")

echo ""
echo "============================================"
echo "  ENSOUL VALIDATOR RUNNING"
echo "============================================"
echo ""
echo "  DID:    ${DID:-unknown}"
echo "  Height: $HEIGHT"
echo "  Port:   9000"
echo "  Peers:  $PEERS"
echo "  Log:    $DATA_DIR/validator.log"
echo ""
echo "  Auto-update: enabled (checks every 15 min)"
echo ""
echo "  View status: curl http://localhost:9000/peer/status"
echo "  View health: curl http://localhost:9000/peer/health"
echo ""
log "Cloud validator setup complete."
