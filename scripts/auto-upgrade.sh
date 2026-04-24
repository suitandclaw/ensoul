#!/usr/bin/env bash
#
# auto-upgrade.sh: Automatically apply code upgrades after ABCI halts.
#
# Called by systemd via ExecStopPost when ensoul-abci exits. If the exit
# was triggered by an on-chain SOFTWARE_UPGRADE, this script:
#   1. Reads upgrade-info.json to get the target git tag
#   2. Fetches the tag and force-resets the repo to it
#   3. Rebuilds with pnpm
#   4. Verifies the build output contains the expected code
#   5. Places the CometBFT binary in the Cosmovisor upgrade directory
#   6. systemd then restarts ensoul-abci with the new code
#
# The info field in the upgrade plan must contain a JSON object with
# a "tag" field pointing to a git tag or commit hash:
#   {"tag": "v1.5.0"}
#
# Alerting: on failure, sends an ntfy.sh push notification so operators
# know their validator needs manual intervention. On success, sends a
# positive confirmation. Topic read from ~/.ensoul/ntfy-topic.txt.
#
# Usage:
#   Called automatically by systemd ExecStopPost. Can also be run manually:
#   ./scripts/auto-upgrade.sh
#

set -uo pipefail
# NOTE: we do NOT use set -e. Every fallible command is explicitly checked
# so we can log + alert on the specific failure rather than exiting silently.

REPO_DIR="${ENSOUL_REPO:-$HOME/ensoul}"
CMT_HOME="${DAEMON_HOME:-$HOME/.cometbft-ensoul/node}"
UPGRADE_INFO="$CMT_HOME/data/upgrade-info.json"
LOG_FILE="$HOME/.ensoul/auto-upgrade.log"
LOCK_FILE="$HOME/.ensoul/auto-upgrade.lock"
HOSTNAME_SHORT=$(hostname -s 2>/dev/null || echo "unknown")

mkdir -p "$(dirname "$LOG_FILE")"

log() {
    local ts
    ts=$(date "+%Y-%m-%d %H:%M:%S")
    echo "[$ts] [auto-upgrade] $1" | tee -a "$LOG_FILE"
}

# ── Alerting ────────────────────────────────────────────────────────

alert() {
    local title="$1"
    local body="$2"
    local priority="${3:-high}"
    log "ALERT: $title: $body"

    # ntfy.sh
    local topic_file="$HOME/.ensoul/ntfy-topic.txt"
    local topic
    topic=$(cat "$topic_file" 2>/dev/null || echo "")
    if [ -n "$topic" ]; then
        curl -s -o /dev/null -m 5 \
            -H "Title: $title" \
            -H "Priority: $priority" \
            -H "Tags: ${4:-warning}" \
            -d "$body" \
            "https://ntfy.sh/$topic" 2>/dev/null || true
    fi

    # Telegram (backup)
    local tg_env="$HOME/.ensoul/telegram-bot.env"
    if [ -f "$tg_env" ]; then
        local tg_token tg_user
        tg_token=$(grep "^TELEGRAM_BOT_TOKEN=" "$tg_env" 2>/dev/null | cut -d= -f2-)
        tg_user=$(grep "^TELEGRAM_AUTHORIZED_USER=" "$tg_env" 2>/dev/null | cut -d= -f2-)
        if [ -n "$tg_token" ] && [ -n "$tg_user" ]; then
            curl -s -o /dev/null -m 5 -X POST \
                "https://api.telegram.org/bot${tg_token}/sendMessage" \
                -H "Content-Type: application/json" \
                -d "{\"chat_id\":${tg_user},\"text\":\"[auto-upgrade] ${title}: ${body}\"}" 2>/dev/null || true
        fi
    fi
}

fail() {
    local msg="$1"
    log "FATAL: $msg"
    alert "Upgrade FAILED on $HOSTNAME_SHORT" "$msg" "urgent" "rotating_light"
    # Write to a prominent location so it's visible without SSH
    echo "[$(date)] AUTO-UPGRADE FAILED: $msg" >> "$HOME/.ensoul/UPGRADE-FAILURE.txt"
    exit 1
}

# ── Check if an upgrade is pending ──────────────────────────────────

if [ ! -f "$UPGRADE_INFO" ]; then
    # No upgrade pending. Normal restart.
    exit 0
fi

# Read the upgrade plan
UPGRADE_NAME=$(python3 -c "import json; print(json.load(open('$UPGRADE_INFO'))['name'])" 2>/dev/null || echo "")
UPGRADE_HEIGHT=$(python3 -c "import json; print(json.load(open('$UPGRADE_INFO'))['height'])" 2>/dev/null || echo "0")
UPGRADE_INFO_RAW=$(python3 -c "import json; print(json.load(open('$UPGRADE_INFO')).get('info',''))" 2>/dev/null || echo "")

if [ -z "$UPGRADE_NAME" ]; then
    log "upgrade-info.json exists but name is empty. Skipping."
    exit 0
fi

# Parse the info field for the git tag
GIT_TAG=$(echo "$UPGRADE_INFO_RAW" | python3 -c "import sys,json; print(json.load(sys.stdin).get('tag',''))" 2>/dev/null || echo "")

if [ -z "$GIT_TAG" ]; then
    fail "Upgrade '$UPGRADE_NAME' at height $UPGRADE_HEIGHT has no git tag in info field. Info: $UPGRADE_INFO_RAW"
fi

# ── Prevent concurrent runs ─────────────────────────────────────────

if [ -f "$LOCK_FILE" ]; then
    lock_age=$(( $(date +%s) - $(stat -f %m "$LOCK_FILE" 2>/dev/null || stat -c %Y "$LOCK_FILE" 2>/dev/null || echo 0) ))
    if [ "$lock_age" -lt 300 ] 2>/dev/null; then
        log "Another auto-upgrade is running (lock age: ${lock_age}s). Skipping."
        exit 0
    fi
    rm -f "$LOCK_FILE"
fi
echo $$ > "$LOCK_FILE"
trap 'rm -f "$LOCK_FILE"' EXIT

# ── Apply the upgrade ───────────────────────────────────────────────

log "=========================================="
log "APPLYING UPGRADE: $UPGRADE_NAME"
log "  Target height: $UPGRADE_HEIGHT"
log "  Git tag: $GIT_TAG"
log "  Host: $HOSTNAME_SHORT"
log "=========================================="

cd "$REPO_DIR" || fail "Cannot cd to $REPO_DIR"

# ── Step 1: Fetch tags from origin ──────────────────────────────────

BEFORE_HEAD=$(git rev-parse HEAD)
log "Current HEAD: $(git rev-parse --short HEAD)"
log "Fetching tags from origin..."
fetch_attempt=0
while ! git fetch origin --prune --tags 2>> "$LOG_FILE"; do
    fetch_attempt=$((fetch_attempt + 1))
    if [ "$fetch_attempt" -ge 2 ]; then
        fail "git fetch origin --prune --tags failed after 2 attempts. Network issue or remote unreachable."
    fi
    log "git fetch failed, retrying in 10s..."
    sleep 10
done

# ── Step 2: Force-reset to the target tag ───────────────────────────
# git reset --hard is the correct primitive for automated upgrades:
# it discards local commits AND uncommitted changes, ensuring the
# tree matches the upgrade target exactly. git checkout would fail
# if the working directory is dirty or has local commits.

if ! git rev-parse "$GIT_TAG" >/dev/null 2>&1; then
    # Tag not in local repo. Try fetching it explicitly.
    git fetch origin "$GIT_TAG" 2>> "$LOG_FILE" || true
    if ! git rev-parse "$GIT_TAG" >/dev/null 2>&1; then
        fail "Tag or commit '$GIT_TAG' not found after fetch. Check that the tag exists on the remote."
    fi
fi

EXPECTED_COMMIT=$(git rev-parse "$GIT_TAG^{commit}" 2>/dev/null || echo "")
if [ -z "$EXPECTED_COMMIT" ]; then
    fail "Cannot resolve '$GIT_TAG' to a commit hash."
fi

log "Resetting to $GIT_TAG ($EXPECTED_COMMIT)..."
if ! git reset --hard "$GIT_TAG" 2>> "$LOG_FILE"; then
    fail "git reset --hard $GIT_TAG failed."
fi
git clean -fd 2>/dev/null || true

# ── Step 3: Verify the reset landed on the right commit ─────────────

ACTUAL_COMMIT=$(git rev-parse HEAD)
if [ "$ACTUAL_COMMIT" != "$EXPECTED_COMMIT" ]; then
    fail "Post-reset HEAD ($ACTUAL_COMMIT) does not match expected ($EXPECTED_COMMIT). Git state is inconsistent."
fi
log "Updated from $(git rev-parse --short $BEFORE_HEAD) to $(git rev-parse --short HEAD) ($GIT_TAG)"

# ── Step 4: Rebuild ─────────────────────────────────────────────────

if ! command -v pnpm >/dev/null 2>&1; then
    # Try common pnpm locations (fixed paths only, no globs in quotes)
    for p in "$HOME/.local/share/pnpm/pnpm" "/usr/local/bin/pnpm"; do
        if [ -x "$p" ] 2>/dev/null; then
            export PATH="$(dirname "$p"):$PATH"
            break
        fi
    done
    if ! command -v pnpm >/dev/null 2>&1; then
        # Check nvm paths separately to allow glob expansion
        nvm_pnpm=$(ls $HOME/.nvm/versions/node/*/bin/pnpm 2>/dev/null | head -1)
        if [ -n "$nvm_pnpm" ] && [ -x "$nvm_pnpm" ]; then
            export PATH="$(dirname "$nvm_pnpm"):$PATH"
        fi
    fi
    if ! command -v pnpm >/dev/null 2>&1; then
        fail "pnpm not found in PATH. Cannot rebuild. Install with: npm install -g pnpm"
    fi
fi

log "Installing dependencies..."
if ! pnpm install --frozen-lockfile 2>> "$LOG_FILE"; then
    # Retry without frozen lockfile (lockfile may have changed with the new tag)
    log "Frozen lockfile install failed, retrying without --frozen-lockfile..."
    if ! pnpm install 2>> "$LOG_FILE"; then
        fail "pnpm install failed. Check $LOG_FILE for details."
    fi
fi

log "Building..."
if ! pnpm build --filter @ensoul/ledger --filter @ensoul/abci-server 2>> "$LOG_FILE"; then
    fail "pnpm build failed. Check $LOG_FILE for details."
fi

# ── Step 5: Verify build output ─────────────────────────────────────

DIST_FILE="$REPO_DIR/packages/abci-server/dist/application.js"
if [ ! -f "$DIST_FILE" ]; then
    fail "Build output missing: $DIST_FILE does not exist."
fi

BUILD_SIZE=$(wc -c < "$DIST_FILE")
if [ "$BUILD_SIZE" -lt 10000 ]; then
    fail "Build output suspiciously small: $DIST_FILE is only $BUILD_SIZE bytes."
fi

log "Build verified: $DIST_FILE ($BUILD_SIZE bytes)"

# ── Step 6: Place CometBFT binary in Cosmovisor upgrade directory ──

UPGRADE_BIN_DIR="$CMT_HOME/cosmovisor/upgrades/$UPGRADE_NAME/bin"
mkdir -p "$UPGRADE_BIN_DIR"
if [ -f "$CMT_HOME/cosmovisor/genesis/bin/cometbft" ]; then
    cp "$CMT_HOME/cosmovisor/genesis/bin/cometbft" "$UPGRADE_BIN_DIR/cometbft"
    log "Placed CometBFT binary at $UPGRADE_BIN_DIR/cometbft"
elif [ -f "$HOME/go/bin/cometbft" ]; then
    cp "$HOME/go/bin/cometbft" "$UPGRADE_BIN_DIR/cometbft"
    log "Placed CometBFT binary from go/bin at $UPGRADE_BIN_DIR/cometbft"
else
    log "WARNING: No CometBFT binary found to copy. Cosmovisor may fail to restart."
fi

# ── Step 7: Remove upgrade-info.json ────────────────────────────────
# Only remove AFTER everything succeeded. If we crash before this,
# the next restart of auto-upgrade.sh will retry the upgrade.

rm -f "$UPGRADE_INFO"
log "Removed upgrade-info.json"

# ── Done ────────────────────────────────────────────────────────────

log "=========================================="
log "UPGRADE COMPLETE: $UPGRADE_NAME"
log "  Tag: $GIT_TAG"
log "  Commit: $(git rev-parse --short HEAD)"
log "  ABCI will restart with new code."
log "  Cosmovisor will swap CometBFT binary and restart."
log "=========================================="

# Success alert
alert "Upgrade OK on $HOSTNAME_SHORT" "Upgrade '$UPGRADE_NAME' to $GIT_TAG complete. ABCI restarting with new code." "default" "white_check_mark"
