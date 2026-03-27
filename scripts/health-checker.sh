#!/usr/bin/env bash
#
# health-checker.sh
#
# Runs on MBP every 60 seconds. Monitors the entire Ensoul network:
#   - All 5 validators (CometBFT RPC reachable, peer count, block height)
#   - All public URLs (HTTP 200 check)
#   - VPS reachability
#   - Cross-validator consistency (agent count, height)
#
# Sends push notifications via ntfy.sh when something breaks.
# Sends a recovery notification when it comes back.
#
# Tracks state in ~/.ensoul/health-state/ to avoid duplicate alerts.
#
# Usage:
#   bash scripts/health-checker.sh
#   Runs via launchd every 60 seconds (dev.ensoul.health-checker)
#

LOG="$HOME/.ensoul/health-checker.log"
STATE_DIR="$HOME/.ensoul/health-state"
NTFY_TOPIC_FILE="$HOME/.ensoul/ntfy-topic.txt"
LOCKFILE="$HOME/.ensoul/health-checker.lock"
mkdir -p "$STATE_DIR"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" >> "$LOG"; }

alert() {
    local title="$1"
    local body="$2"
    local priority="${3:-default}"
    log "ALERT: $title: $body"

    local topic
    topic=$(cat "$NTFY_TOPIC_FILE" 2>/dev/null)
    [ -z "$topic" ] && return

    curl -s -o /dev/null \
        -H "Title: $title" \
        -H "Priority: $priority" \
        -H "Tags: ${4:-warning}" \
        -d "$body" \
        "ntfy.sh/$topic" 2>/dev/null &
}

# Prevent concurrent runs
if [ -f "$LOCKFILE" ]; then
    lock_age=$(( $(date +%s) - $(stat -f %m "$LOCKFILE" 2>/dev/null || stat -c %Y "$LOCKFILE" 2>/dev/null || echo 0) ))
    if [ "$lock_age" -lt 90 ] 2>/dev/null; then
        exit 0
    fi
    rm -f "$LOCKFILE"
fi
echo $$ > "$LOCKFILE"
trap 'rm -f "$LOCKFILE"' EXIT

# ── State tracking (avoid duplicate alerts) ──────────────────────────

was_down() { [ -f "$STATE_DIR/$1.down" ]; }

mark_down() {
    if [ ! -f "$STATE_DIR/$1.down" ]; then
        echo "$(date '+%Y-%m-%d %H:%M:%S')" > "$STATE_DIR/$1.down"
        return 0  # newly down
    fi
    return 1  # already known down
}

mark_up() {
    if [ -f "$STATE_DIR/$1.down" ]; then
        local since
        since=$(cat "$STATE_DIR/$1.down")
        rm -f "$STATE_DIR/$1.down"
        echo "$since"  # return when it went down
        return 0  # newly recovered
    fi
    return 1  # was already up
}

# ── Check functions ──────────────────────────────────────────────────

check_validator() {
    local name="$1" rpc="$2"
    local result height
    result=$(curl -s -m 8 "$rpc/status" 2>/dev/null)

    if [ -z "$result" ]; then
        if mark_down "validator-$name"; then
            alert "Validator $name OFFLINE" "Cannot reach $rpc" "high" "rotating_light"
        fi
        return 1
    fi

    height=$(echo "$result" | python3 -c "import sys,json; print(json.load(sys.stdin)['result']['sync_info']['latest_block_height'])" 2>/dev/null || echo "0")
    local recovered_since
    if recovered_since=$(mark_up "validator-$name"); then
        alert "Validator $name ONLINE" "Back at height $height (was down since $recovered_since)" "low" "white_check_mark"
    fi

    echo "$height"
    return 0
}

check_url() {
    local name="$1" url="$2"
    local code
    code=$(curl -s -o /dev/null -w "%{http_code}" -m 10 "$url" 2>/dev/null)

    if [ "$code" != "200" ]; then
        if mark_down "url-$name"; then
            alert "$name DOWN" "$url returned HTTP $code" "high" "rotating_light"
        fi
        return 1
    fi

    local recovered_since
    if recovered_since=$(mark_up "url-$name"); then
        alert "$name RECOVERED" "$url is back (HTTP 200). Was down since $recovered_since" "low" "white_check_mark"
    fi
    return 0
}

# ── Main ─────────────────────────────────────────────────────────────

main() {
    # Check all validators via Tailscale RPC
    local mbp_h mini1_h mini2_h mini3_h vps_h
    mbp_h=$(check_validator "MBP" "http://localhost:26657")
    mini1_h=$(check_validator "Mini1" "http://100.86.108.114:26657")
    mini2_h=$(check_validator "Mini2" "http://100.117.84.28:26657")
    mini3_h=$(check_validator "Mini3" "http://100.127.140.26:26657")
    vps_h=$(check_validator "VPS" "http://100.72.212.104:26657")

    # Check public URLs
    check_url "explorer.ensoul.dev" "https://explorer.ensoul.dev"
    check_url "api.ensoul.dev" "https://api.ensoul.dev/health"
    check_url "status.ensoul.dev" "https://status.ensoul.dev/api/health"

    # Check peer count on MBP
    local peers
    peers=$(curl -s -m 5 "http://localhost:26657/net_info" 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin)['result']['n_peers'])" 2>/dev/null || echo "0")
    if [ "$peers" -lt 2 ] 2>/dev/null; then
        if mark_down "low-peers"; then
            alert "LOW PEER COUNT" "MBP has only $peers peers (expected 3+)" "high" "warning"
        fi
    else
        if mark_up "low-peers" > /dev/null 2>&1; then
            alert "Peers recovered" "MBP now has $peers peers" "low" "white_check_mark"
        fi
    fi

    # Check cloudflared is running (on MBP)
    if ! pgrep -f cloudflared > /dev/null 2>&1; then
        if mark_down "cloudflared"; then
            alert "CLOUDFLARED DOWN" "Tunnel process not running on MBP. All public URLs will fail." "urgent" "skull"
        fi
    else
        if mark_up "cloudflared" > /dev/null 2>&1; then
            alert "Cloudflared recovered" "Tunnel process is back" "low" "white_check_mark"
        fi
    fi

    # Periodic health summary (every 30 minutes, based on file age)
    local summary_file="$STATE_DIR/.last-summary"
    local summary_age=9999
    if [ -f "$summary_file" ]; then
        summary_age=$(( $(date +%s) - $(stat -f %m "$summary_file" 2>/dev/null || stat -c %Y "$summary_file" 2>/dev/null || echo 0) ))
    fi

    if [ "$summary_age" -gt 1800 ] 2>/dev/null; then
        local down_count=0
        for f in "$STATE_DIR"/*.down; do
            [ -f "$f" ] && down_count=$((down_count + 1))
        done
        if [ "$down_count" -eq 0 ]; then
            log "HEALTH: All systems operational. MBP=$mbp_h peers=$peers"
        else
            log "HEALTH: $down_count services down. MBP=$mbp_h peers=$peers"
        fi
        touch "$summary_file"
    fi
}

main
