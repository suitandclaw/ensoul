#!/usr/bin/env bash
#
# restore-validator-keys.sh
#
# Restores validator identity files from an encrypted backup archive.
# Requires both the archive password and the key password.
#
# Usage:
#   ./scripts/restore-validator-keys.sh <archive.tar.gz.enc>
#   ./scripts/restore-validator-keys.sh <archive.tar.gz.enc> --validator 0
#   ./scripts/restore-validator-keys.sh <archive.tar.gz.enc> --to /path/to/dir
#

set -euo pipefail

DATA_DIR="$HOME/.ensoul"
TEMP_DIR=$(mktemp -d)

cleanup() { rm -rf "$TEMP_DIR"; }
trap cleanup EXIT

if [ $# -lt 1 ]; then
	echo "Usage: $0 <archive.tar.gz.enc> [--validator N] [--to /path]"
	exit 1
fi

ARCHIVE="$1"
shift

TARGET_VALIDATOR=""
TARGET_DIR=""

while [ $# -gt 0 ]; do
	case "$1" in
		--validator) TARGET_VALIDATOR="$2"; shift 2 ;;
		--to) TARGET_DIR="$2"; shift 2 ;;
		*) shift ;;
	esac
done

if [ ! -f "$ARCHIVE" ]; then
	echo "Archive not found: $ARCHIVE"
	exit 1
fi

echo ""
echo "  Ensoul Validator Key Restore"
echo "  Archive: $(basename "$ARCHIVE")"
echo "  SHA-256: $(shasum -a 256 "$ARCHIVE" | awk '{print $1}')"
echo ""

# Prompt for archive password
echo -n "Enter ARCHIVE password: "
read -s ARCHIVE_PASSWORD
echo ""

# Decrypt archive
if ! openssl enc -d -aes-256-cbc -pbkdf2 \
	-in "$ARCHIVE" \
	-out "$TEMP_DIR/keys.tar.gz" \
	-pass "pass:$ARCHIVE_PASSWORD" 2>/dev/null; then
	echo "Failed to decrypt archive. Wrong password?"
	exit 1
fi

# Extract
tar -xzf "$TEMP_DIR/keys.tar.gz" -C "$TEMP_DIR" 2>/dev/null
echo "  Archive decrypted. Found $(ls "$TEMP_DIR"/*.enc 2>/dev/null | wc -l | tr -d ' ') encrypted keys."

# Prompt for key password
echo -n "Enter KEY password: "
read -s KEY_PASSWORD
echo ""
echo ""

RESTORED=0

for f in "$TEMP_DIR"/*.enc; do
	[ -f "$f" ] || continue
	NAME=$(basename "$f" .json.enc)

	# Filter by validator number if specified
	if [ -n "$TARGET_VALIDATOR" ] && [[ "$NAME" != *"validator-$TARGET_VALIDATOR"* ]]; then
		continue
	fi

	# Decrypt key
	DECRYPTED="$TEMP_DIR/$NAME.json"
	if ! openssl enc -d -aes-256-cbc -pbkdf2 \
		-in "$f" \
		-out "$DECRYPTED" \
		-pass "pass:$KEY_PASSWORD" 2>/dev/null; then
		echo "  FAILED: $NAME (wrong key password?)"
		continue
	fi

	# Verify DID derivation
	DID=$(python3 -c "import json; print(json.load(open('$DECRYPTED')).get('did','?'))" 2>/dev/null || echo "?")
	SHORT="${DID:0:24}..."

	# Determine restore path
	if [ -n "$TARGET_DIR" ]; then
		DEST="$TARGET_DIR/$NAME.json"
	elif [[ "$NAME" == validator-* ]]; then
		# Extract validator number
		VNUM=$(echo "$NAME" | grep -o 'validator-[0-9]*' | head -1)
		DEST="$DATA_DIR/$VNUM/identity.json"
	elif [ "$NAME" = "identity-main" ]; then
		DEST="$DATA_DIR/identity.json"
	else
		DEST="$DATA_DIR/$NAME.json"
	fi

	mkdir -p "$(dirname "$DEST")"

	# Warn if overwriting
	if [ -f "$DEST" ]; then
		echo "  WARNING: $DEST already exists. Skipping. Use --to to restore elsewhere."
		continue
	fi

	cp "$DECRYPTED" "$DEST"
	RESTORED=$((RESTORED + 1))
	echo "  RESTORED: $NAME -> $DEST ($SHORT)"
done

echo ""
echo "  Restored $RESTORED keys."
echo ""

# Clear passwords
ARCHIVE_PASSWORD=""
KEY_PASSWORD=""
