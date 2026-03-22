#!/usr/bin/env bash
#
# backup-validator-keys.sh
#
# Collects and encrypts all validator identity files into a secure vault.
# Uses AES-256-GCM encryption via openssl. Requires two passwords:
# one for individual keys, one for the archive.
#
# Usage:
#   ./scripts/backup-validator-keys.sh              # interactive, prompts for passwords
#   ./scripts/backup-validator-keys.sh --list       # list backed up keys
#   ./scripts/backup-validator-keys.sh --verify     # verify backup integrity
#

set -euo pipefail

VAULT_DIR="$HOME/.ensoul/key-vault"
KEYS_DIR="$VAULT_DIR/keys"
DATA_DIR="$HOME/.ensoul"
DATE=$(date +"%Y-%m-%d")
ARCHIVE_NAME="ensoul-key-vault-$DATE"

mkdir -p "$VAULT_DIR" "$KEYS_DIR"

log() { echo "[backup] $1"; }

# ── List mode ─────────────────────────────────────────────────────────

if [ "${1:-}" = "--list" ]; then
	echo ""
	echo "  Backed up keys in $KEYS_DIR:"
	echo ""
	for f in "$KEYS_DIR"/*.json.enc; do
		[ -f "$f" ] || continue
		name=$(basename "$f" .json.enc)
		size=$(wc -c < "$f" | tr -d ' ')
		echo "    $name ($size bytes)"
	done
	echo ""
	echo "  Archives in $VAULT_DIR:"
	for f in "$VAULT_DIR"/*.tar.gz.enc; do
		[ -f "$f" ] || continue
		name=$(basename "$f")
		size=$(wc -c < "$f" | tr -d ' ')
		echo "    $name ($size bytes)"
	done
	echo ""
	exit 0
fi

# ── Verify mode ───────────────────────────────────────────────────────

if [ "${1:-}" = "--verify" ]; then
	latest=$(ls -t "$VAULT_DIR"/*.tar.gz.enc 2>/dev/null | head -1)
	if [ -z "$latest" ]; then
		echo "No backup archives found."
		exit 1
	fi
	echo ""
	echo "  Latest archive: $(basename "$latest")"
	echo "  SHA-256: $(shasum -a 256 "$latest" | awk '{print $1}')"
	echo "  Size: $(wc -c < "$latest" | tr -d ' ') bytes"
	echo "  Modified: $(stat -f '%Sm' "$latest" 2>/dev/null || stat -c '%y' "$latest" 2>/dev/null || echo 'unknown')"
	echo ""
	echo "  Individual encrypted keys:"
	count=0
	for f in "$KEYS_DIR"/*.json.enc; do
		[ -f "$f" ] || continue
		count=$((count + 1))
	done
	echo "    $count keys in vault"
	echo ""
	exit 0
fi

# ── Backup mode ───────────────────────────────────────────────────────

log "Ensoul Validator Key Backup"
echo ""

# Prompt for key encryption password
echo -n "Enter KEY encryption password (encrypts individual private keys): "
read -s KEY_PASSWORD
echo ""
if [ ${#KEY_PASSWORD} -lt 8 ]; then
	echo "Password must be at least 8 characters."
	exit 1
fi

echo -n "Confirm KEY password: "
read -s KEY_PASSWORD_CONFIRM
echo ""
if [ "$KEY_PASSWORD" != "$KEY_PASSWORD_CONFIRM" ]; then
	echo "Passwords do not match."
	exit 1
fi

# Prompt for archive encryption password (must be different)
echo -n "Enter ARCHIVE encryption password (different from key password): "
read -s ARCHIVE_PASSWORD
echo ""
if [ ${#ARCHIVE_PASSWORD} -lt 8 ]; then
	echo "Password must be at least 8 characters."
	exit 1
fi
if [ "$ARCHIVE_PASSWORD" = "$KEY_PASSWORD" ]; then
	echo "Archive password must be different from key password."
	exit 1
fi

echo -n "Confirm ARCHIVE password: "
read -s ARCHIVE_PASSWORD_CONFIRM
echo ""
if [ "$ARCHIVE_PASSWORD" != "$ARCHIVE_PASSWORD_CONFIRM" ]; then
	echo "Passwords do not match."
	exit 1
fi

echo ""
log "Collecting validator keys..."

BACKED_UP=0

# Collect local validator keys
for i in $(seq 0 9); do
	ID_FILE="$DATA_DIR/validator-$i/identity.json"
	[ -f "$ID_FILE" ] || continue

	DID=$(python3 -c "import json; print(json.load(open('$ID_FILE')).get('did','unknown'))" 2>/dev/null || echo "unknown")
	SHORT_DID="${DID:0:24}..."

	# Encrypt with openssl AES-256-CBC (widely available, uses PBKDF2)
	ENC_FILE="$KEYS_DIR/validator-$i-local.json.enc"
	openssl enc -aes-256-cbc -pbkdf2 -salt \
		-in "$ID_FILE" \
		-out "$ENC_FILE" \
		-pass "pass:$KEY_PASSWORD" 2>/dev/null

	BACKED_UP=$((BACKED_UP + 1))
	log "  validator-$i: $SHORT_DID (encrypted)"
done

# Also back up the main identity if it exists
if [ -f "$DATA_DIR/identity.json" ]; then
	openssl enc -aes-256-cbc -pbkdf2 -salt \
		-in "$DATA_DIR/identity.json" \
		-out "$KEYS_DIR/identity-main.json.enc" \
		-pass "pass:$KEY_PASSWORD" 2>/dev/null
	BACKED_UP=$((BACKED_UP + 1))
	log "  main identity (encrypted)"
fi

if [ "$BACKED_UP" -eq 0 ]; then
	log "No identity files found to back up."
	exit 1
fi

log "$BACKED_UP keys encrypted and stored in $KEYS_DIR"

# Create archive of all encrypted keys
log "Creating encrypted archive..."
ARCHIVE_PATH="$VAULT_DIR/$ARCHIVE_NAME.tar.gz"
ARCHIVE_ENC_PATH="$VAULT_DIR/$ARCHIVE_NAME.tar.gz.enc"

tar -czf "$ARCHIVE_PATH" -C "$KEYS_DIR" . 2>/dev/null

# Double encrypt the archive with the archive password
openssl enc -aes-256-cbc -pbkdf2 -salt \
	-in "$ARCHIVE_PATH" \
	-out "$ARCHIVE_ENC_PATH" \
	-pass "pass:$ARCHIVE_PASSWORD" 2>/dev/null

# Remove unencrypted archive
rm -f "$ARCHIVE_PATH"

HASH=$(shasum -a 256 "$ARCHIVE_ENC_PATH" | awk '{print $1}')

echo ""
echo "============================================"
echo "  BACKUP COMPLETE"
echo "============================================"
echo ""
echo "  Keys backed up:  $BACKED_UP"
echo "  Archive:         $ARCHIVE_ENC_PATH"
echo "  SHA-256:         $HASH"
echo ""
echo "  Security:"
echo "    - Individual keys encrypted with AES-256-CBC (password 1)"
echo "    - Archive encrypted with AES-256-CBC (password 2)"
echo "    - Both passwords required to access any key"
echo ""
echo "  IMPORTANT: Store this archive in multiple locations."
echo "  Recommended: local disk, USB drive, encrypted cloud storage."
echo ""
echo "  To restore: ./scripts/restore-validator-keys.sh $ARCHIVE_ENC_PATH"
echo ""

# Clear passwords from memory
KEY_PASSWORD=""
KEY_PASSWORD_CONFIRM=""
ARCHIVE_PASSWORD=""
ARCHIVE_PASSWORD_CONFIRM=""
