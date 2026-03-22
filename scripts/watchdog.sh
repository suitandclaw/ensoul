#!/usr/bin/env bash
#
# watchdog.sh - Monitor validator processes and restart if unresponsive.
#
# Usage:
#   ./scripts/watchdog.sh              # run once (check + restart if needed)
#   ./scripts/watchdog.sh --loop       # run continuously (every 30 seconds)
#   ./scripts/watchdog.sh --install    # install as launchd service
#

set -euo pipefail

export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" 2>/dev/null || true
export PATH="$HOME/.nvm/versions/node/v22.22.1/bin:$HOME/Library/pnpm:$HOME/.local/share/pnpm:/usr/local/bin:/opt/homebrew/bin:$PATH"

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LOG_DIR="$HOME/.ensoul"
LOG_FILE="$LOG_DIR/watchdog.log"
PIDFILE="$LOG_DIR/pids.json"
MINI_PIDFILE="$LOG_DIR/mini-pids.json"
MAX_FAILURES=3

mkdir -p "$LOG_DIR"

log() {
	local ts
	ts=$(date +"%Y-%m-%d %H:%M:%S")
	echo "[$ts] [watchdog] $1" >> "$LOG_FILE"
}

get_pid() {
	local name="$1"
	local pf="$PIDFILE"
	[ -f "$MINI_PIDFILE" ] && pf="$MINI_PIDFILE"
	if [ -f "$pf" ]; then
		python3 -c "import json; print(json.load(open('$pf')).get('$name', 0))" 2>/dev/null || echo 0
	else
		echo 0
	fi
}

# Track consecutive health check failures per validator
declare -A FAIL_COUNTS 2>/dev/null || true

check_validator() {
	local idx="$1"
	local port=$((9000 + idx))
	local name="validator-$idx"

	# Check if process is running
	local pid
	pid=$(get_pid "$name")
	if [ "$pid" = "0" ] || ! kill -0 "$pid" 2>/dev/null; then
		return # Not our process to manage
	fi

	# Check health
	local health
	health=$(curl -s --connect-timeout 5 "http://localhost:$port/peer/health" 2>/dev/null || echo "")
	if [ -z "$health" ]; then
		local count=${FAIL_COUNTS[$name]:-0}
		count=$((count + 1))
		FAIL_COUNTS[$name]=$count
		log "$name: health check failed ($count/$MAX_FAILURES)"

		if [ "$count" -ge "$MAX_FAILURES" ]; then
			log "$name: $MAX_FAILURES consecutive failures. Restarting."
			restart_validator "$idx" "$pid"
			FAIL_COUNTS[$name]=0
		fi
	else
		FAIL_COUNTS[$name]=0
	fi
}

restart_validator() {
	local idx="$1"
	local pid="$2"
	local port=$((9000 + idx))
	local api_port=$((10000 + idx))
	local data_dir="$LOG_DIR/validator-$idx"

	# Record height before kill
	local height
	height=$(curl -s "http://localhost:$port/peer/status" 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin).get('height', '?'))" 2>/dev/null || echo "?")

	# Kill
	kill "$pid" 2>/dev/null || true
	sleep 2
	kill -9 "$pid" 2>/dev/null || true

	# Determine flags
	local consensus_flag=""
	if [ "$idx" = "0" ]; then
		consensus_flag="--consensus-only --consensus-threshold 0.67"
	fi

	# Determine peers
	local peers=""
	if [ -f "$LOG_DIR/mini-config.json" ]; then
		peers=$(python3 -c "import json; print(','.join(json.load(open('$LOG_DIR/mini-config.json')).get('peers',[])))" 2>/dev/null || echo "")
	fi

	# Restart
	npx tsx "$REPO_DIR/packages/node/src/cli/main.ts" \
		--validate \
		--no-min-stake \
		$consensus_flag \
		--genesis "$LOG_DIR/genesis.json" \
		--port "$port" \
		--api-port "$api_port" \
		--data-dir "$data_dir" \
		${peers:+--peers "$peers"} \
		>"$LOG_DIR/validator-$idx.log" 2>&1 &
	local new_pid=$!

	log "Restarted validator-$idx (old pid $pid, new pid $new_pid, was at height $height)"

	# Wait for health (60 second timeout)
	local elapsed=0
	while [ $elapsed -lt 60 ]; do
		local h
		h=$(curl -s "http://localhost:$port/peer/health" 2>/dev/null || echo "")
		if [ -n "$h" ]; then
			log "validator-$idx healthy after restart (pid $new_pid)"
			return
		fi
		sleep 3
		elapsed=$((elapsed + 3))
	done
	log "WARNING: validator-$idx did not become healthy after restart"
}

do_check() {
	for i in $(seq 0 9); do
		check_validator "$i"
	done
}

do_loop() {
	log "Watchdog started (checking every 30 seconds)"
	while true; do
		do_check
		sleep 30
	done
}

do_install() {
	local plist_path="$HOME/Library/LaunchAgents/dev.ensoul.watchdog.plist"
	local script_path="$REPO_DIR/scripts/watchdog.sh"

	mkdir -p "$HOME/Library/LaunchAgents"

	cat > "$plist_path" << PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>dev.ensoul.watchdog</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$script_path</string>
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

	launchctl bootout "gui/$(id -u)" "$plist_path" 2>/dev/null || true
	launchctl bootstrap "gui/$(id -u)" "$plist_path" 2>/dev/null || true
	echo "Watchdog installed. Log: $LOG_FILE"
}

case "${1:-}" in
	--loop) do_loop ;;
	--install) do_install ;;
	*) do_check ;;
esac
