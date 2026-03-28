#!/usr/bin/env bash
#
# install-validator.sh
#
# One-command Ensoul validator installer. Works on Ubuntu/Debian 22.04+ and macOS.
# Sets up Go, Node.js, pnpm, CometBFT 0.38.x, Cosmovisor, clones the repo,
# builds, generates validator keys, downloads genesis, configures networking,
# and starts everything with a systemd (Linux) or launchd (macOS) service.
#
# Usage:
#   curl -sL https://raw.githubusercontent.com/suitandclaw/ensoul/main/scripts/install-validator.sh | bash
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
SEED_NODE="402a9f5c503c36d0dca5f1a8b7a3a2263efd039a@178.156.199.91:26656"
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
SKIP_START=false

# ── Parse arguments ──────────────────────────────────────────────────

while [ $# -gt 0 ]; do
    case "$1" in
        --moniker)  MONIKER="$2"; shift 2 ;;
        --seed)     SEED_ARG="$2"; shift 2 ;;
        --pioneer)  PIONEER_MODE=true; shift ;;
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
    SEED_IP=$(echo "$SEED_NODE" | sed 's/.*@//' | sed 's/:.*//')

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
        log "Identity will be derived from CometBFT validator key."
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

    # ABCI server service
    sudo tee /etc/systemd/system/ensoul-abci.service > /dev/null << ABCI_EOF
[Unit]
Description=Ensoul ABCI Server
After=network.target

[Service]
Type=simple
User=$USER_NAME
WorkingDirectory=$ENSOUL_DIR
Environment=PATH=$NODE_BIN_DIR:/usr/local/go/bin:$HOME/go/bin:/usr/local/bin:/usr/bin:/bin
Environment=HOME=$HOME
Environment=NVM_DIR=$NVM_DIR_RESOLVED
ExecStart=$NODE_BIN_DIR/npx tsx packages/abci-server/src/index.ts --port 26658
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
        log "Waiting for ABCI to start..."
        sleep 5

        if ! nc -z 127.0.0.1 26658 2>/dev/null; then
            log "WARNING: ABCI did not start on port 26658. Check $DATA_DIR/abci-server.log"
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
        sleep 5

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

    # Derive DID from CometBFT validator key
    local did="(will be available after DID derivation)"
    if [ -f "$CMT_HOME/config/priv_validator_key.json" ]; then
        # The DID can be derived from the ed25519 public key using multicodec + base58btc
        # For now, display the CometBFT address and pubkey
        did="(derive from validator pubkey via /v1/verify-did endpoint)"
    fi

    # ── Print Summary ────────────────────────────────────────────────

    echo ""
    echo "================================================================"
    echo "  ENSOUL VALIDATOR INSTALLED SUCCESSFULLY"
    echo "================================================================"
    echo ""
    echo "  Moniker:           $MONIKER"
    echo "  Chain ID:          $CHAIN_ID"
    echo "  CometBFT Address:  $val_address"
    echo "  CometBFT PubKey:   $val_pubkey"
    echo "  Node ID:           $node_id"
    echo "  Current Height:    $latest_height"
    echo "  Catching Up:       $catching_up"
    echo "  Peers:             $n_peers"
    echo ""
    echo "  Ports:"
    echo "    26656  P2P (must be reachable from internet)"
    echo "    26657  CometBFT RPC (localhost only)"
    echo "    26658  ABCI server (localhost only)"
    echo "    9000   Compat proxy"
    echo "    5050   API gateway"
    echo ""
    echo "  Logs:"
    echo "    ABCI:      $DATA_DIR/abci-server.log"
    echo "    CometBFT:  $DATA_DIR/cometbft.log"
    echo "    Proxy:     $DATA_DIR/compat-proxy.log"
    echo "    API:       $DATA_DIR/api.log"
    echo ""
    echo "  Keys:"
    echo "    Validator key:  $CMT_HOME/config/priv_validator_key.json"
    echo "    Node key:       $CMT_HOME/config/node_key.json"
    echo "    BACK THESE UP!  They cannot be recovered if lost."
    echo ""
    echo "  Next Steps:"
    echo "    1. Wait for sync to complete (catching_up: false)"
    echo "       curl -s http://localhost:26657/status | python3 -c \\"
    echo "         \"import sys,json; d=json.load(sys.stdin)['result']['sync_info']; print(f'Height: {d[\\\"latest_block_height\\\"]}, Catching up: {d[\\\"catching_up\\\"]}')\""
    echo ""
    echo "    2. Register as a validator via the API:"
    echo "       curl -X POST https://api.ensoul.dev/v1/validators/register \\"
    echo "         -H 'Content-Type: application/json' \\"
    echo "         -d '{\"did\":\"YOUR_DID\",\"publicKey\":\"YOUR_PUBKEY\",\"name\":\"$MONIKER\"}'"
    echo ""
    echo "    3. Stake tokens to begin producing blocks"
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
    # Skip registration during initial install; the node needs to sync first.
    # The user can register via the API after sync completes.
    if [ "$PIONEER_MODE" = "true" ]; then
        log "Pioneer mode enabled. Register after sync completes using:"
        log "  curl -X POST $API_URL/v1/validators/register-pioneer \\"
        log "    -H 'Content-Type: application/json' \\"
        log "    -H 'X-Ensoul-Pioneer-Key: YOUR_KEY' \\"
        log "    -d '{\"did\":\"YOUR_DID\",\"publicKey\":\"YOUR_PUBKEY\",\"name\":\"$MONIKER\"}'"
    fi
}

# ── Main ─────────────────────────────────────────────────────────────

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
    start_services
    register_validator
    wait_and_report

    log "Installation complete."
}

main
