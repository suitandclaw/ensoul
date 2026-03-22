#!/usr/bin/env bash
#
# start-mini.sh - Startup script for Ensoul validators on a Mac Mini.
#
# Starts a cloudflared tunnel and 10 validators on sequential ports.
#
# Usage:
#   ./scripts/start-mini.sh <tunnel-name> <peer-urls>
#   ./scripts/start-mini.sh mini-1 "https://v0.ensoul.dev,https://v2.ensoul.dev,https://v3.ensoul.dev"
#
#   ./scripts/start-mini.sh stop          # stop all services
#   ./scripts/start-mini.sh status        # check all services
#

set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LOG_DIR="$HOME/.ensoul"
PIDFILE="$LOG_DIR/mini-pids.json"
NUM_VALIDATORS=10
BASE_PORT=9000
BASE_API_PORT=10000

mkdir -p "$LOG_DIR"

log() { echo "[$(date +%H:%M:%S)] $1"; }

save_pid() {
	local name="$1" pid="$2"
	local tmp
	tmp=$(mktemp)
	if [ -f "$PIDFILE" ]; then
		python3 -c "
import json
d = json.load(open('$PIDFILE'))
d['$name'] = $pid
json.dump(d, open('$tmp','w'))
" 2>/dev/null || echo "{\"$name\": $pid}" > "$tmp"
	else
		echo "{\"$name\": $pid}" > "$tmp"
	fi
	mv "$tmp" "$PIDFILE"
}

get_pid() {
	local name="$1"
	if [ -f "$PIDFILE" ]; then
		python3 -c "import json; print(json.load(open('$PIDFILE')).get('$name', 0))" 2>/dev/null || echo 0
	else
		echo 0
	fi
}

is_alive() {
	local pid="$1"
	[ "$pid" != "0" ] && kill -0 "$pid" 2>/dev/null
}

kill_service() {
	local name="$1"
	local pid
	pid=$(get_pid "$name")
	if is_alive "$pid"; then
		kill "$pid" 2>/dev/null || true
		sleep 1
		kill -9 "$pid" 2>/dev/null || true
		log "Stopped $name (pid $pid)"
	fi
}

# ── Stop ──────────────────────────────────────────────────────────────

do_stop() {
	log "Stopping all services..."
	for i in $(seq 0 $((NUM_VALIDATORS - 1))); do
		kill_service "validator-$i"
	done
	kill_service "tunnel"
	log "All services stopped."
}

# ── Status ────────────────────────────────────────────────────────────

do_status() {
	echo ""
	echo "  Service            PID        Port    Status"
	echo "  -------            ---        ----    ------"
	local pid
	pid=$(get_pid "tunnel")
	if is_alive "$pid"; then
		echo "  tunnel             $pid        443     running"
	else
		echo "  tunnel             -           443     stopped"
	fi
	for i in $(seq 0 $((NUM_VALIDATORS - 1))); do
		local name="validator-$i"
		local port=$((BASE_PORT + i))
		pid=$(get_pid "$name")
		if is_alive "$pid"; then
			echo "  $name$(printf '%*s' $((20 - ${#name})) '')$pid$(printf '%*s' $((11 - ${#pid})) '')$port    running"
		else
			echo "  $name$(printf '%*s' $((20 - ${#name})) '')-$(printf '%*s' 10 '')$port    stopped"
		fi
	done
	echo ""
}

# ── Start ─────────────────────────────────────────────────────────────

do_start() {
	local tunnel_name="$1"
	local peers="$2"

	# Pull latest code and rebuild before starting
	log "Checking for updates..."
	if [ -f "$REPO_DIR/scripts/auto-update.sh" ]; then
		cd "$REPO_DIR"
		git fetch origin main --quiet 2>/dev/null || true
		LOCAL=$(git rev-parse HEAD 2>/dev/null || echo "")
		REMOTE=$(git rev-parse origin/main 2>/dev/null || echo "")
		if [ -n "$LOCAL" ] && [ -n "$REMOTE" ] && [ "$LOCAL" != "$REMOTE" ]; then
			log "New commits found. Pulling and rebuilding..."
			git pull origin main --quiet 2>/dev/null || true
			pnpm build >> "$LOG_DIR/auto-update.log" 2>&1 || log "Build failed, continuing with current version"
		else
			log "Code is up to date."
		fi
	fi

	log "Starting Ensoul Mac Mini: tunnel=$tunnel_name, validators=$NUM_VALIDATORS"
	echo ""

	# 1. Cloudflared tunnel
	log "Starting tunnel ($tunnel_name)..."
	if command -v cloudflared >/dev/null 2>&1; then
		cloudflared tunnel run "$tunnel_name" \
			>"$LOG_DIR/tunnel.log" 2>&1 &
		save_pid "tunnel" $!
		log "Tunnel started (pid $!)"
		sleep 2
	else
		log "ERROR: cloudflared not installed"
		exit 1
	fi

	# 2. Validators
	for i in $(seq 0 $((NUM_VALIDATORS - 1))); do
		local port=$((BASE_PORT + i))
		local api_port=$((BASE_API_PORT + i))
		local data_dir="$LOG_DIR/validator-$i"
		mkdir -p "$data_dir"

		log "Starting validator-$i on port $port..."
		# Only validator-0 (port 9000) participates in consensus
		# MBP validator-0 is the designated bootstrap validator
		local consensus_flag=""
		if [ "$i" = "0" ]; then
			consensus_flag="--consensus-only --consensus-threshold 0.1 --bootstrap-validator did:key:z6MkiewFKEurCmchb4HV98oD3Rjbw4yqxQGnivYJ6otzLF7X"
		fi

		npx tsx "$REPO_DIR/packages/node/src/cli/main.ts" \
			--validate \
			--no-min-stake \
			$consensus_flag \
			--genesis "$LOG_DIR/genesis.json" \
			--port "$port" \
			--api-port "$api_port" \
			--data-dir "$data_dir" \
			--peers "$peers" \
			>"$LOG_DIR/validator-$i.log" 2>&1 &
		save_pid "validator-$i" $!
	done

	sleep 3
	log "All $NUM_VALIDATORS validators started."

	do_status

	echo "  Logs:"
	for i in $(seq 0 $((NUM_VALIDATORS - 1))); do
		echo "    tail -f $LOG_DIR/validator-$i.log"
	done
	echo "    tail -f $LOG_DIR/tunnel.log"
	echo ""
}

# ── Main ──────────────────────────────────────────────────────────────

case "${1:-}" in
	stop)    do_stop ;;
	status)  do_status ;;
	restart)
		do_stop
		sleep 2
		if [ -z "${2:-}" ] || [ -z "${3:-}" ]; then
			echo "Usage for restart: $0 restart <tunnel-name> <peer-urls>"
			exit 1
		fi
		do_start "$2" "$3"
		;;
	"")
		echo "Usage:"
		echo "  $0 <tunnel-name> <peer-urls>    Start tunnel + 10 validators"
		echo "  $0 stop                         Stop all services"
		echo "  $0 status                       Check all services"
		echo ""
		echo "Example:"
		echo "  $0 mini-1 \"https://v0.ensoul.dev,https://v2.ensoul.dev,https://v3.ensoul.dev\""
		exit 1
		;;
	*)
		if [ -z "${2:-}" ]; then
			echo "Usage: $0 <tunnel-name> <peer-urls>"
			echo "Example: $0 mini-1 \"https://v0.ensoul.dev,https://v2.ensoul.dev,https://v3.ensoul.dev\""
			exit 1
		fi
		do_start "$1" "$2"
		;;
esac
