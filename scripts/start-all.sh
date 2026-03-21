#!/usr/bin/env bash
#
# start-all.sh - Master startup script for the Ensoul network on MacBook Pro.
#
# Starts all services in dependency order:
#   1. Cloudflared tunnel
#   2. Validator (port 9000)
#   3. Explorer (port 3000)
#   4. Monitor (port 4000)
#   5. Twitter Agent
#
# Usage:
#   ./scripts/start-all.sh            # start everything
#   ./scripts/start-all.sh stop       # stop everything
#   ./scripts/start-all.sh status     # check all services
#   ./scripts/start-all.sh restart    # stop then start
#

set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LOG_DIR="$HOME/.ensoul"
AGENT_DIR="$HOME/ensoul-agent"
PIDFILE="$LOG_DIR/pids.json"

# Peer URLs for the Mac Mini validators
export ENSOUL_PEERS="https://v1.ensoul.dev,https://v2.ensoul.dev,https://v3.ensoul.dev"
export ENSOUL_VALIDATOR_COUNT=35

mkdir -p "$LOG_DIR"

# ── Helpers ───────────────────────────────────────────────────────────

log() { echo "[$(date +%H:%M:%S)] $1"; }

save_pid() {
	local name="$1" pid="$2"
	local tmp
	tmp=$(mktemp)
	if [ -f "$PIDFILE" ]; then
		python3 -c "
import json,sys
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

wait_for_port() {
	local port="$1" timeout="${2:-10}" name="${3:-service}"
	local elapsed=0
	while [ $elapsed -lt "$timeout" ]; do
		if curl -s -o /dev/null "http://localhost:$port" 2>/dev/null; then
			return 0
		fi
		sleep 1
		elapsed=$((elapsed + 1))
	done
	log "WARNING: $name on port $port not responding after ${timeout}s"
	return 1
}

# ── Stop ──────────────────────────────────────────────────────────────

do_stop() {
	log "Stopping all services..."
	kill_service "moltbook"
	kill_service "agent"
	kill_service "api"
	kill_service "monitor"
	kill_service "explorer"
	for i in 0 1 2 3 4; do
		kill_service "validator-$i"
	done
	kill_service "tunnel"
	# Also kill by port as fallback
	for port in 9000 9001 9002 9003 9004 3000 4000 5050; do
		lsof -ti ":$port" 2>/dev/null | xargs kill 2>/dev/null || true
	done
	log "All services stopped."
}

# ── Status ────────────────────────────────────────────────────────────

do_status() {
	echo ""
	echo "  Service          PID        Port    Status"
	echo "  -------          ---        ----    ------"

	# Fixed services
	for entry in "tunnel:443" "explorer:3000" "monitor:4000" "api:5050" "agent:-" "moltbook:-"; do
		local name="${entry%%:*}"
		local port="${entry##*:}"
		local pid
		pid=$(get_pid "$name")
		if is_alive "$pid"; then
			echo "  $name$(printf '%*s' $((18 - ${#name})) '')$pid$(printf '%*s' $((11 - ${#pid})) '')$port$(printf '%*s' $((8 - ${#port})) '')running"
		else
			echo "  $name$(printf '%*s' $((18 - ${#name})) '')-$(printf '%*s' 10 '')$port$(printf '%*s' $((8 - ${#port})) '')stopped"
		fi
	done

	# Validators
	for i in 0 1 2 3 4; do
		local name="validator-$i"
		local port=$((9000 + i))
		local pid
		pid=$(get_pid "$name")
		if is_alive "$pid"; then
			echo "  $name$(printf '%*s' $((18 - ${#name})) '')$pid$(printf '%*s' $((11 - ${#pid})) '')$port$(printf '%*s' $((8 - ${#port})) '')running"
		else
			echo "  $name$(printf '%*s' $((18 - ${#name})) '')-$(printf '%*s' 10 '')$port$(printf '%*s' $((8 - ${#port})) '')stopped"
		fi
	done
	echo ""
}

# ── Start ─────────────────────────────────────────────────────────────

do_start() {
	log "Starting Ensoul network services..."
	echo ""

	# 1. Cloudflared tunnel
	log "Starting tunnel (cloudflared)..."
	if command -v cloudflared >/dev/null 2>&1; then
		cloudflared tunnel run ensoul \
			>"$LOG_DIR/tunnel.log" 2>&1 &
		save_pid "tunnel" $!
		log "Tunnel started (pid $!)"
		sleep 2
	else
		log "WARNING: cloudflared not installed, skipping tunnel"
	fi

	# 2. Validators (5 on ports 9000-9004)
	for i in 0 1 2 3 4; do
		local vport=$((9000 + i))
		local aport=$((10000 + i))
		local vdir="$LOG_DIR/validator-$i"
		mkdir -p "$vdir"

		# Validator 0 peers to remote tunnels + local validators
		# Validators 1-4 peer to validator 0
		local vpeers
		if [ "$i" = "0" ]; then
			vpeers="$ENSOUL_PEERS,localhost:9001,localhost:9002,localhost:9003,localhost:9004"
		else
			vpeers="localhost:9000"
		fi

		log "Starting validator-$i on port $vport..."
		npx tsx "$REPO_DIR/packages/node/src/cli/main.ts" \
			--validate \
			--no-min-stake \
			--consensus-threshold 0.3 \
			--genesis "$LOG_DIR/genesis.json" \
			--port "$vport" \
			--api-port "$aport" \
			--data-dir "$vdir" \
			--peers "$vpeers" \
			>"$LOG_DIR/validator-$i.log" 2>&1 &
		save_pid "validator-$i" $!
		log "Validator-$i started (pid $!)"

		# Wait for first validator before starting others
		if [ "$i" = "0" ]; then
			wait_for_port 9000 15 "validator-0" || true
		fi
	done
	sleep 2

	# 3. Explorer
	log "Starting explorer on port 3000..."
	ENSOUL_PEERS="$ENSOUL_PEERS" \
	ENSOUL_VALIDATOR_COUNT="$ENSOUL_VALIDATOR_COUNT" \
	npx tsx "$REPO_DIR/packages/explorer/start.ts" \
		--port 3000 \
		--network-peers "https://v0.ensoul.dev,$ENSOUL_PEERS" \
		>"$LOG_DIR/explorer.log" 2>&1 &
	save_pid "explorer" $!
	log "Explorer started (pid $!)"
	wait_for_port 3000 15 "explorer" || true

	# 4. Monitor
	# Monitor dashboard password (change this for production)
	local monitor_pw="${ENSOUL_STATUS_PASSWORD:-ensoul-status-2026}"
	log "Starting monitor on port 4000..."
	ENSOUL_STATUS_PASSWORD="$monitor_pw" \
	npx tsx "$REPO_DIR/packages/monitor/start.ts" \
		--port 4000 \
		>"$LOG_DIR/monitor.log" 2>&1 &
	save_pid "monitor" $!
	log "Monitor started (pid $!)"
	wait_for_port 4000 10 "monitor" || true

	# 5. API Gateway
	log "Starting API gateway on port 5050..."
	ONBOARDING_KEY_PATH="$REPO_DIR/genesis-keys/onboarding.json" \
	TREASURY_KEY_PATH="$REPO_DIR/genesis-keys/treasury.json" \
	npx tsx "$REPO_DIR/packages/api/start.ts" \
		--port 5050 \
		>"$LOG_DIR/api.log" 2>&1 &
	save_pid "api" $!
	log "API gateway started (pid $!)"
	wait_for_port 5050 10 "api" || true

	# 6. Twitter Agent
	if [ -d "$AGENT_DIR/src" ] && [ -f "$AGENT_DIR/.env" ]; then
		log "Starting Twitter agent..."
		cd "$AGENT_DIR" && npx tsx src/agent.ts \
			>"$LOG_DIR/agent.log" 2>&1 &
		save_pid "agent" $!
		cd "$REPO_DIR"
		log "Agent started (pid $!)"
	else
		log "Skipping Twitter agent ($AGENT_DIR/.env not found)"
	fi

	# 8. Moltbook Agent
	MOLTBOOK_DIR="$HOME/ensoul-moltbook-agent"
	if [ -d "$MOLTBOOK_DIR/src" ] && [ -f "$MOLTBOOK_DIR/.env" ]; then
		log "Starting Moltbook agent..."
		cd "$MOLTBOOK_DIR" && npx tsx src/agent.ts \
			>"$LOG_DIR/moltbook-agent.log" 2>&1 &
		save_pid "moltbook" $!
		cd "$REPO_DIR"
		log "Moltbook agent started (pid $!)"
	else
		log "Skipping Moltbook agent ($MOLTBOOK_DIR/.env not found)"
	fi

	echo ""
	log "All services started."
	do_status

	echo "  Logs:"
	for i in 0 1 2 3 4; do
		echo "    tail -f $LOG_DIR/validator-$i.log"
	done
	echo "    tail -f $LOG_DIR/explorer.log"
	echo "    tail -f $LOG_DIR/monitor.log"
	echo "    tail -f $LOG_DIR/api.log"
	echo "    tail -f $LOG_DIR/tunnel.log"
	echo "    tail -f $LOG_DIR/agent.log"
	echo ""
	echo "  URLs:"
	echo "    Explorer:   http://localhost:3000"
	echo "    Monitor:    http://localhost:4000"
	echo "    API:        http://localhost:5050"
	echo "    Validators: http://localhost:9000-9004/peer/status"
	echo ""
}

# ── Main ──────────────────────────────────────────────────────────────

case "${1:-start}" in
	start)   do_start ;;
	stop)    do_stop ;;
	status)  do_status ;;
	restart) do_stop; sleep 2; do_start ;;
	*)       echo "Usage: $0 {start|stop|status|restart}"; exit 1 ;;
esac
