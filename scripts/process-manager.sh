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
#   - Stale blocks:  ALERT + LOG, never restart (consensus issue, not process issue)
#   - NEVER kill cloudflared, explorer (3000), monitor (4000), or API (5050)
#
# Alerts via ntfy.sh push notifications.
#   Topic stored in ~/.ensoul/ntfy-topic.txt
#   Install ntfy app on phone and subscribe to the topic.
#

LOG="$HOME/.ensoul/process-manager.log"
LOCKFILE="$HOME/.ensoul/process-manager.lock"
NTFY_TOPIC_FILE="$HOME/.ensoul/ntfy-topic.txt"
STALE_ALERT_FILE="$HOME/.ensoul/.stale-alerted"
HOSTNAME_SHORT=$(hostname -s 2>/dev/null || echo "unknown")
mkdir -p "$HOME/.ensoul"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" >> "$LOG"; }

# ── Push notification via ntfy.sh ─────────────────────────────────────

alert() {
    local title="$1"
    local body="$2"
    local priority="${3:-default}"
    log "ALERT: $title: $body"

    # ntfy.sh (primary)
    local topic
    topic=$(cat "$NTFY_TOPIC_FILE" 2>/dev/null)
    if [ -n "$topic" ]; then
        curl -s -o /dev/null \
            -H "Title: $title" \
            -H "Priority: $priority" \
            -H "Tags: ${4:-warning}" \
            -d "$body" \
            "ntfy.sh/$topic" 2>/dev/null &
        log "ALERT SENT via ntfy.sh"
    fi

    # Telegram (backup)
    local tg_env="$HOME/.ensoul/telegram-bot.env"
    if [ -f "$tg_env" ]; then
        local tg_token tg_user
        tg_token=$(grep "^TELEGRAM_BOT_TOKEN=" "$tg_env" 2>/dev/null | cut -d= -f2-)
        tg_user=$(grep "^TELEGRAM_AUTHORIZED_USER=" "$tg_env" 2>/dev/null | cut -d= -f2-)
        if [ -n "$tg_token" ] && [ -n "$tg_user" ]; then
            local msg
            msg=$(printf '\xF0\x9F\x9A\xA8 <b>%s</b>\n%s' "$title" "$body")
            curl -s -o /dev/null -X POST \
                "https://api.telegram.org/bot${tg_token}/sendMessage" \
                -H "Content-Type: application/json" \
                -d "{\"chat_id\":${tg_user},\"text\":\"${msg}\",\"parse_mode\":\"HTML\"}" 2>/dev/null &
            log "ALERT SENT via Telegram"
        fi
    fi
}

# Prevent concurrent runs (launchd can trigger overlapping executions)
if [ -f "$LOCKFILE" ]; then
    lock_age=$(( $(date +%s) - $(stat -f %m "$LOCKFILE" 2>/dev/null || stat -c %Y "$LOCKFILE" 2>/dev/null || echo 0) ))
    if [ "$lock_age" -lt 60 ] 2>/dev/null; then
        exit 0  # Another instance is running or just ran
    fi
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
is_api_alive()     { is_port_alive 5050;  }
is_explorer_alive(){ is_port_alive 3000;  }
is_monitor_alive() { is_port_alive 4000;  }
is_tgbot_alive()   { pgrep -f "telegram-bot/start.ts" >/dev/null 2>&1; }
is_heartbeat_alive(){ pgrep -f "consciousness-heartbeat/start.ts" >/dev/null 2>&1; }
is_research_alive() { pgrep -f "research-agents/start.ts" >/dev/null 2>&1; }

# ── Start functions ───────────────────────────────────────────────────

start_abci() {
    log "START: ABCI server on port 26658"
    bash -l -c "cd $HOME/ensoul && nohup npx tsx packages/abci-server/src/index.ts --port 26658 >> $HOME/.ensoul/abci-server.log 2>&1 &"
    log "START: ABCI launched"
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
    bash -l -c "cd $HOME/ensoul && nohup npx tsx packages/abci-server/src/compat-proxy.ts --port 9000 >> $HOME/.ensoul/compat-proxy.log 2>&1 &"
    log "START: Proxy launched"
}

start_api() {
    log "START: API gateway on port 5050"
    bash -l -c "cd $HOME/ensoul && nohup npx tsx packages/api/start.ts --port 5050 >> $HOME/.ensoul/api.log 2>&1 &"
    log "START: API launched"
}

start_explorer() {
    log "START: Explorer on port 3000"
    bash -l -c "cd $HOME/ensoul && nohup npx tsx packages/explorer/start.ts --port 3000 --network-peers https://v0.ensoul.dev >> $HOME/.ensoul/explorer.log 2>&1 &"
    log "START: Explorer launched"
}

start_monitor() {
    log "START: Monitor on port 4000"
    bash -l -c "cd $HOME/ensoul && nohup npx tsx packages/monitor/start.ts --port 4000 >> $HOME/.ensoul/monitor.log 2>&1 &"
    log "START: Monitor launched"
}

start_tgbot() {
    log "START: Telegram bot"
    bash -l -c "cd $HOME/ensoul && nohup npx tsx packages/telegram-bot/start.ts > /dev/null 2>> $HOME/.ensoul/telegram-bot.log &"
    log "START: Telegram bot launched"
}

start_heartbeat() {
    log "START: Consciousness heartbeat"
    bash -l -c "cd $HOME/ensoul && nohup npx tsx packages/consciousness-heartbeat/start.ts > /dev/null 2>> $HOME/.ensoul/consciousness-heartbeat.log &"
    log "START: Heartbeat launched"
}

start_research() {
    log "START: Research agents"
    bash -l -c "cd $HOME/ensoul && nohup npx tsx packages/research-agents/start.ts > /dev/null 2>> $HOME/.ensoul/research-agents.log &"
    log "START: Research agents launched"
}

# ── Kill functions (by port, safe) ────────────────────────────────────

kill_by_port() {
    local port="$1"
    local pids
    pids=$(lsof -ti :"$port" 2>/dev/null)
    if [ -n "$pids" ]; then
        echo "$pids" | xargs kill 2>/dev/null
        sleep 2
        pids=$(lsof -ti :"$port" 2>/dev/null)
        [ -n "$pids" ] && echo "$pids" | xargs kill -9 2>/dev/null
    fi
}

# ── Restart sequences ────────────────────────────────────────────────

restart_full_stack() {
    alert "[$HOSTNAME_SHORT] ABCI DEAD" "Full stack restart in progress (ABCI, CometBFT, proxy)" "high" "rotating_light"

    kill_by_port 26657
    kill_by_port 26656
    kill_by_port 9000
    sleep 1

    start_abci
    sleep 5

    if ! is_abci_alive; then
        log "ERROR: ABCI failed to start on port 26658"
        alert "[$HOSTNAME_SHORT] ABCI FAILED" "ABCI did not start after restart. Manual intervention needed." "urgent" "skull"
        return 1
    fi

    start_cometbft
    sleep 8

    if is_cometbft_alive; then
        start_proxy
        alert "[$HOSTNAME_SHORT] RECOVERED" "Full stack restarted successfully" "low" "white_check_mark"
    else
        log "WARN: CometBFT not yet listening, proxy deferred to next cycle"
    fi
}

restart_cometbft_only() {
    alert "[$HOSTNAME_SHORT] CometBFT DEAD" "Restarting CometBFT (ABCI still alive)" "default" "warning"
    kill_by_port 26657
    kill_by_port 26656
    sleep 2
    start_cometbft
}

restart_proxy_only() {
    alert "[$HOSTNAME_SHORT] Proxy DEAD" "Restarting compat proxy on port 9000" "default" "warning"
    kill_by_port 9000
    sleep 1
    start_proxy
}

# ── Main check ────────────────────────────────────────────────────────

main() {
    local abci_ok cmt_ok proxy_ok api_ok explorer_ok monitor_ok tgbot_ok

    is_abci_alive    && abci_ok=true    || abci_ok=false
    is_cometbft_alive && cmt_ok=true    || cmt_ok=false
    is_proxy_alive   && proxy_ok=true   || proxy_ok=false
    is_api_alive     && api_ok=true     || api_ok=false
    is_explorer_alive && explorer_ok=true || explorer_ok=false
    is_monitor_alive && monitor_ok=true  || monitor_ok=false
    is_tgbot_alive   && tgbot_ok=true   || tgbot_ok=false
    is_heartbeat_alive && hb_ok=true    || hb_ok=false
    is_research_alive && rs_ok=true     || rs_ok=false

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

    # Case 4: API dead, restart it independently
    if [ "$api_ok" = "false" ]; then
        log "ALERT: API gateway is dead, restarting on port 5050"
        alert "[$HOSTNAME_SHORT] API DEAD" "Restarting API gateway on port 5050" "default" "warning"
        start_api
    fi

    # Case 5: Explorer dead (MBP only, port 3000)
    if [ "$explorer_ok" = "false" ] && [ -d "$HOME/ensoul/packages/explorer" ]; then
        log "ALERT: Explorer is dead, restarting on port 3000"
        alert "[$HOSTNAME_SHORT] Explorer DEAD" "Restarting explorer on port 3000" "default" "warning"
        start_explorer
    fi

    # Case 6: Monitor dead (MBP only, port 4000)
    if [ "$monitor_ok" = "false" ] && [ -d "$HOME/ensoul/packages/monitor" ]; then
        log "ALERT: Monitor is dead, restarting on port 4000"
        alert "[$HOSTNAME_SHORT] Monitor DEAD" "Restarting monitor on port 4000" "default" "warning"
        start_monitor
    fi

    # Case 7: Telegram bot (runs on VPS via systemd, not MBP)

    # Case 8: Consciousness heartbeat dead
    if [ "$hb_ok" = "false" ]; then
        log "ALERT: Consciousness heartbeat is dead, restarting"
        alert "[$HOSTNAME_SHORT] Heartbeat DEAD" "Restarting consciousness heartbeat" "default" "warning"
        start_heartbeat
    fi

    # Case 9: Research agents dead
    if [ "$rs_ok" = "false" ]; then
        log "ALERT: Research agents dead, restarting"
        alert "[$HOSTNAME_SHORT] Research DEAD" "Restarting research agents" "default" "warning"
        start_research
    fi

    # Case 10: Everything alive. Check block freshness and disk space.
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

    # Alert on stale blocks (once per stall, not every 30s)
    if [ "$age" -gt 120 ] 2>/dev/null; then
        if [ ! -f "$STALE_ALERT_FILE" ]; then
            alert "[$HOSTNAME_SHORT] CHAIN STALLED" "No new block in ${age}s at height $height. All processes alive." "high" "rotating_light"
            touch "$STALE_ALERT_FILE"
        fi
        log "WARN: Blocks stale for ${age}s at h=$height (all processes alive, not restarting)"
    else
        # Clear the stale alert flag when blocks resume
        if [ -f "$STALE_ALERT_FILE" ]; then
            alert "[$HOSTNAME_SHORT] Chain resumed" "Blocks producing again at height $height" "low" "white_check_mark"
            rm -f "$STALE_ALERT_FILE"
        fi
    fi

    # Check disk space (alert if below 10%)
    local disk_pct
    disk_pct=$(df -h "$HOME" 2>/dev/null | awk 'NR==2{gsub(/%/,"",$5); print $5}')
    if [ -n "$disk_pct" ] && [ "$disk_pct" -gt 90 ] 2>/dev/null; then
        alert "[$HOSTNAME_SHORT] DISK LOW" "Disk usage at ${disk_pct}% on $HOME" "high" "floppy_disk"
    fi

    # Check peer count (alert if below 2)
    if [ "$height" != "?" ]; then
        local peers
        peers=$(curl -s -m 3 "http://localhost:26657/net_info" 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin)['result']['n_peers'])" 2>/dev/null || echo "?")
        if [ "$peers" != "?" ] && [ "$peers" -lt 2 ] 2>/dev/null; then
            alert "[$HOSTNAME_SHORT] LOW PEERS" "Only $peers peers connected at height $height" "high" "warning"
        fi
    fi

    # Periodic health log (every ~300 blocks)
    if [ "$height" != "?" ] && [ $((height % 300)) -lt 2 ] 2>/dev/null; then
        local api_status="ok"
        [ "$api_ok" = "false" ] && api_status="down"
        log "OK: h=$height age=${age}s abci=ok cmt=ok proxy=ok api=$api_status"
    fi
}

main
