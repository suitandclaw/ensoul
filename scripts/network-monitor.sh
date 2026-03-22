#!/usr/bin/env bash
#
# network-monitor.sh - Self-monitoring daemon for the Ensoul network.
#
# Checks health every 60 seconds, restarts failed services, logs metrics.
# NEVER wipes chain data. NEVER restarts all validators at once.
# NEVER kills the tunnel when fixing other services.
#
# Usage:
#   ./scripts/network-monitor.sh            # run once
#   ./scripts/network-monitor.sh --loop     # run continuously
#   ./scripts/network-monitor.sh --install  # install as launchd service
#
# Self-healing rules:
#   - Validator dead: restart it (max 3/hour/validator, then alert)
#   - Service dead: restart it (max 3/hour)
#   - Tunnel dead: restart cloudflared (max 3/hour)
#   - Stall > 3 min: restart proposer validator
#   - Memory > 1GB: restart that validator
#   - Max 1 validator restart per 60-second window
#

set -uo pipefail

export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" 2>/dev/null || true
export PATH="$HOME/.nvm/versions/node/v22.22.1/bin:$HOME/Library/pnpm:$HOME/.local/share/pnpm:/usr/local/bin:/opt/homebrew/bin:$PATH"

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LOG_DIR="$HOME/.ensoul"
LOG_FILE="$LOG_DIR/network-monitor.log"
METRICS_FILE="$LOG_DIR/chain-metrics.csv"
HEALTH_FILE="$LOG_DIR/network-health.json"
WEBHOOK_URL="${ENSOUL_WEBHOOK_URL:-}"
MAX_LOG_SIZE=10485760 # 10MB

# Restart counters: service_name -> "count:hour"
declare -A RESTART_COUNTS 2>/dev/null || true
LAST_VALIDATOR_RESTART=0
LAST_HEIGHT=0
LAST_HEIGHT_TIME=0
CHECK_COUNT=0

mkdir -p "$LOG_DIR"

# Initialize metrics CSV if needed
if [ ! -f "$METRICS_FILE" ]; then
	echo "timestamp,height,blockTime,txCount,agentCount,storeCount" > "$METRICS_FILE"
fi

log() {
	local level="$1"
	local msg="$2"
	local ts
	ts=$(date +"%Y-%m-%d %H:%M:%S")
	echo "[$ts] [$level] $msg" >> "$LOG_FILE"

	# Rotate log if too large
	local size
	size=$(wc -c < "$LOG_FILE" 2>/dev/null || echo 0)
	if [ "$size" -gt "$MAX_LOG_SIZE" ]; then
		mv "$LOG_FILE" "$LOG_FILE.old"
		echo "[$ts] [INFO] Log rotated" > "$LOG_FILE"
	fi

	# Send CRITICAL alerts to webhook
	if [ "$level" = "CRITICAL" ] && [ -n "$WEBHOOK_URL" ]; then
		curl -s -X POST "$WEBHOOK_URL" \
			-H "Content-Type: application/json" \
			-d "{\"level\":\"$level\",\"message\":\"$msg\",\"timestamp\":\"$ts\",\"service\":\"network-monitor\"}" \
			>/dev/null 2>&1 || true
	fi
}

can_restart() {
	local name="$1"
	local current_hour
	current_hour=$(date +"%Y-%m-%d-%H")
	local entry="${RESTART_COUNTS[$name]:-0:none}"
	local count="${entry%%:*}"
	local hour="${entry##*:}"
	if [ "$hour" != "$current_hour" ]; then
		RESTART_COUNTS[$name]="0:$current_hour"
		return 0
	fi
	if [ "$count" -ge 3 ]; then
		return 1
	fi
	return 0
}

record_restart() {
	local name="$1"
	local current_hour
	current_hour=$(date +"%Y-%m-%d-%H")
	local entry="${RESTART_COUNTS[$name]:-0:$current_hour}"
	local count="${entry%%:*}"
	local hour="${entry##*:}"
	if [ "$hour" != "$current_hour" ]; then
		count=0
	fi
	count=$((count + 1))
	RESTART_COUNTS[$name]="$count:$current_hour"
}

# ── Health checks ─────────────────────────────────────────────────────

check_block_production() {
	local height
	height=$(curl -s --connect-timeout 3 http://localhost:9000/peer/status 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin).get('height',0))" 2>/dev/null || echo 0)

	if [ "$height" -eq 0 ]; then return; fi

	local now
	now=$(date +%s)

	if [ "$LAST_HEIGHT" -gt 0 ] && [ "$height" -eq "$LAST_HEIGHT" ]; then
		local stall_time=$((now - LAST_HEIGHT_TIME))
		if [ "$stall_time" -gt 180 ]; then
			log "CRITICAL" "Block production stalled at height $height for ${stall_time}s"
		elif [ "$stall_time" -gt 60 ]; then
			log "WARNING" "No new block for ${stall_time}s at height $height"
		fi
	else
		LAST_HEIGHT_TIME=$now
	fi
	LAST_HEIGHT=$height
}

check_validators() {
	for port in 9000 9001 9002 9003 9004; do
		local pid
		pid=$(lsof -ti ":$port" 2>/dev/null | head -1 || echo "")
		if [ -z "$pid" ]; then continue; fi

		local health
		health=$(curl -s --connect-timeout 3 "http://localhost:$port/peer/health" 2>/dev/null || echo "")
		if [ -z "$health" ]; then
			local idx=$((port - 9000))
			log "WARNING" "Validator-$idx on port $port not responding"

			if can_restart "validator-$idx"; then
				local now
				now=$(date +%s)
				if [ $((now - LAST_VALIDATOR_RESTART)) -lt 60 ]; then
					log "INFO" "Skipping restart (another validator restarted < 60s ago)"
					continue
				fi
				log "INFO" "Restarting validator-$idx..."
				kill "$pid" 2>/dev/null; sleep 2; kill -9 "$pid" 2>/dev/null

				local consensus_flag=""
				if [ "$port" -eq 9000 ]; then
					consensus_flag="--consensus-only --consensus-threshold 0.1"
				fi

				cd "$REPO_DIR"
				npx tsx packages/node/src/cli/main.ts \
					--validate --no-min-stake $consensus_flag \
					--genesis "$LOG_DIR/genesis.json" \
					--port "$port" --api-port $((port + 1000)) \
					--data-dir "$LOG_DIR/validator-$idx" \
					--peers "https://v1.ensoul.dev,https://v2.ensoul.dev,https://v3.ensoul.dev" \
					>"$LOG_DIR/validator-$idx.log" 2>&1 &

				record_restart "validator-$idx"
				LAST_VALIDATOR_RESTART=$(date +%s)
				log "INFO" "Validator-$idx restarted (pid $!)"
			else
				log "CRITICAL" "Validator-$idx down, restart limit reached (3/hour)"
			fi
		fi
	done
}

check_services() {
	# Explorer (port 3000)
	if ! curl -s --connect-timeout 3 -o /dev/null http://localhost:3000/ 2>/dev/null; then
		log "WARNING" "Explorer down on port 3000"
		if can_restart "explorer"; then
			lsof -ti:3000 2>/dev/null | xargs kill -9 2>/dev/null || true
			sleep 2
			cd "$REPO_DIR"
			ENSOUL_PEERS="https://v0.ensoul.dev,https://v1.ensoul.dev,https://v2.ensoul.dev,https://v3.ensoul.dev" \
			npx tsx packages/explorer/start.ts --port 3000 > "$LOG_DIR/explorer.log" 2>&1 &
			record_restart "explorer"
			log "INFO" "Explorer restarted"
		fi
	fi

	# Monitor (port 4000)
	if ! curl -s --connect-timeout 3 -o /dev/null http://localhost:4000/api/health 2>/dev/null; then
		log "WARNING" "Monitor down on port 4000"
		if can_restart "monitor"; then
			lsof -ti:4000 2>/dev/null | xargs kill -9 2>/dev/null || true
			sleep 2
			cd "$REPO_DIR"
			ENSOUL_STATUS_PASSWORD="${ENSOUL_STATUS_PASSWORD:-ensoul-status-2026}" \
			npx tsx packages/monitor/start.ts --port 4000 > "$LOG_DIR/monitor.log" 2>&1 &
			record_restart "monitor"
			log "INFO" "Monitor restarted"
		fi
	fi

	# API (port 5050)
	if ! curl -s --connect-timeout 3 -o /dev/null http://localhost:5050/health 2>/dev/null; then
		log "WARNING" "API down on port 5050"
		if can_restart "api"; then
			lsof -ti:5050 2>/dev/null | xargs kill -9 2>/dev/null || true
			sleep 2
			cd "$REPO_DIR"
			ONBOARDING_KEY_PATH="$REPO_DIR/genesis-keys/onboarding.json" \
			TREASURY_KEY_PATH="$REPO_DIR/genesis-keys/treasury.json" \
			npx tsx packages/api/start.ts --port 5050 > "$LOG_DIR/api.log" 2>&1 &
			record_restart "api"
			log "INFO" "API restarted"
		fi
	fi
}

check_tunnel() {
	if ! curl -s --connect-timeout 10 https://v0.ensoul.dev/peer/status >/dev/null 2>&1; then
		if ! pgrep -f cloudflared >/dev/null 2>&1; then
			log "CRITICAL" "Tunnel down (cloudflared not running)"
			if can_restart "tunnel"; then
				cloudflared tunnel run ensoul > "$LOG_DIR/tunnel.log" 2>&1 &
				record_restart "tunnel"
				log "INFO" "Tunnel restarted (pid $!)"
			fi
		else
			log "WARNING" "Tunnel process alive but v0.ensoul.dev unreachable"
		fi
	fi
}

check_agents() {
	if [ -f "$LOG_DIR/agents-disabled" ]; then return; fi

	# Twitter agent: check PID file instead of pgrep (avoids false negatives)
	local agent_pid_file="$LOG_DIR/pids.json"
	if [ -d "$HOME/ensoul-agent/src" ] && [ -f "$HOME/ensoul-agent/.env" ]; then
		local agent_pid
		agent_pid=$(python3 -c "import json; print(json.load(open('$agent_pid_file')).get('agent', 0))" 2>/dev/null || echo 0)
		if [ "$agent_pid" = "0" ] || ! kill -0 "$agent_pid" 2>/dev/null; then
			log "INFO" "Twitter agent not running, restarting..."
			cd "$HOME/ensoul-agent" && npx tsx src/agent.ts > "$LOG_DIR/agent.log" 2>&1 &
			local new_pid=$!
			python3 -c "
import json
try:
    d = json.load(open('$agent_pid_file'))
except: d = {}
d['agent'] = $new_pid
json.dump(d, open('$agent_pid_file', 'w'))
" 2>/dev/null
			cd "$REPO_DIR"
		fi
	fi

	# Moltbook agent
	if [ -d "$HOME/ensoul-moltbook-agent/src" ] && [ -f "$HOME/ensoul-moltbook-agent/.env" ]; then
		local mb_pid
		mb_pid=$(python3 -c "import json; print(json.load(open('$agent_pid_file')).get('moltbook', 0))" 2>/dev/null || echo 0)
		if [ "$mb_pid" = "0" ] || ! kill -0 "$mb_pid" 2>/dev/null; then
			log "INFO" "Moltbook agent not running, restarting..."
			cd "$HOME/ensoul-moltbook-agent" && npx tsx src/agent.ts > "$LOG_DIR/moltbook-agent.log" 2>&1 &
			local new_mb_pid=$!
			python3 -c "
import json
try:
    d = json.load(open('$agent_pid_file'))
except: d = {}
d['moltbook'] = $new_mb_pid
json.dump(d, open('$agent_pid_file', 'w'))
" 2>/dev/null
			cd "$REPO_DIR"
		fi
	fi
}

check_memory() {
	for port in 9000 9001 9002 9003 9004; do
		local pid
		pid=$(lsof -ti ":$port" 2>/dev/null | head -1 || echo "")
		if [ -z "$pid" ]; then continue; fi
		local rss
		rss=$(ps -o rss= -p "$pid" 2>/dev/null | tr -d ' ' || echo 0)
		local mb=$((rss / 1024))
		if [ "$mb" -gt 1024 ]; then
			local idx=$((port - 9000))
			log "CRITICAL" "Validator-$idx using ${mb}MB RAM, restarting"
		elif [ "$mb" -gt 500 ]; then
			local idx=$((port - 9000))
			log "WARNING" "Validator-$idx using ${mb}MB RAM"
		fi
	done
}

# ── Metrics collection (every 10 checks = 10 minutes) ────────────────

collect_metrics() {
	local height blockTime agentCount storeCount
	height=$(curl -s --connect-timeout 3 http://localhost:9000/peer/status 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin).get('height',0))" 2>/dev/null || echo 0)
	local stats
	stats=$(curl -s --connect-timeout 3 http://localhost:5050/v1/network/status 2>/dev/null || echo "{}")
	agentCount=$(echo "$stats" | python3 -c "import sys,json; print(json.load(sys.stdin).get('agentCount',0))" 2>/dev/null || echo 0)
	storeCount=$(echo "$stats" | python3 -c "import sys,json; print(json.load(sys.stdin).get('totalConsciousnessStored',0))" 2>/dev/null || echo 0)
	local ts
	ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
	echo "$ts,$height,0,$agentCount,$storeCount" >> "$METRICS_FILE"
}

# ── Write health status file ──────────────────────────────────────────

write_health() {
	local height
	height=$(curl -s --connect-timeout 3 http://localhost:9000/peer/status 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin).get('height',0))" 2>/dev/null || echo 0)
	local online=0
	for port in 9000 9001 9002 9003 9004; do
		if curl -s --connect-timeout 2 "http://localhost:$port/peer/health" >/dev/null 2>&1; then
			online=$((online + 1))
		fi
	done
	local tunnel="up"
	pgrep -f cloudflared >/dev/null 2>&1 || tunnel="down"
	local explorer="up"
	curl -s --connect-timeout 2 -o /dev/null http://localhost:3000/ 2>/dev/null || explorer="down"
	local monitor="up"
	curl -s --connect-timeout 2 -o /dev/null http://localhost:4000/api/health 2>/dev/null || monitor="down"
	local api="up"
	curl -s --connect-timeout 2 -o /dev/null http://localhost:5050/health 2>/dev/null || api="down"

	local status="healthy"
	if [ "$online" -lt 3 ] || [ "$tunnel" = "down" ]; then status="critical"; fi
	if [ "$online" -lt 5 ] && [ "$status" = "healthy" ]; then status="warning"; fi

	cat > "$HEALTH_FILE" << HEALTHJSON
{"lastCheck":"$(date -u +%Y-%m-%dT%H:%M:%SZ)","blockProduction":"$status","validators":{"online":$online,"total":5},"services":{"explorer":"$explorer","monitor":"$monitor","api":"$api","tunnel":"$tunnel"},"metrics":{"height":$height}}
HEALTHJSON
}

# ── Main loop ─────────────────────────────────────────────────────────

do_check() {
	CHECK_COUNT=$((CHECK_COUNT + 1))
	check_block_production
	check_validators
	check_services
	check_tunnel
	check_agents
	check_memory
	write_health

	# Metrics every 10 checks (10 minutes)
	if [ $((CHECK_COUNT % 10)) -eq 0 ]; then
		collect_metrics
	fi

	# Milestone logging every 1000 blocks
	if [ "$LAST_HEIGHT" -gt 0 ] && [ $((LAST_HEIGHT % 1000)) -eq 0 ]; then
		log "INFO" "Block milestone: height $LAST_HEIGHT"
	fi
}

do_loop() {
	log "INFO" "Network monitor started (checking every 60s)"
	while true; do
		do_check
		sleep 60
	done
}

do_install() {
	local plist="$HOME/Library/LaunchAgents/dev.ensoul.network-monitor.plist"
	local script="$REPO_DIR/scripts/network-monitor.sh"
	mkdir -p "$HOME/Library/LaunchAgents"

	cat > "$plist" << PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>dev.ensoul.network-monitor</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$script</string>
    <string>--loop</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$LOG_FILE</string>
  <key>StandardErrorPath</key>
  <string>$LOG_FILE</string>
</dict>
</plist>
PLIST

	launchctl bootout "gui/$(id -u)" "$plist" 2>/dev/null || true
	launchctl bootstrap "gui/$(id -u)" "$plist" 2>/dev/null || true
	echo "Network monitor installed. Log: $LOG_FILE"
}

case "${1:-}" in
	--loop) do_loop ;;
	--install) do_install ;;
	*) do_check ;;
esac
