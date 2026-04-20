#!/usr/bin/env bash
#
# install-validator.sh
#
# One-command Ensoul validator installer. Works on Ubuntu/Debian 22.04+ and macOS.
# Sets up Go, Node.js, pnpm, CometBFT 0.38.x, Cosmovisor, clones the repo,
# builds, generates validator keys, downloads genesis, configures networking,
# and starts everything with a systemd (Linux) or launchd (macOS) service.
#
# Usage (two steps — download, then run — to avoid pipe and quoting issues):
#   curl -fsSL https://raw.githubusercontent.com/suitandclaw/ensoul/main/scripts/install-validator.sh -o install.sh
#   bash install.sh [options]
#
# Example:
#   bash install.sh --pioneer --contact "you@example.com"
#
# Options:
#   --moniker NAME     Set a custom validator name (default: ensoul-$(hostname -s))
#   --seed HEX         Import an existing Ed25519 seed instead of generating a new one
#   --pioneer          Register as a pioneer validator (requires PIONEER_KEY env var)
#   --skip-start       Install everything but do not start services
#
# Requirements:
#   - Ubuntu/Debian 22.04+ or macOS 13+
#   - At least 2 CPU cores, 4 GB RAM, 40 GB disk
#   - Port 26656 reachable from the internet (or use Tailscale)
#

set -euo pipefail

# ── Constants ────────────────────────────────────────────────────────

REPO_URL="https://github.com/suitandclaw/ensoul.git"
API_URL="https://api.ensoul.dev"
CHAIN_ID="ensoul-1"
SEED_NODE="402a9f5c503c36d0dca5f1a8b7a3a2263efd039a@178.156.199.91:26656,88fea3527d9f18d9aeefb2a98cfc30d7100eb2e3@5.78.199.4:26656,d5c90211b5ae06681368098e1b14ee1eff742c72@204.168.192.25:26656,a2372f66c0a1f2cdbace25a9592f5119c97fb619@178.104.95.163:26656,11389d3a846b00b68e9f4446a9b15ab0d095954b@157.230.54.91:26656,525c2d5b269a63011ac1a349554b16a260d1fe25@152.42.175.202:26656"
GO_VERSION="1.23.8"
COMETBFT_VERSION="v0.38.17"
COSMOVISOR_VERSION="v1.5.0"
NODE_VERSION="22"

ENSOUL_DIR="$HOME/ensoul"
DATA_DIR="$HOME/.ensoul"
CMT_HOME="$HOME/.cometbft-ensoul/node"
LOG_FILE="$DATA_DIR/install.log"

MONIKER="ensoul-$(hostname -s 2>/dev/null || echo validator)"
SEED_ARG=""
PIONEER_MODE=false
PIONEER_CONTACT=""
SKIP_START=false

# ── Parse arguments ──────────────────────────────────────────────────

while [ $# -gt 0 ]; do
    case "$1" in
        --moniker)  MONIKER="$2"; shift 2 ;;
        --seed)     SEED_ARG="$2"; shift 2 ;;
        --pioneer)  PIONEER_MODE=true; shift ;;
        --contact)  PIONEER_CONTACT="$2"; shift 2 ;;
        --skip-start) SKIP_START=true; shift ;;
        *) echo "Unknown option: $1"; exit 1 ;;
    esac
done

# ── Helpers ──────────────────────────────────────────────────────────

mkdir -p "$DATA_DIR"

log() {
    local ts
    ts=$(date +"%Y-%m-%d %H:%M:%S")
    echo "[$ts] $1" | tee -a "$LOG_FILE"
}

fail() {
    log "FATAL: $1"
    exit 1
}

command_exists() {
    command -v "$1" >/dev/null 2>&1
}

# ── OS Detection ─────────────────────────────────────────────────────

detect_os() {
    local uname_s
    uname_s=$(uname -s)
    case "$uname_s" in
        Linux)
            if [ -f /etc/os-release ]; then
                . /etc/os-release
                case "$ID" in
                    ubuntu|debian) OS="ubuntu" ;;
                    *) fail "Unsupported Linux distribution: $ID. Only Ubuntu/Debian are supported." ;;
                esac
            else
                fail "Cannot detect Linux distribution. /etc/os-release not found."
            fi
            ARCH=$(uname -m)
            case "$ARCH" in
                x86_64)  GO_ARCH="amd64"; CMT_ARCH="linux_amd64" ;;
                aarch64) GO_ARCH="arm64"; CMT_ARCH="linux_arm64" ;;
                *) fail "Unsupported architecture: $ARCH" ;;
            esac
            ;;
        Darwin)
            OS="macos"
            ARCH=$(uname -m)
            case "$ARCH" in
                x86_64)  GO_ARCH="amd64"; CMT_ARCH="darwin_amd64" ;;
                arm64)   GO_ARCH="arm64"; CMT_ARCH="darwin_arm64" ;;
                *) fail "Unsupported architecture: $ARCH" ;;
            esac
            ;;
        *) fail "Unsupported OS: $uname_s" ;;
    esac
    log "Detected OS: $OS ($ARCH)"
}

# ── Step 1: Install Go ──────────────────────────────────────────────

install_go() {
    if command_exists go; then
        log "Go already installed: $(go version)"
        return
    fi

    log "Installing Go $GO_VERSION..."
    local go_tar="go${GO_VERSION}.$(uname -s | tr '[:upper:]' '[:lower:]')-${GO_ARCH}.tar.gz"
    local go_url="https://go.dev/dl/${go_tar}"

    if [ "$OS" = "ubuntu" ]; then
        sudo rm -rf /usr/local/go
        curl -sL "$go_url" | sudo tar -C /usr/local -xzf -
        export PATH="/usr/local/go/bin:$HOME/go/bin:$PATH"
        # Persist in profile
        if ! grep -q '/usr/local/go/bin' "$HOME/.profile" 2>/dev/null; then
            echo 'export PATH="/usr/local/go/bin:$HOME/go/bin:$PATH"' >> "$HOME/.profile"
        fi
    else
        curl -sL "$go_url" | sudo tar -C /usr/local -xzf -
        export PATH="/usr/local/go/bin:$HOME/go/bin:$PATH"
        if ! grep -q '/usr/local/go/bin' "$HOME/.zprofile" 2>/dev/null; then
            echo 'export PATH="/usr/local/go/bin:$HOME/go/bin:$PATH"' >> "$HOME/.zprofile"
        fi
    fi

    go version || fail "Go installation failed"
    log "Go $(go version) installed."
}

# ── Step 2: Install Node.js ─────────────────────────────────────────

install_node() {
    export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"

    if command_exists node; then
        local node_major
        node_major=$(node -v | cut -d. -f1 | tr -d v)
        if [ "$node_major" -ge "$NODE_VERSION" ] 2>/dev/null; then
            log "Node.js $(node -v) already installed."
            return
        fi
    fi

    log "Installing Node.js $NODE_VERSION via nvm..."

    if [ ! -s "$NVM_DIR/nvm.sh" ]; then
        curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
    fi

    . "$NVM_DIR/nvm.sh"
    nvm install "$NODE_VERSION"
    nvm use "$NODE_VERSION"
    nvm alias default "$NODE_VERSION"

    node --version || fail "Node.js installation failed"
    log "Node.js $(node -v) installed."
}

# ── Step 3: Install pnpm ────────────────────────────────────────────

install_pnpm() {
    if command_exists pnpm; then
        log "pnpm $(pnpm -v) already installed."
        return
    fi

    log "Installing pnpm..."
    npm install -g pnpm
    pnpm --version || fail "pnpm installation failed"
    log "pnpm $(pnpm -v) installed."
}

# ── Step 4: Install CometBFT ────────────────────────────────────────

install_cometbft() {
    if [ -f "$HOME/go/bin/cometbft" ]; then
        local cur_ver
        cur_ver=$("$HOME/go/bin/cometbft" version 2>/dev/null || echo "0")
        if [ "$cur_ver" = "${COMETBFT_VERSION#v}" ]; then
            log "CometBFT $cur_ver already installed."
            return
        fi
    fi

    log "Installing CometBFT $COMETBFT_VERSION from source..."
    mkdir -p "$HOME/go/bin"

    local tmp_dir
    tmp_dir=$(mktemp -d)
    cd "$tmp_dir"
    git clone --branch "$COMETBFT_VERSION" --depth 1 https://github.com/cometbft/cometbft.git
    cd cometbft
    make install 2>&1 | tail -5
    cd "$HOME"
    rm -rf "$tmp_dir"

    "$HOME/go/bin/cometbft" version || fail "CometBFT installation failed"
    log "CometBFT $("$HOME/go/bin/cometbft" version) installed."
}

# ── Step 5: Install Cosmovisor ───────────────────────────────────────

install_cosmovisor() {
    if [ -f "$HOME/go/bin/cosmovisor" ]; then
        log "Cosmovisor already installed."
        return
    fi

    log "Installing Cosmovisor $COSMOVISOR_VERSION..."
    go install cosmossdk.io/tools/cosmovisor/cmd/cosmovisor@"$COSMOVISOR_VERSION"

    "$HOME/go/bin/cosmovisor" version 2>/dev/null || true
    log "Cosmovisor installed."
}

# ── Step 6: Install system dependencies (Linux only) ────────────────

install_system_deps() {
    if [ "$OS" = "ubuntu" ]; then
        log "Installing system dependencies..."
        sudo DEBIAN_FRONTEND=noninteractive apt-get update -qq
        sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq git curl build-essential jq
    elif [ "$OS" = "macos" ]; then
        if ! command_exists git; then
            log "Installing Xcode command line tools..."
            xcode-select --install 2>/dev/null || true
        fi
        if ! command_exists jq; then
            brew install jq 2>/dev/null || true
        fi
    fi
}

# ── Step 7: Clone and build ─────────────────────────────────────────

clone_and_build() {
    log "Setting up Ensoul repository..."
    if [ -d "$ENSOUL_DIR/.git" ]; then
        cd "$ENSOUL_DIR"
        git pull origin main --quiet 2>&1 || true
    else
        git clone "$REPO_URL" "$ENSOUL_DIR"
        cd "$ENSOUL_DIR"
    fi

    log "Installing dependencies..."
    pnpm install --frozen-lockfile 2>&1 | tail -5

    log "Building..."
    pnpm build 2>&1 | tail -5
    log "Build complete."
}

# ── Step 8: Initialize CometBFT ─────────────────────────────────────

init_cometbft() {
    local CMT_BIN="$HOME/go/bin/cometbft"

    if [ -d "$CMT_HOME/data/blockstore.db" ]; then
        log "CometBFT already initialized (blockstore exists). Skipping init."
        return
    fi

    log "Initializing CometBFT..."
    mkdir -p "$CMT_HOME"

    "$CMT_BIN" init --home "$CMT_HOME" 2>&1 | tail -3

    # Download genesis from the API
    log "Downloading genesis from $API_URL/genesis..."
    curl -sL "$API_URL/genesis" -o "$CMT_HOME/config/genesis.json"

    # Validate genesis
    local chain_id
    chain_id=$(jq -r '.chain_id' "$CMT_HOME/config/genesis.json" 2>/dev/null || echo "")
    if [ "$chain_id" != "$CHAIN_ID" ]; then
        fail "Genesis chain_id mismatch: expected $CHAIN_ID, got $chain_id"
    fi
    log "Genesis downloaded and validated (chain_id: $chain_id)."

    # Extract validator info for later display
    log "Validator key generated at $CMT_HOME/config/priv_validator_key.json"
}

# ── Step 9: Configure CometBFT ──────────────────────────────────────

configure_cometbft() {
    local CONFIG="$CMT_HOME/config/config.toml"

    log "Configuring CometBFT..."

    # Set moniker
    sed -i.bak "s/^moniker = .*/moniker = \"$MONIKER\"/" "$CONFIG"

    # Set proxy_app
    sed -i.bak 's|^proxy_app = .*|proxy_app = "tcp://127.0.0.1:26658"|' "$CONFIG"

    # Set seeds
    sed -i.bak "s|^seeds = .*|seeds = \"$SEED_NODE\"|" "$CONFIG"

    # Set external_address (auto-detect public IPv4)
    local public_ip
    public_ip=$(curl -4 -s -m 5 https://ifconfig.me 2>/dev/null || curl -4 -s -m 5 https://api.ipify.org 2>/dev/null || echo "")

    if [ -n "$public_ip" ]; then
        sed -i.bak "s|^external_address = .*|external_address = \"${public_ip}:26656\"|" "$CONFIG"
        log "External address set to ${public_ip}:26656"
    else
        log "WARNING: Could not detect public IP. Set external_address manually in $CONFIG"
        log "  If behind NAT, forward port 26656 or use Tailscale for peering."
    fi

    # Consensus timing (6s block time target)
    sed -i.bak 's/^timeout_propose = .*/timeout_propose = "3s"/' "$CONFIG"
    sed -i.bak 's/^timeout_commit = .*/timeout_commit = "6s"/' "$CONFIG"

    # Max inbound peers (support many validators)
    sed -i.bak 's/^max_num_inbound_peers = .*/max_num_inbound_peers = 50/' "$CONFIG"

    # State sync: fetch a recent snapshot instead of replaying from genesis
    log "Configuring state sync..."
    local SEED_IP
    SEED_IP=$(echo "$SEED_NODE" | cut -d, -f1 | sed 's/.*@//' | sed 's/:.*//')

    # Get a trust height and hash from the seed node's RPC
    local CURRENT_HEIGHT
    CURRENT_HEIGHT=$(curl -s -m 10 "http://${SEED_IP}:26657/status" 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin)['result']['sync_info']['latest_block_height'])" 2>/dev/null || echo "0")

    if [ "$CURRENT_HEIGHT" -gt 2000 ] 2>/dev/null; then
        # Align trust height to snapshot interval (1000 blocks) and go back one interval
        # so a snapshot definitely exists at this height
        local TRUST_HEIGHT=$(( (CURRENT_HEIGHT / 1000 - 1) * 1000 ))
        local TRUST_HASH
        TRUST_HASH=$(curl -s -m 10 "http://${SEED_IP}:26657/block?height=${TRUST_HEIGHT}" 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin)['result']['block_id']['hash'])" 2>/dev/null || echo "")

        if [ -n "$TRUST_HASH" ] && [ ${#TRUST_HASH} -eq 64 ]; then
            sed -i.bak "s|^enable = false|enable = true|" "$CONFIG"
            sed -i.bak "s|^rpc_servers = .*|rpc_servers = \"${SEED_IP}:26657,${SEED_IP}:26657\"|" "$CONFIG"
            sed -i.bak "s|^trust_height = .*|trust_height = ${TRUST_HEIGHT}|" "$CONFIG"
            sed -i.bak "s|^trust_hash = .*|trust_hash = \"${TRUST_HASH}\"|" "$CONFIG"
            sed -i.bak 's|^trust_period = .*|trust_period = "168h0m0s"|' "$CONFIG"
            sed -i.bak 's|^discovery_time = .*|discovery_time = "30s"|' "$CONFIG"
            log "State sync enabled: trust_height=${TRUST_HEIGHT}, hash=${TRUST_HASH:0:16}..."
            log "Expected sync time: under 2 minutes."
        else
            log "WARNING: Could not get trust hash. Will sync from genesis (slower)."
        fi
    else
        log "WARNING: Seed RPC unreachable or chain too short. Will sync from genesis."
    fi

    # P2P listen on all interfaces
    sed -i.bak 's|^laddr = "tcp://0.0.0.0:26656"|laddr = "tcp://0.0.0.0:26656"|' "$CONFIG"

    # Clean up sed backup files
    rm -f "$CONFIG.bak"

    log "CometBFT configured."
}

# ── Step 10: Setup Cosmovisor directory ──────────────────────────────

setup_cosmovisor() {
    log "Setting up Cosmovisor directory structure..."

    local CMT_BIN="$HOME/go/bin/cometbft"

    mkdir -p "$CMT_HOME/cosmovisor/genesis/bin"
    mkdir -p "$CMT_HOME/cosmovisor/upgrades"
    mkdir -p "$CMT_HOME/backups"

    # Only copy if not already there or not currently in use
    if [ ! -f "$CMT_HOME/cosmovisor/genesis/bin/cometbft" ]; then
        cp "$CMT_BIN" "$CMT_HOME/cosmovisor/genesis/bin/cometbft"
    fi

    log "Cosmovisor ready."
}

# ── Step 11: Generate or import identity ─────────────────────────────

setup_identity() {
    if [ -n "$SEED_ARG" ]; then
        log "Importing identity from provided seed..."
        cd "$ENSOUL_DIR"
        npx tsx packages/node/src/cli/main.ts --import-seed "$SEED_ARG" --data-dir "$DATA_DIR" 2>&1 | tail -5
    else
        log "Deriving Ensoul identity from CometBFT validator key..."

        if [ ! -f "$CMT_HOME/config/priv_validator_key.json" ]; then
            log "WARNING: No CometBFT validator key found. Cannot create identity."
            return
        fi

        # Extract the Ed25519 seed (first 32 bytes of the 64-byte private key)
        local seed_hex
        seed_hex=$(python3 -c "
import json, base64
d = json.load(open('$CMT_HOME/config/priv_validator_key.json'))
raw = base64.b64decode(d['priv_key']['value'])
print(raw[:32].hex())
" 2>/dev/null || echo "")

        if [ -z "$seed_hex" ]; then
            log "WARNING: Could not extract seed from validator key."
            return
        fi

        # Derive the DID from the public key
        local pubkey_b64
        pubkey_b64=$(python3 -c "
import json
d = json.load(open('$CMT_HOME/config/priv_validator_key.json'))
print(d['pub_key']['value'])
" 2>/dev/null || echo "")

        local pubkey_hex
        pubkey_hex=$(echo "$pubkey_b64" | base64 -d 2>/dev/null | xxd -p -c 64 2>/dev/null || echo "")

        local did=""
        if [ -n "$pubkey_hex" ]; then
            did=$(curl -s -m 5 "$API_URL/v1/verify-did?publicKey=$pubkey_hex" 2>/dev/null | \
                python3 -c "import sys,json; print(json.load(sys.stdin)['did'])" 2>/dev/null || echo "")
        fi

        # If API lookup fails, derive DID locally using multicodec ed25519 prefix
        if [ -z "$did" ] && [ -n "$pubkey_hex" ]; then
            did=$(python3 -c "
import base64, hashlib
pubkey = bytes.fromhex('$pubkey_hex')
# multicodec ed25519-pub prefix (0xed01) + raw pubkey
mc = b'\\xed\\x01' + pubkey
# base58btc encode with z prefix
import struct
alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
num = int.from_bytes(mc, 'big')
result = ''
while num > 0:
    num, rem = divmod(num, 58)
    result = alphabet[rem] + result
for byte in mc:
    if byte == 0:
        result = '1' + result
    else:
        break
print(f'did:key:z{result}')
" 2>/dev/null || echo "")
        fi

        if [ -z "$did" ]; then
            log "WARNING: Could not derive DID. Identity file not created."
            return
        fi

        # Save identity file
        mkdir -p "$DATA_DIR"
        python3 -c "
import json
identity = {'seed': '$seed_hex', 'did': '$did'}
with open('$DATA_DIR/identity.json', 'w') as f:
    json.dump(identity, f, indent=2)
" 2>/dev/null

        chmod 600 "$DATA_DIR/identity.json"
        log "Identity created: $did"
        log "Saved to $DATA_DIR/identity.json"
    fi
}

# ── Step 12: Copy process manager ────────────────────────────────────

setup_process_manager() {
    log "Setting up process manager..."

    # Ensure the process manager is executable
    chmod +x "$ENSOUL_DIR/scripts/process-manager.sh"

    # Copy safe-cometbft wrapper
    chmod +x "$ENSOUL_DIR/scripts/safe-cometbft.sh"

    log "Process manager ready at $ENSOUL_DIR/scripts/process-manager.sh"
}

# ── Step 13: Install service (systemd or launchd) ────────────────────

install_service() {
    if [ "$OS" = "ubuntu" ]; then
        install_systemd_services
    elif [ "$OS" = "macos" ]; then
        install_launchd_services
    fi
}

install_systemd_services() {
    log "Installing systemd services..."

    local NVM_DIR_RESOLVED="${NVM_DIR:-$HOME/.nvm}"
    local NODE_BIN
    NODE_BIN=$(which node 2>/dev/null || echo "$NVM_DIR_RESOLVED/versions/node/$(ls "$NVM_DIR_RESOLVED/versions/node/" 2>/dev/null | tail -1)/bin/node")
    local NODE_BIN_DIR
    NODE_BIN_DIR=$(dirname "$NODE_BIN")

    local USER_NAME
    USER_NAME=$(whoami)

    # ABCI server service (with auto-upgrade support)
    sudo tee /etc/systemd/system/ensoul-abci.service > /dev/null << ABCI_EOF
[Unit]
Description=Ensoul ABCI Server
After=network.target

[Service]
TimeoutStopSec=30
KillMode=mixed
Type=simple
User=$USER_NAME
WorkingDirectory=$ENSOUL_DIR
Environment=PATH=$NODE_BIN_DIR:/usr/local/go/bin:$HOME/go/bin:/usr/local/bin:/usr/bin:/bin
Environment=HOME=$HOME
Environment=NVM_DIR=$NVM_DIR_RESOLVED
Environment=ENSOUL_REPO=$ENSOUL_DIR
Environment=DAEMON_HOME=$CMT_HOME
ExecStart=$NODE_BIN_DIR/npx tsx packages/abci-server/src/index.ts --port 26658
ExecStopPost=$ENSOUL_DIR/scripts/auto-upgrade.sh
Restart=always
RestartSec=5
StandardOutput=append:$DATA_DIR/abci-server.log
StandardError=append:$DATA_DIR/abci-server.log

[Install]
WantedBy=multi-user.target
ABCI_EOF

    # CometBFT via Cosmovisor service
    sudo tee /etc/systemd/system/ensoul-cometbft.service > /dev/null << CMT_EOF
[Unit]
Description=Ensoul CometBFT (via Cosmovisor)
After=ensoul-abci.service
Requires=ensoul-abci.service

[Service]
Type=simple
User=$USER_NAME
Environment=DAEMON_NAME=cometbft
Environment=DAEMON_HOME=$CMT_HOME
Environment=DAEMON_DATA_BACKUP_DIR=$CMT_HOME/backups
Environment=DAEMON_ALLOW_DOWNLOAD_BINARIES=false
Environment=DAEMON_RESTART_AFTER_UPGRADE=true
Environment=PATH=/usr/local/go/bin:$HOME/go/bin:/usr/local/bin:/usr/bin:/bin
Environment=HOME=$HOME
ExecStart=$HOME/go/bin/cosmovisor run start --proxy_app=tcp://127.0.0.1:26658 --home $CMT_HOME
Restart=always
RestartSec=5
StandardOutput=append:$DATA_DIR/cometbft.log
StandardError=append:$DATA_DIR/cometbft.log

[Install]
WantedBy=multi-user.target
CMT_EOF

    # Compat proxy service
    sudo tee /etc/systemd/system/ensoul-proxy.service > /dev/null << PROXY_EOF
[Unit]
Description=Ensoul Compat Proxy
After=ensoul-cometbft.service
Requires=ensoul-cometbft.service

[Service]
Type=simple
User=$USER_NAME
WorkingDirectory=$ENSOUL_DIR
Environment=PATH=$NODE_BIN_DIR:/usr/local/go/bin:$HOME/go/bin:/usr/local/bin:/usr/bin:/bin
Environment=HOME=$HOME
Environment=NVM_DIR=$NVM_DIR_RESOLVED
ExecStart=$NODE_BIN_DIR/npx tsx packages/abci-server/src/compat-proxy.ts --port 9000
Restart=always
RestartSec=5
StandardOutput=append:$DATA_DIR/compat-proxy.log
StandardError=append:$DATA_DIR/compat-proxy.log

[Install]
WantedBy=multi-user.target
PROXY_EOF

    # API gateway service
    sudo tee /etc/systemd/system/ensoul-api.service > /dev/null << API_EOF
[Unit]
Description=Ensoul API Gateway
After=ensoul-cometbft.service
Requires=ensoul-cometbft.service

[Service]
Type=simple
User=$USER_NAME
WorkingDirectory=$ENSOUL_DIR
Environment=PATH=$NODE_BIN_DIR:/usr/local/go/bin:$HOME/go/bin:/usr/local/bin:/usr/bin:/bin
Environment=HOME=$HOME
Environment=NVM_DIR=$NVM_DIR_RESOLVED
ExecStart=$NODE_BIN_DIR/npx tsx packages/api/start.ts --port 5050
Restart=always
RestartSec=5
StandardOutput=append:$DATA_DIR/api.log
StandardError=append:$DATA_DIR/api.log

[Install]
WantedBy=multi-user.target
API_EOF

    # Process manager timer (health check every 30s)
    sudo tee /etc/systemd/system/ensoul-watchdog.service > /dev/null << WD_EOF
[Unit]
Description=Ensoul Process Manager Health Check

[Service]
Type=oneshot
User=$USER_NAME
Environment=PATH=$NODE_BIN_DIR:/usr/local/go/bin:$HOME/go/bin:/usr/local/bin:/usr/bin:/bin
Environment=HOME=$HOME
Environment=NVM_DIR=$NVM_DIR_RESOLVED
ExecStart=$ENSOUL_DIR/scripts/process-manager.sh
WD_EOF

    sudo tee /etc/systemd/system/ensoul-watchdog.timer > /dev/null << TIMER_EOF
[Unit]
Description=Ensoul Process Manager Timer

[Timer]
OnBootSec=60
OnUnitActiveSec=30

[Install]
WantedBy=timers.target
TIMER_EOF

    sudo systemctl daemon-reload
    sudo systemctl enable ensoul-abci ensoul-cometbft ensoul-proxy ensoul-api ensoul-watchdog.timer

    log "Systemd services installed and enabled."
}

install_launchd_services() {
    log "Installing launchd services..."

    local LAUNCH_DIR="$HOME/Library/LaunchAgents"
    mkdir -p "$LAUNCH_DIR"

    local NVM_DIR_RESOLVED="${NVM_DIR:-$HOME/.nvm}"
    local NODE_BIN
    NODE_BIN=$(which node 2>/dev/null)
    local NODE_BIN_DIR
    NODE_BIN_DIR=$(dirname "$NODE_BIN")
    local PATH_VAL="$NODE_BIN_DIR:$HOME/go/bin:/usr/local/go/bin:/usr/local/bin:/usr/bin:/bin"

    # Process manager (runs every 30 seconds)
    cat > "$LAUNCH_DIR/dev.ensoul.process-manager.plist" << PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>dev.ensoul.process-manager</string>
    <key>ProgramArguments</key>
    <array>
        <string>$ENSOUL_DIR/scripts/process-manager.sh</string>
    </array>
    <key>StartInterval</key>
    <integer>30</integer>
    <key>RunAtLoad</key>
    <true/>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>$PATH_VAL</string>
        <key>HOME</key>
        <string>$HOME</string>
        <key>NVM_DIR</key>
        <string>$NVM_DIR_RESOLVED</string>
    </dict>
    <key>StandardOutPath</key>
    <string>$DATA_DIR/process-manager-launchd.log</string>
    <key>StandardErrorPath</key>
    <string>$DATA_DIR/process-manager-launchd.log</string>
</dict>
</plist>
PLIST_EOF

    log "LaunchD service installed."
}

# ── Step 14: Start services ─────────────────────────────────────────

start_services() {
    if [ "$SKIP_START" = "true" ]; then
        log "Skipping service start (--skip-start flag)."
        return
    fi

    log "Starting Ensoul services..."

    if [ "$OS" = "ubuntu" ]; then
        sudo systemctl start ensoul-abci
        log "Waiting for ABCI to start on port 26658..."
        local abci_ready=false
        for i in $(seq 1 15); do
            if nc -z 127.0.0.1 26658 2>/dev/null; then
                abci_ready=true
                log "ABCI ready after $((i * 2))s."
                break
            fi
            sleep 2
        done

        if [ "$abci_ready" = "false" ]; then
            log "WARNING: ABCI did not start on port 26658 after 30s. Check $DATA_DIR/abci-server.log"
        fi

        sudo systemctl start ensoul-cometbft
        log "Waiting for CometBFT to sync..."
        sleep 8

        sudo systemctl start ensoul-proxy
        sudo systemctl start ensoul-api
        sudo systemctl start ensoul-watchdog.timer

    elif [ "$OS" = "macos" ]; then
        # Start processes directly (process manager will keep them alive)
        cd "$ENSOUL_DIR"

        log "Starting ABCI server..."
        nohup bash -l -c "cd $ENSOUL_DIR && npx tsx packages/abci-server/src/index.ts --port 26658" >> "$DATA_DIR/abci-server.log" 2>&1 &
        log "Waiting for ABCI to start on port 26658..."
        local abci_ready_mac=false
        for i in $(seq 1 15); do
            if nc -z 127.0.0.1 26658 2>/dev/null; then
                abci_ready_mac=true
                log "ABCI ready after $((i * 2))s."
                break
            fi
            sleep 2
        done
        if [ "$abci_ready_mac" = "false" ]; then
            log "WARNING: ABCI did not start on port 26658 after 30s. Check $DATA_DIR/abci-server.log"
        fi

        log "Starting CometBFT via Cosmovisor..."
        export DAEMON_NAME=cometbft
        export DAEMON_HOME="$CMT_HOME"
        export DAEMON_DATA_BACKUP_DIR="$CMT_HOME/backups"
        export DAEMON_ALLOW_DOWNLOAD_BINARIES=false
        export DAEMON_RESTART_AFTER_UPGRADE=true

        nohup "$HOME/go/bin/cosmovisor" run start \
            --proxy_app=tcp://127.0.0.1:26658 \
            --home "$CMT_HOME" \
            >> "$DATA_DIR/cometbft.log" 2>&1 &
        sleep 8

        log "Starting compat proxy..."
        nohup bash -l -c "cd $ENSOUL_DIR && npx tsx packages/abci-server/src/compat-proxy.ts --port 9000" >> "$DATA_DIR/compat-proxy.log" 2>&1 &

        log "Starting API gateway..."
        nohup bash -l -c "cd $ENSOUL_DIR && npx tsx packages/api/start.ts --port 5050" >> "$DATA_DIR/api.log" 2>&1 &

        # Load the process manager launchd service
        launchctl load "$HOME/Library/LaunchAgents/dev.ensoul.process-manager.plist" 2>/dev/null || true
    fi

    log "Services started."
}

# ── Step 15: Wait for sync and get node info ────────────────────────

wait_and_report() {
    log "Waiting for CometBFT to connect to peers..."

    local attempt=0
    local max_attempts=30
    local synced=false

    while [ "$attempt" -lt "$max_attempts" ]; do
        local status_json
        status_json=$(curl -s -m 3 http://localhost:26657/status 2>/dev/null || echo "")
        if [ -n "$status_json" ]; then
            local height
            height=$(echo "$status_json" | python3 -c "import sys,json; print(json.load(sys.stdin)['result']['sync_info']['latest_block_height'])" 2>/dev/null || echo "0")
            if [ "$height" != "0" ] && [ "$height" != "" ]; then
                synced=true
                break
            fi
        fi
        attempt=$((attempt + 1))
        sleep 5
    done

    if [ "$synced" = "false" ]; then
        log "WARNING: CometBFT did not connect within 150 seconds. It may still be syncing."
        log "Check status with: curl -s http://localhost:26657/status"
    fi

    # Extract validator information
    local node_id=""
    local val_address=""
    local val_pubkey=""
    local latest_height="0"
    local catching_up="true"
    local n_peers="0"

    local status_json
    status_json=$(curl -s -m 5 http://localhost:26657/status 2>/dev/null || echo "")
    if [ -n "$status_json" ]; then
        node_id=$(echo "$status_json" | python3 -c "import sys,json; print(json.load(sys.stdin)['result']['node_info']['id'])" 2>/dev/null || echo "unknown")
        val_address=$(echo "$status_json" | python3 -c "import sys,json; print(json.load(sys.stdin)['result']['validator_info']['address'])" 2>/dev/null || echo "unknown")
        val_pubkey=$(echo "$status_json" | python3 -c "import sys,json; print(json.load(sys.stdin)['result']['validator_info']['pub_key']['value'])" 2>/dev/null || echo "unknown")
        latest_height=$(echo "$status_json" | python3 -c "import sys,json; print(json.load(sys.stdin)['result']['sync_info']['latest_block_height'])" 2>/dev/null || echo "0")
        catching_up=$(echo "$status_json" | python3 -c "import sys,json; print(json.load(sys.stdin)['result']['sync_info']['catching_up'])" 2>/dev/null || echo "True")
    fi

    local net_json
    net_json=$(curl -s -m 3 http://localhost:26657/net_info 2>/dev/null || echo "")
    if [ -n "$net_json" ]; then
        n_peers=$(echo "$net_json" | python3 -c "import sys,json; print(json.load(sys.stdin)['result']['n_peers'])" 2>/dev/null || echo "0")
    fi

    # Derive DID from CometBFT validator pubkey
    local did=""
    local pubkey_hex=""
    if [ -n "$val_pubkey" ] && [ "$val_pubkey" != "unknown" ]; then
        pubkey_hex=$(echo "$val_pubkey" | base64 -d 2>/dev/null | xxd -p -c 64 2>/dev/null || echo "")
        if [ -n "$pubkey_hex" ]; then
            did=$(curl -s -m 5 "$API_URL/v1/verify-did?publicKey=$pubkey_hex" 2>/dev/null | \
                python3 -c "import sys,json; print(json.load(sys.stdin)['did'])" 2>/dev/null || echo "")
        fi
    fi

    # Auto-register the validator
    local reg_status="not registered"
    if [ -n "$did" ] && [ -n "$pubkey_hex" ]; then
        local reg_resp
        reg_resp=$(curl -s -m 10 -X POST "$API_URL/v1/validators/register" \
            -H "Content-Type: application/json" \
            -d "{\"did\":\"$did\",\"publicKey\":\"$pubkey_hex\",\"name\":\"$MONIKER\"}" 2>/dev/null || echo "")
        local reg_ok
        reg_ok=$(echo "$reg_resp" | python3 -c "import sys,json; print(json.load(sys.stdin).get('registered', False))" 2>/dev/null || echo "False")
        if [ "$reg_ok" = "True" ]; then
            reg_status="registered"
            log "Validator registered: $did"
        else
            reg_status="registration failed (register manually)"
            log "Auto-registration failed. Register manually after sync completes."
        fi
    else
        log "Could not derive DID. Register manually after sync completes."
    fi

    # ── Auto-submit consensus_join ──────────────────────────────────
    # The validator must be in the consensus set to sign blocks and
    # receive delegations. consensus_join requires stakedBalance > 0,
    # which all genesis validators have. New Pioneer validators will
    # need to stake a small amount first (sent from the onboarding fund
    # during approval) before this step succeeds.

    # Extract the private key seed from CometBFT's priv_validator_key.json
    local identity_seed=""
    if [ -f "$CMT_HOME/config/priv_validator_key.json" ]; then
        identity_seed=$(python3 -c "
import json, base64
d = json.load(open('$CMT_HOME/config/priv_validator_key.json'))
raw = base64.b64decode(d['priv_key']['value'])
print(raw[:32].hex())
" 2>/dev/null || echo "")
    fi

    local join_status="not submitted"
    if [ "$reg_status" = "registered" ] && [ -n "$did" ] && [ -n "$identity_seed" ]; then
        # Check if already in consensus set
        local in_consensus
        in_consensus=$(curl -s -m 5 "$API_URL/v1/validators" 2>/dev/null | \
            python3 -c "import sys,json; vals=json.load(sys.stdin).get('validators',[]); print('yes' if any(v.get('did','')=='$did' for v in vals) else 'no')" 2>/dev/null || echo "unknown")

        if [ "$in_consensus" = "yes" ]; then
            join_status="already in consensus set"
            log "Validator already in consensus set"
        elif [ "$in_consensus" = "no" ]; then
            # Submit consensus_join via the API broadcast endpoint
            local nonce
            nonce=$(curl -s -m 5 "$API_URL/v1/account/$did" 2>/dev/null | \
                python3 -c "import sys,json; print(json.load(sys.stdin).get('nonce',0))" 2>/dev/null || echo "0")

            local join_resp
            join_resp=$(cd "$ENSOUL_DIR" && npx tsx -e "
const { createPrivateKey, sign } = require('node:crypto');
const seed = Buffer.from('$identity_seed', 'hex');
const privKey = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420','hex'), seed]), format: 'der', type: 'pkcs8' });
const ts = Date.now();
const txData = { type: 'consensus_join', from: '$did', to: '$did', amount: '0', nonce: $nonce, timestamp: ts };
const payload = JSON.stringify(txData);
const sig = sign(null, Buffer.from(payload), privKey);
const tx = { ...txData, signature: Array.from(sig) };
const txBytes = Buffer.from(JSON.stringify(tx)).toString('base64');
fetch('http://localhost:26657', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'cj', method: 'broadcast_tx_commit', params: { tx: txBytes } }),
    signal: AbortSignal.timeout(15000),
}).then(r => r.json()).then(d => {
    const r = d.result || {};
    console.log(JSON.stringify({ code: r.tx_result?.code, height: r.height }));
}).catch(e => console.log(JSON.stringify({ error: e.message })));
" 2>/dev/null || echo '{"error":"script failed"}')

            local join_code
            join_code=$(echo "$join_resp" | python3 -c "import sys,json; print(json.load(sys.stdin).get('code','?'))" 2>/dev/null || echo "?")

            if [ "$join_code" = "0" ]; then
                join_status="joined consensus set"
                log "consensus_join submitted successfully"
            else
                join_status="consensus_join pending (needs self-stake first)"
                log "consensus_join not yet possible. Validator needs stakedBalance > 0."
                log "For Pioneer validators: stake will be provided during approval."
            fi
        fi
    fi

    # ── Print Summary ────────────────────────────────────────────────

    echo ""
    echo "================================================================"
    echo "  ENSOUL VALIDATOR INSTALLED SUCCESSFULLY"
    echo "================================================================"
    echo ""
    echo "  Moniker:           $MONIKER"
    echo "  Chain ID:          $CHAIN_ID"
    echo "  DID:               ${did:-unknown (derive after sync)}"
    echo "  Registration:      $reg_status"
    echo "  Consensus Set:     $join_status"
    echo "  CometBFT Address:  $val_address"
    echo "  Public Key (hex):  ${pubkey_hex:-unknown}"
    echo "  Node ID:           $node_id"
    echo "  Current Height:    $latest_height"
    echo "  Catching Up:       $catching_up"
    echo "  Peers:             $n_peers"
    echo ""
    echo "  Ports:"
    echo "    26656  P2P (must be reachable from internet)"
    echo "    26657  CometBFT RPC (localhost only)"
    echo "    26658  ABCI server (localhost only)"
    echo ""
    echo "  Logs:"
    echo "    ABCI:      $DATA_DIR/abci-server.log"
    echo "    CometBFT:  $DATA_DIR/cometbft.log"
    echo ""
    echo "  Keys:"
    echo "    Validator key:  $CMT_HOME/config/priv_validator_key.json"
    echo "    Node key:       $CMT_HOME/config/node_key.json"
    echo "    Identity:       $DATA_DIR/identity.json"
    echo ""
    if [ -n "$identity_seed" ]; then
        echo "  ╔══════════════════════════════════════════════════════════════╗"
        echo "  ║  YOUR SEED (save this, it cannot be recovered):              ║"
        echo "  ║  $identity_seed  ║"
        echo "  ╚══════════════════════════════════════════════════════════════╝"
        echo ""
    fi

    # Re-detect public IP for the backup commands. Falls back to a placeholder.
    local backup_ip
    backup_ip=$(curl -4 -s -m 5 https://ifconfig.me 2>/dev/null || curl -4 -s -m 5 https://api.ipify.org 2>/dev/null || echo "YOUR_SERVER_IP")
    [ -z "$backup_ip" ] && backup_ip="YOUR_SERVER_IP"

    echo "  ╔══════════════════════════════════════════════════════════════╗"
    echo "  ║  CRITICAL: BACK UP THESE FILES TO YOUR LOCAL MACHINE         ║"
    echo "  ║                                                              ║"
    echo "  ║  These files ARE your validator. If this server is lost      ║"
    echo "  ║  and you don't have backups, your validator identity,        ║"
    echo "  ║  your stake, and your Pioneer status are gone forever.       ║"
    echo "  ║                                                              ║"
    echo "  ║  From YOUR computer (not this server), run:                  ║"
    echo "  ╚══════════════════════════════════════════════════════════════╝"
    echo ""
    echo "    scp root@${backup_ip}:${CMT_HOME}/config/priv_validator_key.json ./"
    echo "    scp root@${backup_ip}:${DATA_DIR}/identity.json ./"
    echo "    scp root@${backup_ip}:${CMT_HOME}/config/node_key.json ./"
    echo ""
    echo "  Store these files + your seed offline. USB drive, password"
    echo "  manager, encrypted backup. Never share them with anyone."
    echo ""
    echo "  What each file is:"
    echo "    priv_validator_key.json  CometBFT signing key. Makes blocks."
    echo "    node_key.json            P2P network identity. Other validators find you with this."
    echo "    identity.json            Ensoul DID keypair. Your on-chain identity."
    echo "    Seed (above)             Master key. Everything above can be regenerated from this."
    echo ""
    echo "  Full backup guide: https://ensoul.dev/docs/validator.html#key-backup"
    echo ""
    echo "  Wallet:  Import your seed into ensoul.dev/wallet.html to"
    echo "           manage your stake and rewards."
    echo ""
    echo "  CLI:     ensoul-node wallet balance"
    echo "           ensoul-node wallet stake <amount>"
    echo "           ensoul-node wallet consensus-join"
    echo ""
    echo "  Automatic upgrades: enabled."
    echo "    Your validator will update itself when protocol upgrades"
    echo "    are released. No manual intervention required."
    echo ""

    # Auto-apply for Pioneer if --pioneer flag was passed
    if [ -n "$did" ]; then
        apply_for_pioneer "$did"
    fi

    if [ "$reg_status" = "registered" ]; then
        echo "  Your validator is registered and syncing."
        echo "  Sync takes 5-15 minutes depending on your connection."
        echo ""
        echo "  Check sync progress:"
        echo "    curl -s localhost:26657/status | python3 -c \\"
        echo "      \"import sys,json; d=json.load(sys.stdin)['result']['sync_info']; print(f'Height: {d[\\\"latest_block_height\\\"]}, Catching up: {d[\\\"catching_up\\\"]}')\""
        echo ""
        if [ "$PIONEER_MODE" = "true" ]; then
            echo "  Pioneer application submitted. Check status anytime:"
            echo "    curl -s https://api.ensoul.dev/v1/pioneers/status?did=$did"
            echo ""
            echo "  You will be contacted when approved. After approval:"
            echo "    ensoul-node wallet stake 100"
            echo "    ensoul-node wallet consensus-join"
            echo ""
            echo "  BOOKMARK THIS — your Pioneer portal (identity, stake, rewards, health, key backup):"
            echo "    ensoul.dev/pioneer.html?did=$did"
        else
            echo "  Apply for Pioneer delegation (1M ENSL):"
            echo "    Visit: ensoul.dev/apply?did=$did"
            echo "    Or use the API:"
            echo "      curl -s -X POST https://api.ensoul.dev/v1/pioneers/apply \\"
            echo "        -H 'Content-Type: application/json' \\"
            echo "        -d '{\"did\":\"$did\",\"name\":\"$MONIKER\",\"contact\":\"email, Discord, Telegram, or any contact method\"}'"
            echo ""
            echo "  Check application status anytime:"
            echo "    curl -s https://api.ensoul.dev/v1/pioneers/status?did=$did"
            echo ""
            echo "  BOOKMARK THIS — your Pioneer portal (one page for everything):"
            echo "    ensoul.dev/pioneer.html?did=$did"
        fi
    else
        echo "  Next Steps:"
        echo "    1. Wait for sync to complete (catching_up: false)"
        echo "       Sync takes 5-15 minutes depending on your connection."
        echo "    2. Register manually:"
        echo "       curl -X POST https://api.ensoul.dev/v1/validators/register \\"
        echo "         -H 'Content-Type: application/json' \\"
        echo "         -d '{\"did\":\"${did:-YOUR_DID}\",\"publicKey\":\"${pubkey_hex:-YOUR_PUBKEY_HEX}\",\"name\":\"$MONIKER\"}'"
    fi
    echo ""

    # Check if the node has a public IP set
    local public_ip_check
    public_ip_check=$(curl -4 -s -m 5 https://ifconfig.me 2>/dev/null || echo "")
    if [ -z "$public_ip_check" ] 2>/dev/null; then
        echo "  WARNING: No public IP detected."
        echo "    Option A: Forward port 26656 on your router to this machine."
        echo "    Option B: Use Tailscale (https://tailscale.com) and share your"
        echo "              Tailscale IP with other validators for peering."
        echo ""
    fi

    if [ "$catching_up" = "True" ] || [ "$catching_up" = "true" ]; then
        echo "  Your node is still syncing. This may take a few hours depending"
        echo "  on how far behind the chain tip you are. The validator will begin"
        echo "  signing blocks automatically once sync completes and you have"
        echo "  enough stake."
        echo ""
    fi

    echo "================================================================"
    echo ""
}

# ── Step 16: Register validator (optional) ──────────────────────────

register_validator() {
    # Register this node with the API peer registry for auto-discovery
    log "Registering with network peer registry..."
    local node_id
    node_id=$(curl -s -m 5 http://localhost:26657/status 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin)['result']['node_info']['id'])" 2>/dev/null || echo "")

    local public_ip
    public_ip=$(curl -4 -s -m 5 https://ifconfig.me 2>/dev/null || echo "")

    if [ -n "$node_id" ] && [ -n "$public_ip" ]; then
        curl -s -X POST "$API_URL/v1/network/register-peer" \
            -H "Content-Type: application/json" \
            -d "{\"node_id\":\"$node_id\",\"public_ip\":\"$public_ip\",\"moniker\":\"$MONIKER\",\"rpc_port\":26657}" \
            > /dev/null 2>&1 || true
        log "Registered as peer: $node_id @ $public_ip"
    else
        log "Could not register with peer registry (node not ready or no public IP)"
    fi
}

# ── Create ensoul-node CLI wrapper ────────────────────────────────────

install_cli_wrapper() {
    log "Installing ensoul-node CLI wrapper..."

    local wrapper_content="#!/usr/bin/env bash
# ensoul-node: CLI wrapper for Ensoul validator operations.
# Created by the Ensoul validator installer.
cd \"$ENSOUL_DIR\" && exec npx tsx packages/node/src/cli/main.ts \"\$@\"
"

    if [ "$OS" = "ubuntu" ]; then
        echo "$wrapper_content" | sudo tee /usr/local/bin/ensoul-node > /dev/null
        sudo chmod +x /usr/local/bin/ensoul-node
        log "Installed ensoul-node to /usr/local/bin/ensoul-node"
    else
        # macOS: use ~/bin (avoid sudo for Homebrew users)
        mkdir -p "$HOME/bin"
        echo "$wrapper_content" > "$HOME/bin/ensoul-node"
        chmod +x "$HOME/bin/ensoul-node"
        # Add to PATH if not already present
        if ! echo "$PATH" | grep -q "$HOME/bin"; then
            local shell_rc="$HOME/.zprofile"
            [ -f "$HOME/.bash_profile" ] && shell_rc="$HOME/.bash_profile"
            echo 'export PATH="$HOME/bin:$PATH"' >> "$shell_rc"
            export PATH="$HOME/bin:$PATH"
        fi
        log "Installed ensoul-node to ~/bin/ensoul-node"
    fi
}

# ── Auto-apply for Pioneer program ───────────────────────────────────

apply_for_pioneer() {
    local did="$1"

    if [ "$PIONEER_MODE" != "true" ]; then
        return
    fi

    if [ -z "$did" ]; then
        log "Cannot auto-apply for Pioneer: DID not available."
        return
    fi

    local contact="$PIONEER_CONTACT"
    if [ -z "$contact" ]; then
        contact="not provided (update via ensoul.dev/apply)"
    fi

    # Detect public IP so the admin dashboard can show where the validator runs.
    local apply_ip
    apply_ip=$(curl -4 -s -m 5 https://ifconfig.me 2>/dev/null || curl -4 -s -m 5 https://api.ipify.org 2>/dev/null || echo "")

    log "Submitting Pioneer validator application..."
    local apply_resp
    apply_resp=$(curl -s -m 10 -X POST "$API_URL/v1/pioneers/apply" \
        -H "Content-Type: application/json" \
        -d "{\"did\":\"$did\",\"name\":\"$MONIKER\",\"contact\":\"$contact\",\"ip\":\"$apply_ip\"}" 2>/dev/null || echo "")

    local applied
    applied=$(echo "$apply_resp" | python3 -c "import sys,json; print(json.load(sys.stdin).get('applied', False))" 2>/dev/null || echo "False")

    if [ "$applied" = "True" ]; then
        log "Pioneer application submitted successfully."
    else
        log "Pioneer application submission failed. Apply manually."
    fi
}

# ── Main ─────────────────────────────────────────────────────────────

# ── Install Heartbeat Client service ──────────────────────────────────

install_heartbeat_client() {
    if [ "$OS" != "ubuntu" ]; then
        log "Heartbeat client: skipping (Linux systemd only)."
        return
    fi

    log "Installing heartbeat client service..."

    local NVM_DIR_RESOLVED="${NVM_DIR:-$HOME/.nvm}"
    local NODE_BIN
    NODE_BIN=$(which node 2>/dev/null || echo "$NVM_DIR_RESOLVED/versions/node/$(ls "$NVM_DIR_RESOLVED/versions/node/" 2>/dev/null | tail -1)/bin/node")
    local NODE_BIN_DIR
    NODE_BIN_DIR=$(dirname "$NODE_BIN")
    local USER_NAME
    USER_NAME=$(whoami)

    mkdir -p "$DATA_DIR"

    sudo tee /etc/systemd/system/ensoul-heartbeat.service > /dev/null << HB_EOF
[Unit]
Description=Ensoul Heartbeat Client
After=ensoul-cometbft.service
Wants=ensoul-cometbft.service

[Service]
Type=simple
User=$USER_NAME
WorkingDirectory=$ENSOUL_DIR
Environment=PATH=$NODE_BIN_DIR:/usr/local/go/bin:$HOME/go/bin:/usr/local/bin:/usr/bin:/bin
Environment=HOME=$HOME
ExecStart=$NODE_BIN_DIR/npx tsx packages/heartbeat-client/src/start.ts
Restart=always
RestartSec=10
StandardOutput=append:$DATA_DIR/heartbeat.log
StandardError=append:$DATA_DIR/heartbeat.log

[Install]
WantedBy=multi-user.target
HB_EOF

    sudo systemctl daemon-reload
    sudo systemctl enable ensoul-heartbeat
    sudo systemctl start ensoul-heartbeat 2>/dev/null || true

    log "Heartbeat client installed and started."
}

# ── Main ─────────────────────────────────────────────────────

main() {
    echo ""
    echo "  Ensoul Validator Installer"
    echo "  Chain: $CHAIN_ID"
    echo ""

    detect_os
    install_system_deps
    install_go
    install_node
    install_pnpm
    install_cometbft
    install_cosmovisor
    clone_and_build
    init_cometbft
    configure_cometbft
    setup_cosmovisor
    setup_identity
    setup_process_manager
    install_service
    install_cli_wrapper
    install_heartbeat_client
    start_services
    register_validator
    wait_and_report

    log "Installation complete."
}

main
