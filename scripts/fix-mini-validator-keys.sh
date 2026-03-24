#!/usr/bin/env bash
#
# fix-mini-validator-keys.sh
#
# After SCP copies CometBFT configs from MBP and convert-keys-to-cometbft.ts
# generates real validator keys, this script copies the real priv_validator_key.json
# into each CometBFT validator directory.
#
# Run on each Mini after:
#   1. SCP from MBP (copies v{N..M} directories with genesis, config, node keys)
#   2. npx tsx scripts/convert-keys-to-cometbft.ts --genesis genesis-config-v3.json
#
# Usage:
#   ./scripts/fix-mini-validator-keys.sh
#

set -euo pipefail

COMETBFT_DIR="$HOME/.cometbft-ensoul"

# Detect which validator range this Mini has
FIRST=""
LAST=""
for i in $(seq 0 34); do
	if [ -d "$COMETBFT_DIR/v$i" ]; then
		[ -z "$FIRST" ] && FIRST=$i
		LAST=$i
	fi
done

if [ -z "$FIRST" ]; then
	echo "No CometBFT validator directories found in $COMETBFT_DIR"
	exit 1
fi

echo "Found validator directories: v$FIRST through v$LAST"

# The converted keys are at ~/.cometbft-ensoul/validator-{0..9}/config/priv_validator_key.json
# (local index 0..9 maps to global index FIRST..LAST)
REPLACED=0
for i in $(seq "$FIRST" "$LAST"); do
	LOCAL_IDX=$((i - FIRST))
	CONVERTED_KEY="$COMETBFT_DIR/validator-$LOCAL_IDX/config/priv_validator_key.json"
	TARGET_KEY="$COMETBFT_DIR/v$i/config/priv_validator_key.json"

	if [ -f "$CONVERTED_KEY" ]; then
		# Verify the address matches (public key must be the same)
		CONV_ADDR=$(python3 -c "import json; print(json.load(open('$CONVERTED_KEY'))['address'])" 2>/dev/null)
		TARG_ADDR=$(python3 -c "import json; print(json.load(open('$TARGET_KEY'))['address'])" 2>/dev/null)

		if [ "$CONV_ADDR" = "$TARG_ADDR" ]; then
			cp "$CONVERTED_KEY" "$TARGET_KEY"
			echo "  v$i (local $LOCAL_IDX): OK (addr=$CONV_ADDR)"
			REPLACED=$((REPLACED + 1))
		else
			echo "  v$i (local $LOCAL_IDX): ADDRESS MISMATCH conv=$CONV_ADDR targ=$TARG_ADDR"
		fi
	else
		echo "  v$i (local $LOCAL_IDX): No converted key at $CONVERTED_KEY"
	fi
done

echo ""
echo "Replaced $REPLACED keys"
