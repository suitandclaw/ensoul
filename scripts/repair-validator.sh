#!/bin/bash
# repair-validator.sh: One-time repair for pre-April-11 Ensoul Pioneer installs.
#
# Ensures the validator has:
#   1. ExecStopPost in ensoul-abci.service (auto-upgrade on halt)
#   2. ensoul-heartbeat.service installed, enabled, active
#   3. identity.json derived from priv_validator_key.json
#   4. auto-upgrade.sh present and executable
#   5. Latest code pulled and built
#   6. Services restarted in Rule 19 order
#
# Safe to re-run (idempotent). Does NOT touch priv_validator_key.json.
#
# Usage:
#   curl -fsSL https://ensoul.dev/repair.sh -o repair.sh
#   sudo bash repair.sh

set -uo pipefail

LOG="/tmp/ensoul-repair-$(date +%Y%m%d-%H%M%S).log"
exec > >(tee -a "$LOG") 2>&1

echo "=== Ensoul Validator Repair ==="
echo "Log: $LOG"
echo "Started: $(date -u)"
echo ""

# --- ROOT CHECK ---

if [ "$(id -u)" -ne 0 ]; then
    echo "ERROR: must run as root (use: sudo bash repair.sh)"
    exit 1
fi

# --- DETECT INSTALL ---

ENSOUL_DIR=""
for candidate in /root/ensoul /home/ensoul/ensoul; do
    if [ -d "$candidate/.git" ]; then
        ENSOUL_DIR="$candidate"
        break
    fi
done

if [ -z "$ENSOUL_DIR" ]; then
    echo "ERROR: could not find Ensoul repo"
    exit 1
fi

OWNER=$(stat -c '%U' "$ENSOUL_DIR" 2>/dev/null || stat -f '%Su' "$ENSOUL_DIR" 2>/dev/null || echo "root")
HOME_DIR=$(eval echo "~$OWNER")
CMT_HOME="$HOME_DIR/.cometbft-ensoul/node"
PRIV_KEY="$CMT_HOME/config/priv_validator_key.json"

echo "Install dir: $ENSOUL_DIR"
echo "Owner: $OWNER"
echo "CometBFT home: $CMT_HOME"

if [ ! -f "$PRIV_KEY" ]; then
    echo "ERROR: priv_validator_key.json not found at $PRIV_KEY"
    exit 1
fi

# Detect service names
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
    echo "ERROR: could not find systemd services (ensoul-abci + ensoul-cometbft)"
    exit 1
fi
echo "Services: $ABCI_SVC + $CMT_SVC"

# Ensure node/pnpm in PATH
if ! command -v node >/dev/null 2>&1; then
    nvm_node=$(ls "$HOME_DIR"/.nvm/versions/node/*/bin/node 2>/dev/null | head -1)
    if [ -n "$nvm_node" ] && [ -x "$nvm_node" ]; then
        export PATH="$(dirname "$nvm_node"):$PATH"
    fi
fi
if ! command -v pnpm >/dev/null 2>&1; then
    for p in "$HOME_DIR/.local/share/pnpm/pnpm" /usr/local/bin/pnpm; do
        if [ -x "$p" ]; then export PATH="$(dirname "$p"):$PATH"; break; fi
    done
    if ! command -v pnpm >/dev/null 2>&1; then
        nvm_pnpm=$(ls "$HOME_DIR"/.nvm/versions/node/*/bin/pnpm 2>/dev/null | head -1)
        if [ -n "$nvm_pnpm" ] && [ -x "$nvm_pnpm" ]; then
            export PATH="$(dirname "$nvm_pnpm"):$PATH"
        fi
    fi
fi
NODE_BIN_DIR=$(dirname "$(which node 2>/dev/null || echo /usr/local/bin/node)")

echo ""
echo "--- Step 1: Ensure ExecStopPost in $ABCI_SVC ---"

SVC_FILE="/etc/systemd/system/${ABCI_SVC}.service"
if [ ! -f "$SVC_FILE" ]; then
    echo "WARNING: service file not found at $SVC_FILE"
else
    if grep -q "ExecStopPost" "$SVC_FILE"; then
        echo "  ExecStopPost already present"
    else
        echo "  Adding ExecStopPost to $SVC_FILE"
        cp "$SVC_FILE" "${SVC_FILE}.bak.$(date +%s)"
        # Insert ExecStopPost after ExecStart line
        sed -i "/^ExecStart=/a ExecStopPost=$ENSOUL_DIR/scripts/auto-upgrade.sh" "$SVC_FILE"
        echo "  Added"
    fi

    # Ensure required Environment variables
    for envvar in "ENSOUL_REPO=$ENSOUL_DIR" "DAEMON_HOME=$CMT_HOME"; do
        KEY=$(echo "$envvar" | cut -d= -f1)
        if grep -q "Environment=$KEY=" "$SVC_FILE"; then
            echo "  Environment $KEY already set"
        else
            sed -i "/^\[Service\]/a Environment=$envvar" "$SVC_FILE"
            echo "  Added Environment=$envvar"
        fi
    done

    # Ensure TimeoutStopSec and KillMode
    if ! grep -q "TimeoutStopSec" "$SVC_FILE"; then
        sed -i "/^\[Service\]/a TimeoutStopSec=30" "$SVC_FILE"
        echo "  Added TimeoutStopSec=30"
    fi
    if ! grep -q "KillMode" "$SVC_FILE"; then
        sed -i "/^\[Service\]/a KillMode=mixed" "$SVC_FILE"
        echo "  Added KillMode=mixed"
    fi

    systemctl daemon-reload
    echo "  daemon-reload done"
fi

echo ""
echo "--- Step 2: Ensure identity.json ---"

IDENTITY_FILE="$HOME_DIR/.ensoul/identity.json"
if [ -f "$IDENTITY_FILE" ]; then
    echo "  identity.json exists at $IDENTITY_FILE"
    python3 -c "import json;d=json.load(open('$IDENTITY_FILE'));print('  DID:',d.get('did','MISSING')[:40],'...')" 2>/dev/null || echo "  WARNING: could not parse identity.json"
else
    echo "  Deriving identity from priv_validator_key.json..."
    python3 -c "
import json, base64
d = json.load(open('$PRIV_KEY'))
pub = base64.b64decode(d['pub_key']['value'])
priv = base64.b64decode(d['priv_key']['value'])
seed = priv[:32].hex()
B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
mc = b'\xed\x01' + pub
num = int.from_bytes(mc, 'big')
r = ''
while num > 0:
    num, rem = divmod(num, 58)
    r = B58[rem] + r
for byte in mc:
    if byte == 0: r = '1' + r
    else: break
did = 'did:key:z' + r
identity = {'did': did, 'seed': seed}
import os
os.makedirs('$HOME_DIR/.ensoul', exist_ok=True)
with open('$IDENTITY_FILE', 'w') as f:
    json.dump(identity, f, indent=2)
os.chmod('$IDENTITY_FILE', 0o600)
if '$OWNER' != 'root':
    import shutil
    shutil.chown('$IDENTITY_FILE', user='$OWNER', group='$OWNER')
print('  Created:', did[:40], '...')
" 2>/dev/null
    if [ ! -f "$IDENTITY_FILE" ]; then
        echo "  ERROR: failed to create identity.json"
    fi
fi

echo ""
echo "--- Step 3: Ensure ensoul-heartbeat.service ---"

if systemctl list-unit-files ensoul-heartbeat.service >/dev/null 2>&1; then
    echo "  ensoul-heartbeat.service already installed"
    if systemctl is-active ensoul-heartbeat >/dev/null 2>&1; then
        echo "  Service is active"
    else
        echo "  Starting service..."
        systemctl start ensoul-heartbeat
    fi
else
    echo "  Installing ensoul-heartbeat.service..."
    tee /etc/systemd/system/ensoul-heartbeat.service > /dev/null << HB_EOF
[Unit]
Description=Ensoul Heartbeat Client
After=${CMT_SVC}.service
Wants=${CMT_SVC}.service

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
    echo "  Installed and started"
fi

echo ""
echo "--- Step 4: Ensure auto-upgrade.sh ---"

if [ -f "$ENSOUL_DIR/scripts/auto-upgrade.sh" ]; then
    chmod +x "$ENSOUL_DIR/scripts/auto-upgrade.sh"
    echo "  auto-upgrade.sh present and executable"
else
    echo "  WARNING: auto-upgrade.sh not found (will be created by code update)"
fi

echo ""
echo "--- Step 5: Pull latest code and build ---"

cd "$ENSOUL_DIR"
BEFORE_HEAD=$(git rev-parse HEAD)
echo "  Current HEAD: $(git rev-parse --short HEAD)"
git fetch origin --prune --tags
LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/main)
NEEDS_BUILD=false

if [ "$LOCAL" != "$REMOTE" ]; then
    NEEDS_BUILD=true
    echo "  Code update needed: $(git rev-parse --short HEAD) -> $(git rev-parse --short origin/main)"

    # Stop services BEFORE building to free memory on small VPS.
    # A 2GB VPS cannot run validator services + turbo build concurrently.
    echo "  Stopping services for build..."
    systemctl stop "$CMT_SVC" 2>/dev/null || true
    systemctl stop "$ABCI_SVC" 2>/dev/null || true
    systemctl stop ensoul-heartbeat 2>/dev/null || true
    sleep 2

    # Force local state to match origin. Handles divergent histories
    # from git-filter-repo rewrites or force pushes.
    git reset --hard origin/main
    git clean -fd 2>/dev/null || true
    echo "  Updated from $(git rev-parse --short $BEFORE_HEAD) to $(git rev-parse --short HEAD)"

    # Limit turbo concurrency to prevent OOM on low-memory machines
    export TURBO_CONCURRENCY=2

    if [ "$OWNER" != "root" ]; then
        sudo -u "$OWNER" TURBO_CONCURRENCY=2 pnpm install --frozen-lockfile 2>&1 | tail -3
        sudo -u "$OWNER" TURBO_CONCURRENCY=2 pnpm build 2>&1 | tail -5
    else
        pnpm install --frozen-lockfile 2>&1 | tail -3
        pnpm build 2>&1 | tail -5
    fi

    DIST="packages/abci-server/dist"
    if [ ! -d "$DIST" ]; then
        echo "  ERROR: build failed (no dist directory)"
        echo "  Attempting to restart services despite build failure..."
        systemctl start "$ABCI_SVC" 2>/dev/null || true
        sleep 3
        systemctl start "$CMT_SVC" 2>/dev/null || true
        systemctl start ensoul-heartbeat 2>/dev/null || true
        exit 1
    fi
    echo "  Build complete"
else
    echo "  Already at latest ($(git rev-parse --short HEAD))"
fi

echo ""
echo "--- Step 6: Restart services (Rule 19 order) ---"

if [ "$NEEDS_BUILD" = true ]; then
    # Services were stopped in Step 5. Start them fresh.
    systemctl start "$ABCI_SVC"
else
    # Services still running. Rule 19: stop CometBFT first, then restart ABCI.
    systemctl stop "$CMT_SVC" 2>/dev/null || true
    sleep 2
    systemctl restart "$ABCI_SVC"
fi

sleep 3
if ! ss -tlnp 2>/dev/null | grep -q ':26658' && ! lsof -iTCP:26658 -sTCP:LISTEN -t >/dev/null 2>&1; then
    sleep 5
fi

systemctl start "$CMT_SVC"
sleep 5

# Restart heartbeat
systemctl restart ensoul-heartbeat 2>/dev/null || true

echo ""
echo "--- Step 7: Verify ---"

VER=$(grep -o '"[0-9.]*"' "$ENSOUL_DIR/packages/node/src/version.ts" 2>/dev/null | tr -d '"')
ABCI_ACTIVE=$(systemctl is-active "$ABCI_SVC" 2>/dev/null)
CMT_ACTIVE=$(systemctl is-active "$CMT_SVC" 2>/dev/null)
HB_ACTIVE=$(systemctl is-active ensoul-heartbeat 2>/dev/null)
HAS_ESP=$(grep -c ExecStopPost "$SVC_FILE" 2>/dev/null || echo "0")
HAS_ID=$([ -f "$IDENTITY_FILE" ] && echo "yes" || echo "no")

echo "  Version: $VER"
echo "  ABCI: $ABCI_ACTIVE"
echo "  CometBFT: $CMT_ACTIVE"
echo "  Heartbeat: $HB_ACTIVE"
echo "  ExecStopPost: $([ "$HAS_ESP" -gt 0 ] && echo "yes" || echo "no")"
echo "  Identity: $HAS_ID"

CHECKS=0
[ "$ABCI_ACTIVE" = "active" ] && CHECKS=$((CHECKS+1))
[ "$CMT_ACTIVE" = "active" ] && CHECKS=$((CHECKS+1))
[ "$HB_ACTIVE" = "active" ] && CHECKS=$((CHECKS+1))
[ "$HAS_ESP" -gt 0 ] 2>/dev/null && CHECKS=$((CHECKS+1))
[ "$HAS_ID" = "yes" ] && CHECKS=$((CHECKS+1))

echo ""
if [ "$CHECKS" -eq 5 ]; then
    echo "=========================================="
    echo "  REPAIR COMPLETE ($CHECKS/5 checks pass)"
    echo "=========================================="
    echo "  Version: $VER"
    echo "  Your validator will auto-upgrade on future SOFTWARE_UPGRADE broadcasts."
    echo "  Heartbeat telemetry is active."
    echo "  Log: $LOG"
else
    echo "=========================================="
    echo "  REPAIR INCOMPLETE ($CHECKS/5 checks pass)"
    echo "=========================================="
    echo "  Some checks failed. Send $LOG to the Ensoul team."
fi
echo ""
