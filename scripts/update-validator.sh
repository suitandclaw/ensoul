#!/bin/bash
# update-validator.sh: One-command update for Ensoul Pioneer validators.
#
# Pulls latest code, rebuilds, restarts services in Rule 19 order.
# Safe to re-run. Does NOT touch identity, keys, or CometBFT config.
#
# Usage:
#   curl -fsSL https://ensoul.dev/update.sh -o update.sh
#   sudo bash update.sh
#
# What it does:
#   1. Safety checks (paths exist, pnpm available)
#   2. git fetch + reset --hard origin/main
#   3. pnpm install + pnpm build
#   4. Verify build output before touching services
#   5. Restart in Rule 19 order: stop CometBFT, restart ABCI, start CometBFT
#   6. Verify chain is advancing
#
# What it does NOT do:
#   - Touch identity.json, priv_validator_key.json, or config.toml
#   - Modify CometBFT data or genesis
#   - Change firewall rules or SSH config

set -uo pipefail

LOG="/tmp/ensoul-update-$(date +%Y%m%d-%H%M%S).log"

# Capture ALL output (stdout + stderr) to both terminal and log file.
# This ensures subprocess output (pnpm, systemctl, git) is logged
# without needing per-command redirection.
exec > >(tee -a "$LOG") 2>&1

echo "=== Ensoul Validator Update ==="
echo "Log: $LOG"
echo "Started: $(date -u)"
echo ""

# --- SAFETY CHECKS ---

if [ "$(id -u)" -ne 0 ]; then
    echo "ERROR: must run as root (use: sudo bash update.sh)"
    exit 1
fi

# Detect install location. Standard installs use /root/ensoul.
# Non-root installs (ensoul user) use /home/ensoul/ensoul.
ENSOUL_DIR=""
for candidate in /root/ensoul /home/ensoul/ensoul; do
    if [ -d "$candidate/.git" ]; then
        ENSOUL_DIR="$candidate"
        break
    fi
done

if [ -z "$ENSOUL_DIR" ]; then
    echo "ERROR: could not find Ensoul repo at /root/ensoul or /home/ensoul/ensoul"
    echo "This script updates standard Pioneer installs only."
    exit 1
fi

OWNER=$(stat -c '%U' "$ENSOUL_DIR" 2>/dev/null || stat -f '%Su' "$ENSOUL_DIR" 2>/dev/null || echo "root")
HOME_DIR=$(eval echo "~$OWNER")
VALIDATOR_KEY="$HOME_DIR/.cometbft-ensoul/node/config/priv_validator_key.json"

# Identity file location varies: standard install uses ~/.ensoul/identity.json,
# foundation validators use ~/.ensoul/validator-0/identity.json.
IDENTITY_FILE=""
for candidate in "$HOME_DIR/.ensoul/identity.json" "$HOME_DIR/.ensoul/validator-0/identity.json"; do
    if [ -f "$candidate" ]; then
        IDENTITY_FILE="$candidate"
        break
    fi
done

echo "Install dir: $ENSOUL_DIR"
echo "Owner: $OWNER"

if [ -z "$IDENTITY_FILE" ]; then
    echo "ERROR: no identity.json found in ~/.ensoul/ or ~/.ensoul/validator-0/"
    echo "This script updates standard Pioneer installs only."
    exit 1
fi

if [ ! -f "$VALIDATOR_KEY" ]; then
    echo "ERROR: expected file not found: $VALIDATOR_KEY"
    echo "This script updates standard Pioneer installs only."
    exit 1
fi

echo "Identity: $IDENTITY_FILE"
echo "Current version:"
grep VERSION "$ENSOUL_DIR/packages/node/src/version.ts" 2>/dev/null || echo "  (unknown)"
echo ""
echo "Safety checks: PASS"

# --- PULL LATEST CODE ---

cd "$ENSOUL_DIR"

echo ""
echo "Fetching latest code..."
git fetch origin main

LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/main)

if [ "$LOCAL" = "$REMOTE" ]; then
    echo "Code already at latest ($LOCAL)."
    echo ""

    # Detect service names FIRST so we can reuse them for stale check and restart.
    ABCI_SVC=""
    CMT_SVC=""
    for svc in ensoul-abci ensoul-node; do
        if systemctl list-unit-files "$svc.service" >/dev/null 2>&1; then
            ABCI_SVC="$svc"
            break
        fi
    done
    for svc in ensoul-cometbft cometbft; do
        if systemctl list-unit-files "$svc.service" >/dev/null 2>&1; then
            CMT_SVC="$svc"
            break
        fi
    done

    # Stale service detection: if code is current but services started
    # before the current HEAD was committed, a previous run may have
    # pulled code but failed to build or restart. Detect and fix.
    HEAD_COMMIT_TIME=$(git log -1 --format=%ct HEAD)
    STALE_SERVICES=""

    for svc in "$ABCI_SVC" "$CMT_SVC" ensoul-api ensoul-proxy ensoul-heartbeat ensoul-monitor ensoul-explorer ensoul-telegram-bot; do
        [ -z "$svc" ] && continue
        if systemctl is-active "$svc" >/dev/null 2>&1; then
            SVC_START=$(systemctl show "$svc" -p ActiveEnterTimestamp --value 2>/dev/null || \
                        systemctl show "$svc" -p ActiveEnterTimestamp | cut -d= -f2)
            SVC_START_EPOCH=$(date -d "$SVC_START" +%s 2>/dev/null || echo 0)
            if [ "$SVC_START_EPOCH" -lt "$HEAD_COMMIT_TIME" ]; then
                STALE_SERVICES="$STALE_SERVICES $svc"
                echo "STALE: $svc started at $SVC_START (before HEAD commit at $(date -d @$HEAD_COMMIT_TIME 2>/dev/null || date -r $HEAD_COMMIT_TIME 2>/dev/null))"
            fi
        fi
    done

    # Also check if build artifacts exist (a previous pull may have
    # succeeded but build failed)
    BUILD_MISSING=false
    if [ ! -d "packages/abci-server/dist" ]; then
        BUILD_MISSING=true
        echo "STALE: packages/abci-server/dist missing (build never completed)"
    else
        DIST_SIZE=$(du -sb packages/abci-server/dist 2>/dev/null | awk '{print $1}' || echo "0")
        if [ "$DIST_SIZE" -lt 10000 ]; then
            BUILD_MISSING=true
            echo "STALE: packages/abci-server/dist suspiciously small ($DIST_SIZE bytes)"
        fi
    fi

    if [ -z "$STALE_SERVICES" ] && [ "$BUILD_MISSING" = "false" ]; then
        # Before exiting: check if heartbeat client needs installing
        if ! systemctl list-unit-files ensoul-heartbeat.service >/dev/null 2>&1; then
            echo "Heartbeat client not installed. Installing..."
            NODE_BIN_DIR=$(dirname "$(which node 2>/dev/null || echo /usr/local/bin/node)")
            tee /etc/systemd/system/ensoul-heartbeat.service > /dev/null << HB_EOF
[Unit]
Description=Ensoul Heartbeat Client
After=ensoul-cometbft.service
Wants=ensoul-cometbft.service

[Service]
Type=simple
User=$OWNER
WorkingDirectory=$ENSOUL_DIR
Environment=PATH=$NODE_BIN_DIR:/usr/local/go/bin:$HOME_DIR/go/bin:/usr/local/bin:/usr/bin:/bin
Environment=HOME=$HOME_DIR
ExecStart=$NODE_BIN_DIR/npx tsx packages/heartbeat-client/src/start.ts
Restart=always
RestartSec=10
StandardOutput=append:$HOME_DIR/.ensoul/heartbeat.log
StandardError=append:$HOME_DIR/.ensoul/heartbeat.log

[Install]
WantedBy=multi-user.target
HB_EOF
            systemctl daemon-reload
            systemctl enable --now ensoul-heartbeat
            echo "  Heartbeat client installed and started."
        fi

        echo "Services are up-to-date."
        echo ""
        echo "=== COMPLETE ==="
        exit 0
    fi

    echo ""
    echo "Code is current but services need attention."

    # If build is missing, fall through to the full build + restart path below.
    if [ "$BUILD_MISSING" = "true" ]; then
        echo "Rebuilding (previous build may have failed)..."
        # Fall through past the fi to the BUILD section
    else
        # Build exists but services are stale. Restart only.
        echo "Restarting stale services..."

        if [ -n "$ABCI_SVC" ] && [ -n "$CMT_SVC" ]; then
            echo "  Stopping CometBFT ($CMT_SVC)..."
            systemctl stop "$CMT_SVC" 2>/dev/null || true
            sleep 2
            echo "  Restarting ABCI ($ABCI_SVC)..."
            systemctl restart "$ABCI_SVC"
            sleep 3
            echo "  Starting CometBFT ($CMT_SVC)..."
            systemctl start "$CMT_SVC"
            sleep 5

            for extra_svc in ensoul-api ensoul-proxy ensoul-heartbeat ensoul-monitor ensoul-explorer ensoul-telegram-bot; do
                if echo "$STALE_SERVICES" | grep -qw "$extra_svc"; then
                    echo "  Restarting $extra_svc..."
                    systemctl restart "$extra_svc" 2>/dev/null || true
                fi
            done

            echo ""
            echo "=== STALE SERVICES RESTARTED ==="
            echo "  Version: $(grep VERSION packages/node/src/version.ts 2>/dev/null | head -1 | sed 's/.*"\(.*\)".*/\1/')"
            echo "  Git: $(git rev-parse --short HEAD)"
            echo "  Log: $LOG"
            echo ""
            exit 0
        else
            echo "Could not detect service names. Falling through to full update."
        fi
    fi
    # Fall through to build + restart for BUILD_MISSING case
fi

echo "Local:  $LOCAL"
echo "Remote: $REMOTE"
echo ""

# Stash any local changes (shouldn't be any on a standard install)
git stash --include-untracked 2>/dev/null || true

git reset --hard origin/main
echo "Code pulled. New HEAD: $(git rev-parse --short HEAD)"
echo "New version:"
grep VERSION packages/node/src/version.ts 2>/dev/null || echo "  (unknown)"

# --- BUILD ---

echo ""
echo "Installing dependencies..."

# Ensure pnpm is in PATH (nvm installs put it in a versioned dir)
if ! command -v pnpm >/dev/null 2>&1; then
    for p in "$HOME_DIR/.local/share/pnpm/pnpm" /usr/local/bin/pnpm; do
        if [ -x "$p" ]; then
            export PATH="$(dirname "$p"):$PATH"
            break
        fi
    done
    # Try nvm paths
    if ! command -v pnpm >/dev/null 2>&1; then
        nvm_pnpm=$(ls "$HOME_DIR"/.nvm/versions/node/*/bin/pnpm 2>/dev/null | head -1)
        if [ -n "$nvm_pnpm" ] && [ -x "$nvm_pnpm" ]; then
            export PATH="$(dirname "$nvm_pnpm"):$PATH"
        fi
    fi
fi

# Ensure node is in PATH
if ! command -v node >/dev/null 2>&1; then
    nvm_node=$(ls "$HOME_DIR"/.nvm/versions/node/*/bin/node 2>/dev/null | head -1)
    if [ -n "$nvm_node" ] && [ -x "$nvm_node" ]; then
        export PATH="$(dirname "$nvm_node"):$PATH"
    fi
fi

if ! command -v pnpm >/dev/null 2>&1; then
    echo "ERROR: pnpm not found in PATH"
    echo "Tried: \$HOME/.local/share/pnpm, /usr/local/bin, nvm paths"
    exit 1
fi

echo "Using pnpm: $(which pnpm) ($(pnpm -v))"
echo "Using node: $(which node) ($(node -v))"

# Run as the repo owner if not root-owned
if [ "$OWNER" != "root" ]; then
    sudo -u "$OWNER" pnpm install --frozen-lockfile
    sudo -u "$OWNER" pnpm build
else
    pnpm install --frozen-lockfile
    pnpm build
fi

# Verify build produced expected output
DIST="packages/abci-server/dist"
if [ ! -d "$DIST" ]; then
    echo "ERROR: build did not produce $DIST"
    echo "Services NOT restarted. Old code still running."
    exit 1
fi

BUILD_SIZE=$(du -sb "$DIST" 2>/dev/null | awk '{print $1}' || echo "0")
if [ "$BUILD_SIZE" -lt 10000 ]; then
    echo "ERROR: build output suspiciously small ($BUILD_SIZE bytes)"
    echo "Services NOT restarted. Old code still running."
    exit 1
fi

echo "Build: PASS ($BUILD_SIZE bytes in $DIST)"

# --- RESTART SERVICES (Rule 19 order) ---

echo ""
echo "Restarting services in Rule 19 order..."

# Detect service names (standard install uses ensoul-abci + ensoul-cometbft)
ABCI_SVC=""
CMT_SVC=""
for svc in ensoul-abci ensoul-node; do
    if systemctl list-unit-files "$svc.service" >/dev/null 2>&1; then
        ABCI_SVC="$svc"
        break
    fi
done
for svc in ensoul-cometbft cometbft; do
    if systemctl list-unit-files "$svc.service" >/dev/null 2>&1; then
        CMT_SVC="$svc"
        break
    fi
done

if [ -z "$ABCI_SVC" ] || [ -z "$CMT_SVC" ]; then
    echo "ERROR: could not find systemd services"
    echo "Expected ensoul-abci + ensoul-cometbft (or variants)"
    echo "Running services:"
    systemctl list-units --type=service --state=running 2>/dev/null | grep -i ensoul || echo "  (none found)"
    echo "Services NOT restarted. New code is built but not running."
    exit 1
fi

echo "  Services: $ABCI_SVC + $CMT_SVC"

echo "  1. Stopping CometBFT ($CMT_SVC)..."
systemctl stop "$CMT_SVC" 2>/dev/null || true
sleep 2

echo "  2. Restarting ABCI ($ABCI_SVC)..."
systemctl restart "$ABCI_SVC"
sleep 3

# Verify ABCI is listening
if ! ss -tlnp 2>/dev/null | grep -q ':26658' && ! lsof -iTCP:26658 -sTCP:LISTEN -t >/dev/null 2>&1; then
    echo "  ABCI not listening yet, waiting 5 more seconds..."
    sleep 5
    if ! ss -tlnp 2>/dev/null | grep -q ':26658' && ! lsof -iTCP:26658 -sTCP:LISTEN -t >/dev/null 2>&1; then
        echo "ERROR: ABCI failed to start on port 26658"
        echo "Check: journalctl -u $ABCI_SVC -n 50 --no-pager"
        exit 1
    fi
fi
echo "  ABCI listening on :26658"

echo "  3. Starting CometBFT ($CMT_SVC)..."
systemctl start "$CMT_SVC"
sleep 5

# Verify CometBFT is responding
if ! curl -s -m 5 http://localhost:26657/status >/dev/null 2>&1; then
    echo "  CometBFT not responding yet, waiting 10 more seconds..."
    sleep 10
fi

if ! curl -s -m 5 http://localhost:26657/status >/dev/null 2>&1; then
    echo "ERROR: CometBFT failed to start"
    echo "Check: journalctl -u $CMT_SVC -n 50 --no-pager"
    exit 1
fi

# Also restart API and proxy if they exist
for extra_svc in ensoul-api ensoul-proxy ensoul-heartbeat; do
    if systemctl is-active "$extra_svc" >/dev/null 2>&1; then
        echo "  Restarting $extra_svc..."
        systemctl restart "$extra_svc" 2>/dev/null || true
    fi
done

# Install heartbeat client if not present (new addition to the stack)
if ! systemctl list-unit-files ensoul-heartbeat.service >/dev/null 2>&1; then
    echo ""
    echo "Installing heartbeat client (new)..."
    NODE_BIN_DIR=$(dirname "$(which node 2>/dev/null || echo /usr/local/bin/node)")
    tee /etc/systemd/system/ensoul-heartbeat.service > /dev/null << HB_EOF
[Unit]
Description=Ensoul Heartbeat Client
After=ensoul-cometbft.service
Wants=ensoul-cometbft.service

[Service]
Type=simple
User=$OWNER
WorkingDirectory=$ENSOUL_DIR
Environment=PATH=$NODE_BIN_DIR:/usr/local/go/bin:$HOME_DIR/go/bin:/usr/local/bin:/usr/bin:/bin
Environment=HOME=$HOME_DIR
ExecStart=$NODE_BIN_DIR/npx tsx packages/heartbeat-client/src/start.ts
Restart=always
RestartSec=10
StandardOutput=append:$HOME_DIR/.ensoul/heartbeat.log
StandardError=append:$HOME_DIR/.ensoul/heartbeat.log

[Install]
WantedBy=multi-user.target
HB_EOF
    systemctl daemon-reload
    systemctl enable --now ensoul-heartbeat
    echo "  Heartbeat client installed and started."
fi

# --- VERIFY CHAIN PROGRESS ---

echo ""
echo "Verifying chain progress..."

HEIGHT1=$(curl -s -m 5 http://localhost:26657/status 2>/dev/null | python3 -c "import json,sys;print(json.load(sys.stdin)['result']['sync_info']['latest_block_height'])" 2>/dev/null || echo "0")
CATCHING=$(curl -s -m 5 http://localhost:26657/status 2>/dev/null | python3 -c "import json,sys;print(json.load(sys.stdin)['result']['sync_info']['catching_up'])" 2>/dev/null || echo "unknown")
PEERS=$(curl -s -m 5 http://localhost:26657/net_info 2>/dev/null | python3 -c "import json,sys;print(json.load(sys.stdin)['result']['n_peers'])" 2>/dev/null || echo "0")

echo "  Height: $HEIGHT1"
echo "  Catching up: $CATCHING"
echo "  Peers: $PEERS"

if [ "$PEERS" = "0" ]; then
    echo "  WARN: no peers connected. May take a minute to reconnect."
fi

sleep 25

HEIGHT2=$(curl -s -m 5 http://localhost:26657/status 2>/dev/null | python3 -c "import json,sys;print(json.load(sys.stdin)['result']['sync_info']['latest_block_height'])" 2>/dev/null || echo "0")

if [ "$HEIGHT2" != "0" ] && [ "$HEIGHT1" != "0" ] && [ "$HEIGHT2" -gt "$HEIGHT1" ]; then
    echo "  Chain advancing: $HEIGHT1 -> $HEIGHT2 (+$((HEIGHT2 - HEIGHT1)) blocks in 25s)"
    echo "  Status: HEALTHY"
elif [ "$CATCHING" = "True" ] || [ "$CATCHING" = "true" ]; then
    echo "  Chain syncing (catching_up=true). This is normal after an update."
    echo "  Check again in a few minutes: curl -s localhost:26657/status"
else
    echo "  WARN: height did not advance in 25s ($HEIGHT1 -> $HEIGHT2)"
    echo "  This can be normal during round transitions. Check in 1 minute."
fi

# --- SUCCESS ---

echo ""
echo "=========================================="
echo "  UPDATE COMPLETE"
echo "=========================================="
echo "  Version: $(grep VERSION packages/node/src/version.ts 2>/dev/null | head -1 | sed 's/.*"\(.*\)".*/\1/')"
echo "  Git: $(git rev-parse --short HEAD)"
echo "  Height: $HEIGHT2"
echo "  Peers: $PEERS"
echo "  Log: $LOG"
echo "=========================================="
echo ""
echo "If anything looks wrong, send $LOG to the Ensoul team."
