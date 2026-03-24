#!/usr/bin/env bash
#
# setup-cometbft-local.sh
#
# Sets up CometBFT validator directories on the local machine.
# Detects which machine this is, copies the correct configs from
# the repo (cometbft-configs/), and generates real validator keys
# from the Ensoul identity files in ~/.ensoul/validator-N/.
#
# Run after: cd ~/ensoul && git pull origin main
#
# Usage:
#   ./scripts/setup-cometbft-local.sh
#

set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
COMETBFT_DIR="$HOME/.cometbft-ensoul"
CONFIGS_DIR="$REPO_DIR/cometbft-configs"

log() { echo "[setup] $1"; }

# ── Detect machine ────────────────────────────────────────────────────

detect_machine() {
	local hostname
	hostname=$(hostname)
	case "$hostname" in
		*MacBook*|*MBP*|Suits*)  echo "mbp" ;;
		*[Hh]amster*)            echo "mini1" ;;
		*[Mm]egaphone*)          echo "mini2" ;;
		*[Ss]nitch*)             echo "mini3" ;;
		*)
			# Count validator directories to guess
			local count=0
			for i in $(seq 0 9); do
				[ -d "$HOME/.ensoul/validator-$i" ] && count=$((count + 1))
			done
			if [ "$count" -le 5 ]; then echo "mbp"; else echo "unknown"; fi
			;;
	esac
}

MACHINE=$(detect_machine)

case "$MACHINE" in
	mbp)   VSTART=0;  VEND=4  ;;
	mini1) VSTART=5;  VEND=14 ;;
	mini2) VSTART=15; VEND=24 ;;
	mini3) VSTART=25; VEND=34 ;;
	*)
		log "ERROR: Cannot detect machine. Hostname: $(hostname)"
		exit 1
		;;
esac

log "Machine: $MACHINE (validators v$VSTART through v$VEND)"

# ── Verify prerequisites ─────────────────────────────────────────────

if [ ! -d "$CONFIGS_DIR" ]; then
	log "ERROR: cometbft-configs/ not found. Run: git pull origin main"
	exit 1
fi

IDENTITY_COUNT=0
for i in $(seq 0 $((VEND - VSTART))); do
	[ -f "$HOME/.ensoul/validator-$i/identity.json" ] && IDENTITY_COUNT=$((IDENTITY_COUNT + 1))
done
log "Ensoul identity files found: $IDENTITY_COUNT"

# ── Set up validator directories ──────────────────────────────────────

mkdir -p "$COMETBFT_DIR"

for vi in $(seq "$VSTART" "$VEND"); do
	LOCAL_IDX=$((vi - VSTART))
	DIR="$COMETBFT_DIR/v$vi"

	log "Setting up v$vi (local index $LOCAL_IDX)..."

	mkdir -p "$DIR/config" "$DIR/data"

	# Copy config.toml and node_key.json from repo
	if [ -f "$CONFIGS_DIR/v$vi/config.toml" ]; then
		cp "$CONFIGS_DIR/v$vi/config.toml" "$DIR/config/"
	else
		log "  WARNING: No config.toml for v$vi in repo"
	fi

	if [ -f "$CONFIGS_DIR/v$vi/node_key.json" ]; then
		cp "$CONFIGS_DIR/v$vi/node_key.json" "$DIR/config/"
	else
		log "  WARNING: No node_key.json for v$vi in repo"
	fi

	# Copy genesis
	cp "$REPO_DIR/cometbft-genesis.json" "$DIR/config/genesis.json"

	# Generate priv_validator_key.json from Ensoul identity
	IDENTITY="$HOME/.ensoul/validator-$LOCAL_IDX/identity.json"
	if [ -f "$IDENTITY" ]; then
		python3 -c "
import json, hashlib, base64

d = json.load(open('$IDENTITY'))
if 'seed' not in d:
    print('  SKIP: encrypted key (no seed)')
    exit(1)

seed = bytes.fromhex(d['seed'])
pubkey = bytes.fromhex(d['publicKey'])
address = hashlib.sha256(pubkey).hexdigest()[:40].upper()
priv_b64 = base64.b64encode(seed + pubkey).decode()
pub_b64 = base64.b64encode(pubkey).decode()

key = {
    'address': address,
    'pub_key': {'type': 'tendermint/PubKeyEd25519', 'value': pub_b64},
    'priv_key': {'type': 'tendermint/PrivKeyEd25519', 'value': priv_b64},
}
json.dump(key, open('$DIR/config/priv_validator_key.json', 'w'), indent=2)
print(f'  Key: addr={address[:16]}...')
" 2>/dev/null || log "  ERROR: Failed to generate key for v$vi"
	else
		log "  WARNING: No identity at $IDENTITY"
	fi

	# Validator state (fresh start)
	echo '{"height":"0","round":0,"step":0}' > "$DIR/data/priv_validator_state.json"
done

log ""
log "Setup complete. Validator directories:"
for vi in $(seq "$VSTART" "$VEND"); do
	DIR="$COMETBFT_DIR/v$vi"
	HAS_KEY="NO"
	[ -f "$DIR/config/priv_validator_key.json" ] && HAS_KEY="YES"
	HAS_NODE="NO"
	[ -f "$DIR/config/node_key.json" ] && HAS_NODE="YES"
	log "  v$vi: key=$HAS_KEY node_key=$HAS_NODE"
done

log ""
log "Genesis hash:"
shasum -a 256 "$COMETBFT_DIR/v$VSTART/config/genesis.json" 2>/dev/null | cut -c1-16
