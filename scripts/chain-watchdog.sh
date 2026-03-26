#!/usr/bin/env bash
#
# chain-watchdog.sh
#
# Monitors the CometBFT chain and auto-recovers stalled processes.
# Runs every 30 seconds. Never kills cloudflared or wipes chain data.
#
# Checks:
#   1. Is CometBFT responding?
#   2. Is the last block recent (< 120 seconds)?
#   3. Are peers connected?
#   4. Is the ABCI server responding?
#
# Recovery actions (escalating):
#   1. Restart ABCI server
#   2. Restart CometBFT via Cosmovisor
#   3. Log CRITICAL alert
#

LOG="$HOME/.ensoul/watchdog.log"
RPC="http://localhost:26657"
ABCI_PORT=26658
STALE_THRESHOLD=120    # seconds before alert
CRITICAL_THRESHOLD=600 # 10 minutes = serious problem

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" >> "$LOG"; }

# ── Get block age ─────────────────────────────────────────────────────

get_block_age() {
    local resp
    resp=$(curl -s "$RPC/status" 2>/dev/null) || { echo "999999"; return; }
    
    local block_time
    block_time=$(echo "$resp" | python3 -c "
import sys,json
from datetime import datetime, timezone
try:
    d = json.load(sys.stdin)['result']['sync_info']
    bt = d['latest_block_time']
    # Parse ISO timestamp
    t = datetime.fromisoformat(bt.replace('Z','+00:00'))
    now = datetime.now(timezone.utc)
    print(int((now - t).total_seconds()))
except:
    print(999999)
" 2>/dev/null)
    echo "${block_time:-999999}"
}

get_height() {
    curl -s "$RPC/status" 2>/dev/null | python3 -c "
import sys,json
try: print(json.load(sys.stdin)['result']['sync_info']['latest_block_height'])
except: print(0)
" 2>/dev/null || echo "0"
}

get_peers() {
    curl -s "$RPC/net_info" 2>/dev/null | python3 -c "
import sys,json
try: print(json.load(sys.stdin)['result']['n_peers'])
except: print(0)
" 2>/dev/null || echo "0"
}

is_catching_up() {
    curl -s "$RPC/status" 2>/dev/null | python3 -c "
import sys,json
try: print(json.load(sys.stdin)['result']['sync_info']['catching_up'])
except: print('True')
" 2>/dev/null || echo "True"
}

# ── Recovery actions ──────────────────────────────────────────────────

restart_abci() {
    log "ACTION: Restarting ABCI server on port $ABCI_PORT"
    
    # Find and kill the ABCI server process (NOT cloudflared, NOT explorer, NOT monitor, NOT API)
    local abci_pid
    abci_pid=$(lsof -ti :$ABCI_PORT 2>/dev/null | head -1)
    if [ -n "$abci_pid" ]; then
        kill "$abci_pid" 2>/dev/null || true
        sleep 3
    fi
    
    
    cd "$HOME/ensoul" 2>/dev/null || cd "$HOME/ensoul"
    
    # Source nvm for Minis
    export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
    [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
    export PATH="/opt/homebrew/bin:$HOME/go/bin:/usr/local/go/bin:$PATH"
    
    nohup npx tsx packages/abci-server/src/index.ts --port $ABCI_PORT >> "$HOME/.ensoul/abci-server.log" 2>&1 &
    log "ACTION: ABCI server restarted (pid $!)"
    sleep 5
}

restart_cometbft() {
    log "ACTION: Restarting CometBFT via Cosmovisor"
    
    # Kill CometBFT (by port, never by name)
    local cmt_pid
    cmt_pid=$(lsof -ti :26656 2>/dev/null | head -1)
    if [ -n "$cmt_pid" ]; then
        kill "$cmt_pid" 2>/dev/null || true
        sleep 3
    fi
    
    export PATH="/opt/homebrew/bin:$HOME/go/bin:/usr/local/go/bin:$PATH"
    
    local NODE_DIR="$HOME/.cometbft-ensoul/node"
    export DAEMON_NAME=cometbft
    export DAEMON_HOME="$NODE_DIR"
    export DAEMON_DATA_BACKUP_DIR="$NODE_DIR/backups"
    export DAEMON_ALLOW_DOWNLOAD_URLS=true
    export DAEMON_RESTART_AFTER_UPGRADE=true
    
    # Ensure Cosmovisor dirs exist
    mkdir -p "$NODE_DIR/cosmovisor/genesis/bin" "$NODE_DIR/backups"
    if [ ! -f "$NODE_DIR/cosmovisor/genesis/bin/cometbft" ]; then
        cp "$(which cometbft)" "$NODE_DIR/cosmovisor/genesis/bin/cometbft"
    fi
    
    nohup cosmovisor run start --home "$NODE_DIR" >> "$HOME/.ensoul/cometbft.log" 2>&1 &
    log "ACTION: CometBFT restarted via Cosmovisor (pid $!)"
    sleep 10
}

# ── Main check ────────────────────────────────────────────────────────

main() {
    local age height peers catching_up
    
    # Check if CometBFT RPC responds at all
    if ! curl -s "$RPC/status" >/dev/null 2>&1; then
        log "ALERT: CometBFT RPC not responding"
        
        # Check if ABCI is alive
        if ! nc -z 127.0.0.1 $ABCI_PORT 2>/dev/null; then
            log "ALERT: ABCI server also down"
            restart_abci
            sleep 5
        fi
        
        restart_cometbft
        return
    fi
    
    age=$(get_block_age)
    height=$(get_height)
    peers=$(get_peers)
    catching_up=$(is_catching_up)
    
    # If catching up, that's normal (syncing from peers)
    if [ "$catching_up" = "True" ]; then
        return
    fi
    
    # Critical: 10+ minutes stale
    if [ "$age" -ge "$CRITICAL_THRESHOLD" ]; then
        log "CRITICAL: Chain stalled for ${age}s at height $height with $peers peers"
        log "CRITICAL: Full diagnostics:"
        log "  Block age: ${age}s"
        log "  Height: $height"
        log "  Peers: $peers"
        log "  ABCI port $ABCI_PORT: $(nc -z 127.0.0.1 $ABCI_PORT 2>/dev/null && echo 'open' || echo 'closed')"
        
        # Escalated recovery: restart both
        restart_abci
        restart_cometbft
        return
    fi
    
    # Warning: 2+ minutes stale
    if [ "$age" -ge "$STALE_THRESHOLD" ]; then
        log "WARN: Last block ${age}s ago at height $height (peers=$peers)"
        
        # First attempt: restart ABCI
        if ! nc -z 127.0.0.1 $ABCI_PORT 2>/dev/null; then
            restart_abci
        fi
        return
    fi
    
    # Healthy: log periodically (every 10 minutes = every 20 checks)
    if [ $((height % 600)) -lt 2 ]; then
        log "OK: height=$height age=${age}s peers=$peers"
    fi
}

main
