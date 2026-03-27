#!/usr/bin/env bash
#
# process-manager.sh
#
# Manages the Ensoul validator process stack in dependency order:
#   1. ABCI server (port 26658) - no dependencies
#   2. CometBFT via Cosmovisor (port 26657) - depends on ABCI
#   3. Compat proxy (port 9000) - depends on CometBFT RPC
#
# Rules:
#   - ABCI dies:     kill CometBFT, restart ABCI, wait, restart CometBFT, restart proxy
#   - CometBFT dies: restart CometBFT only (ABCI is still running)
#   - Proxy dies:    restart proxy only
#   - Stale blocks:  LOG ONLY, never act
#   - NEVER kill cloudflared, explorer (3000), monitor (4000), or API (5050)
#
# Usage:
#   bash scripts/process-manager.sh          # single check + restart cycle
#   launchd runs this every 30 seconds
#

LOG="$HOME/.ensoul/process-manager.log"
LOCKFILE="$HOME/.ensoul/process-manager.lock"
mkdir -p "$HOME/.ensoul"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" >> "$LOG"; }

# Prevent concurrent runs (launchd can trigger overlapping executions)
if [ -f "$LOCKFILE" ]; then
    lock_age=$(( $(date +%s) - $(stat -f %m "$LOCKFILE" 2>/dev/null || stat -c %Y "$LOCKFILE" 2>/dev/null || echo 0) ))
    if [ "$lock_age" -lt 60 ] 2>/dev/null; then
        exit 0  # Another instance is running or just ran
    fi
    # Stale lock (over 60s old), remove it
    rm -f "$LOCKFILE"
fi
echo $$ > "$LOCKFILE"
trap 'rm -f "$LOCKFILE"' EXIT

# ── Environment setup (run once at script start) ──────────────────────

export PATH="/opt/homebrew/bin:$HOME/go/bin:/usr/local/go/bin:/usr/local/bin:$PATH"
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

# ── Process checks (port-based, more reliable than pgrep) ─────────────

is_port_alive() {
    nc -z 127.0.0.1 "$1" 2>/dev/null
}

is_abci_alive()    { is_port_alive 26658; }
is_cometbft_alive(){ is_port_alive 26657; }
is_proxy_alive()   { is_port_alive 9000;  }

# ── Start functions ───────────────────────────────────────────────────

start_abci() {
    log "START: ABCI server on port 26658"
    nohup bash -l -c "cd $HOME/ensoul && npx tsx packages/abci-server/src/index.ts --port 26658" >> "$HOME/.ensoul/abci-server.log" 2>&1 &
    log "START: ABCI PID $!"
}

start_cometbft() {
    log "START: CometBFT via Cosmovisor"


    local NODE_DIR="$HOME/.cometbft-ensoul/node"
    export DAEMON_NAME=cometbft
    export DAEMON_HOME="$NODE_DIR"
    export DAEMON_DATA_BACKUP_DIR="$NODE_DIR/backups"
    export DAEMON_ALLOW_DOWNLOAD_BINARIES=false
    export DAEMON_RESTART_AFTER_UPGRADE=true

    mkdir -p "$NODE_DIR/cosmovisor/genesis/bin" "$NODE_DIR/backups"

    # Ensure genesis binary exists
    if [ ! -f "$NODE_DIR/cosmovisor/genesis/bin/cometbft" ]; then
        local CMT_BIN
        CMT_BIN=$(which cometbft 2>/dev/null || echo "$HOME/go/bin/cometbft")
        [ -f "$CMT_BIN" ] && cp "$CMT_BIN" "$NODE_DIR/cosmovisor/genesis/bin/cometbft"
    fi

    local COSMOVISOR_BIN
    COSMOVISOR_BIN=$(which cosmovisor 2>/dev/null || echo "$HOME/go/bin/cosmovisor")

    nohup "$COSMOVISOR_BIN" run start \
        --proxy_app=tcp://127.0.0.1:26658 \
        --home "$NODE_DIR" \
        >> "$HOME/.ensoul/cometbft.log" 2>&1 &
    log "START: CometBFT PID $!"
}

start_proxy() {
    log "START: Compat proxy on port 9000"
    nohup bash -l -c "cd $HOME/ensoul && npx tsx packages/abci-server/src/compat-proxy.ts --port 9000" >> "$HOME/.ensoul/compat-proxy.log" 2>&1 &
    log "START: Proxy PID $!"
}

# ── Kill functions (by port, safe) ────────────────────────────────────

kill_by_port() {
    local port="$1"
    local pids
    pids=$(lsof -ti :"$port" 2>/dev/null)
    if [ -n "$pids" ]; then
        echo "$pids" | xargs kill 2>/dev/null
        sleep 2
        # Force kill if still alive
        pids=$(lsof -ti :"$port" 2>/dev/null)
        [ -n "$pids" ] && echo "$pids" | xargs kill -9 2>/dev/null
    fi
}

# ── Restart sequences ────────────────────────────────────────────────

restart_full_stack() {
    log "ACTION: Full stack restart (ABCI -> CometBFT -> Proxy)"

    # Kill CometBFT and proxy first (they depend on ABCI)
    kill_by_port 26657
    kill_by_port 26656
    kill_by_port 9000
    sleep 1

    # Start ABCI
    start_abci
    sleep 5

    # Verify ABCI is listening
    if ! is_abci_alive; then
        log "ERROR: ABCI failed to start on port 26658"
        return 1
    fi

    # Start CometBFT
    start_cometbft
    sleep 8

    # Start proxy (only if CometBFT is now listening)
    if is_cometbft_alive; then
        start_proxy
    else
        log "WARN: CometBFT not yet listening, proxy start deferred to next cycle"
    fi
}

restart_cometbft_only() {
    log "ACTION: Restarting CometBFT only (ABCI is alive)"
    kill_by_port 26657
    kill_by_port 26656
    sleep 2
    start_cometbft
}

restart_proxy_only() {
    log "ACTION: Restarting compat proxy only"
    kill_by_port 9000
    sleep 1
    start_proxy
}

# ── Main check ────────────────────────────────────────────────────────

main() {
    local abci_ok cmt_ok proxy_ok

    is_abci_alive    && abci_ok=true  || abci_ok=false
    is_cometbft_alive && cmt_ok=true  || cmt_ok=false
    is_proxy_alive   && proxy_ok=true || proxy_ok=false

    # Case 1: ABCI dead (everything must restart in order)
    if [ "$abci_ok" = "false" ]; then
        log "ALERT: ABCI is dead (full stack restart required)"
        restart_full_stack
        return
    fi

    # Case 2: CometBFT dead, ABCI alive
    if [ "$cmt_ok" = "false" ]; then
        log "ALERT: CometBFT is dead (ABCI is alive)"
        restart_cometbft_only
        # Also check proxy after CometBFT restarts
        sleep 3
        if ! is_proxy_alive; then
            start_proxy
        fi
        return
    fi

    # Case 3: Proxy dead, everything else alive
    if [ "$proxy_ok" = "false" ]; then
        log "ALERT: Compat proxy is dead (CometBFT and ABCI alive)"
        restart_proxy_only
        return
    fi

    # Case 4: Everything alive. Check block freshness for logging only.
    local age=0 height="?"
    local result
    result=$(curl -s -m 5 "http://localhost:26657/status" 2>/dev/null)
    if [ -n "$result" ]; then
        height=$(echo "$result" | python3 -c "import sys,json; print(json.load(sys.stdin)['result']['sync_info']['latest_block_height'])" 2>/dev/null || echo "?")
        age=$(echo "$result" | python3 -c "
from datetime import datetime, timezone
import sys,json
try:
    d = json.load(sys.stdin)['result']['sync_info']
    bt = datetime.fromisoformat(d['latest_block_time'].replace('Z','+00:00'))
    print(int((datetime.now(timezone.utc) - bt).total_seconds()))
except:
    print(0)
" 2>/dev/null || echo "0")
    fi

    # Log stale blocks (never act on them)
    if [ "$age" -gt 120 ] 2>/dev/null; then
        log "WARN: Blocks stale for ${age}s at h=$height (all processes alive, not restarting)"
    fi

    # Periodic health log (every ~300 blocks, roughly every 10 minutes)
    if [ "$height" != "?" ] && [ $((height % 300)) -lt 2 ] 2>/dev/null; then
        log "OK: h=$height age=${age}s abci=ok cmt=ok proxy=ok"
    fi
}

main
