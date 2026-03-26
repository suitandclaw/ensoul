#!/usr/bin/env bash
#
# chain-watchdog.sh
#
# Monitors CometBFT and ABCI server processes.
# Restarts ONLY when processes are confirmed dead.
# NEVER restarts because blocks are stale.
# NEVER touches cloudflared, explorer, monitor, or API.
#
# Rules:
#   1. If CometBFT process is dead: restart ABCI first, wait, restart CometBFT
#   2. If ABCI process is dead: kill CometBFT, restart ABCI first, wait, restart CometBFT
#   3. Stale blocks with running processes: LOG ONLY, never act
#

LOG="$HOME/.ensoul/watchdog.log"
ABCI_PORT=26658
RPC="http://localhost:26657"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" >> "$LOG"; }

# ── Process checks (definitive, via ps) ───────────────────────────────

is_cometbft_alive() {
    pgrep -f "cometbft start" >/dev/null 2>&1
}

is_abci_alive() {
    pgrep -f "abci-server/src/index" >/dev/null 2>&1
}

# ── Restart functions ─────────────────────────────────────────────────

start_abci() {
    log "ACTION: Starting ABCI server"
    export PATH="/opt/homebrew/bin:$HOME/go/bin:/usr/local/go/bin:/usr/local/bin:$PATH"
    export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
    [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

    cd "$HOME/ensoul" 2>/dev/null || return
    nohup npx tsx packages/abci-server/src/index.ts --port $ABCI_PORT >> "$HOME/.ensoul/abci-server.log" 2>&1 &
    log "ACTION: ABCI server started (pid $!)"
}

start_cometbft() {
    log "ACTION: Starting CometBFT via Cosmovisor"
    export PATH="/opt/homebrew/bin:$HOME/go/bin:/usr/local/go/bin:/usr/local/bin:$PATH"

    local NODE_DIR="$HOME/.cometbft-ensoul/node"
    export DAEMON_NAME=cometbft
    export DAEMON_HOME="$NODE_DIR"
    export DAEMON_DATA_BACKUP_DIR="$NODE_DIR/backups"
    export DAEMON_ALLOW_DOWNLOAD_URLS=true
    export DAEMON_RESTART_AFTER_UPGRADE=true

    mkdir -p "$NODE_DIR/cosmovisor/genesis/bin" "$NODE_DIR/backups"
    if [ ! -f "$NODE_DIR/cosmovisor/genesis/bin/cometbft" ]; then
        local CMT_BIN
        CMT_BIN=$(which cometbft 2>/dev/null || echo "$HOME/go/bin/cometbft")
        [ -f "$CMT_BIN" ] && cp "$CMT_BIN" "$NODE_DIR/cosmovisor/genesis/bin/cometbft"
    fi

    local COSMOVISOR_BIN
    COSMOVISOR_BIN=$(which cosmovisor 2>/dev/null || echo "$HOME/go/bin/cosmovisor")

    nohup "$COSMOVISOR_BIN" run start --home "$NODE_DIR" >> "$HOME/.ensoul/cometbft.log" 2>&1 &
    log "ACTION: CometBFT started via Cosmovisor (pid $!)"
}

restart_both() {
    log "ACTION: Full restart sequence (ABCI first, then CometBFT)"

    # Kill CometBFT if alive (it needs ABCI, so restart it after)
    if is_cometbft_alive; then
        local pid
        pid=$(pgrep -f "cometbft start" | head -1)
        kill "$pid" 2>/dev/null
        sleep 3
    fi

    # Start ABCI
    start_abci
    sleep 5

    # Verify ABCI is listening
    if ! nc -z 127.0.0.1 $ABCI_PORT 2>/dev/null; then
        log "ERROR: ABCI failed to start on port $ABCI_PORT"
        return
    fi

    # Start CometBFT
    start_cometbft
}

# ── Main check ────────────────────────────────────────────────────────

main() {
    local cmt_alive abci_alive

    is_cometbft_alive && cmt_alive=true || cmt_alive=false
    is_abci_alive && abci_alive=true || abci_alive=false

    # Case 1: Both dead
    if [ "$cmt_alive" = "false" ] && [ "$abci_alive" = "false" ]; then
        log "ALERT: Both CometBFT and ABCI are dead"
        restart_both
        return
    fi

    # Case 2: ABCI dead, CometBFT alive
    if [ "$abci_alive" = "false" ]; then
        log "ALERT: ABCI is dead (CometBFT will fail without it)"
        restart_both
        return
    fi

    # Case 3: CometBFT dead, ABCI alive
    if [ "$cmt_alive" = "false" ]; then
        log "ALERT: CometBFT is dead (ABCI is alive)"
        start_cometbft
        return
    fi

    # Case 4: Both alive. Check block age for logging only.
    local age=0
    local height="?"
    if curl -s -m 5 "$RPC/status" >/dev/null 2>&1; then
        local result
        result=$(curl -s -m 5 "$RPC/status" 2>/dev/null)
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
        log "WARN: Blocks stale for ${age}s at h=$height (processes alive, not restarting)"
    fi

    # Periodic health log
    if [ "$height" != "?" ] && [ $((height % 600)) -lt 2 ] 2>/dev/null; then
        log "OK: h=$height age=${age}s"
    fi
}

main
