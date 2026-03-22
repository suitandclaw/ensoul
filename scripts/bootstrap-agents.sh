#!/usr/bin/env bash
#
# bootstrap-agents.sh - Register 587 AI agents on the Ensoul network.
#
# Usage:
#   ./scripts/bootstrap-agents.sh              # Register + initial store + heartbeat
#   ./scripts/bootstrap-agents.sh --generate   # Generate identities only
#   ./scripts/bootstrap-agents.sh --register   # Register only (skip if done)
#   ./scripts/bootstrap-agents.sh --store      # Initial consciousness store only
#   ./scripts/bootstrap-agents.sh --heartbeat  # Run heartbeat loop only
#   ./scripts/bootstrap-agents.sh --stats      # Show stats
#   ./scripts/bootstrap-agents.sh --install    # Install heartbeat as launchd service
#

set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
AGENT_DIR="$HOME/.ensoul/bootstrap-agents"
LOG_FILE="$HOME/.ensoul/bootstrap-agents.log"
API="https://api.ensoul.dev"
TOTAL_AGENTS=587

mkdir -p "$AGENT_DIR"

log() {
	local ts
	ts=$(date +"%Y-%m-%d %H:%M:%S")
	echo "[$ts] $1" | tee -a "$LOG_FILE"
}

# ── Agent type definitions ────────────────────────────────────────────

AGENT_TYPES=(
	"research-agent"
	"trading-bot"
	"analyst-agent"
	"data-collector"
	"sentiment-tracker"
	"portfolio-manager"
	"news-monitor"
	"code-reviewer"
	"market-maker"
	"risk-assessor"
	"signal-processor"
	"content-curator"
	"audit-agent"
	"compliance-bot"
	"forecast-engine"
)

get_agent_type() {
	local idx=$1
	local type_idx=$((idx % ${#AGENT_TYPES[@]}))
	echo "${AGENT_TYPES[$type_idx]}"
}

get_agent_name() {
	local idx=$1
	local type
	type=$(get_agent_type "$idx")
	printf "%s-%03d" "$type" "$idx"
}

# ── Generate identities ──────────────────────────────────────────────

do_generate() {
	log "Generating $TOTAL_AGENTS agent identities..."
	cd "$REPO_DIR"
	npx tsx scripts/generate-agent-identities.ts 2>&1 | tee -a "$LOG_FILE"
	log "Identity generation complete."
}

# ── Register agents ───────────────────────────────────────────────────

do_register() {
	log "Registering agents with API..."

	local registered=0
	local skipped=0
	local failed=0

	for f in "$AGENT_DIR"/*.json; do
		[ -f "$f" ] || continue

		local is_registered
		is_registered=$(python3 -c "import json; print(json.load(open('$f')).get('registered', False))" 2>/dev/null || echo "False")
		if [ "$is_registered" = "True" ]; then
			skipped=$((skipped + 1))
			continue
		fi

		local did publicKey name
		did=$(python3 -c "import json; print(json.load(open('$f'))['did'])")
		publicKey=$(python3 -c "import json; print(json.load(open('$f'))['publicKey'])")
		name=$(python3 -c "import json; print(json.load(open('$f'))['name'])")

		local resp
		resp=$(curl -s -X POST "$API/v1/agents/register" \
			-H "Content-Type: application/json" \
			-d "{\"did\":\"$did\",\"publicKey\":\"$publicKey\"}" \
			2>/dev/null || echo "{}")

		local reg_ok
		reg_ok=$(echo "$resp" | python3 -c "import sys,json; print(json.load(sys.stdin).get('registered', False))" 2>/dev/null || echo "False")

		if [ "$reg_ok" = "True" ]; then
			# Mark as registered
			python3 -c "
import json
d = json.load(open('$f'))
d['registered'] = True
json.dump(d, open('$f', 'w'), indent=2)
"
			registered=$((registered + 1))
		else
			failed=$((failed + 1))
		fi

		local total=$((registered + skipped + failed))
		if [ $((total % 50)) -eq 0 ]; then
			log "Registration progress: $total/$TOTAL_AGENTS (registered=$registered, skipped=$skipped, failed=$failed)"
		fi

		# Rate limit: 5 per second
		if [ $((registered % 5)) -eq 0 ]; then
			sleep 1
		fi
	done

	log "Registration complete: $registered new, $skipped already registered, $failed failed."
}

# ── Store initial consciousness ───────────────────────────────────────

do_store() {
	log "Storing initial consciousness for agents..."

	local stored=0
	local skipped=0

	for f in "$AGENT_DIR"/*.json; do
		[ -f "$f" ] || continue

		local is_stored
		is_stored=$(python3 -c "import json; print(json.load(open('$f')).get('stored', False))" 2>/dev/null || echo "False")
		if [ "$is_stored" = "True" ]; then
			skipped=$((skipped + 1))
			continue
		fi

		local did name agent_type
		did=$(python3 -c "import json; print(json.load(open('$f'))['did'])")
		name=$(python3 -c "import json; print(json.load(open('$f'))['name'])")
		agent_type=$(python3 -c "import json; print(json.load(open('$f'))['type'])")

		local version=1
		local state_root
		state_root=$(python3 -c "import hashlib; print(hashlib.sha256('$did-v$version'.encode()).hexdigest())")

		local resp
		resp=$(curl -s -X POST "$API/v1/consciousness/store" \
			-H "Content-Type: application/json" \
			-d "{\"did\":\"$did\",\"stateRoot\":\"$state_root\",\"version\":$version,\"encryptedShards\":[]}" \
			2>/dev/null || echo "{}")

		local store_ok
		store_ok=$(echo "$resp" | python3 -c "import sys,json; print(json.load(sys.stdin).get('stored', False))" 2>/dev/null || echo "False")

		if [ "$store_ok" = "True" ]; then
			python3 -c "
import json, time
d = json.load(open('$f'))
d['stored'] = True
d['storeCount'] = 1
d['lastStore'] = int(time.time())
json.dump(d, open('$f', 'w'), indent=2)
"
			stored=$((stored + 1))
		fi

		local total=$((stored + skipped))
		if [ $((total % 50)) -eq 0 ]; then
			log "Store progress: $total/$TOTAL_AGENTS (stored=$stored, skipped=$skipped)"
		fi

		# Rate limit: 3 per second
		if [ $((stored % 3)) -eq 0 ]; then
			sleep 1
		fi
	done

	log "Initial store complete: $stored new, $skipped already stored."
}

# ── Heartbeat loop ────────────────────────────────────────────────────

do_heartbeat() {
	log "Starting heartbeat loop (50 agents every 10 minutes)..."

	while true; do
		# Select 50 random agent files
		local files
		files=$(ls "$AGENT_DIR"/*.json 2>/dev/null | sort -R | head -50)
		local updated=0

		for f in $files; do
			[ -f "$f" ] || continue

			local did store_count
			did=$(python3 -c "import json; print(json.load(open('$f'))['did'])" 2>/dev/null || continue)
			store_count=$(python3 -c "import json; print(json.load(open('$f')).get('storeCount', 0))" 2>/dev/null || echo "0")

			local version=$((store_count + 1))
			local state_root
			state_root=$(python3 -c "import hashlib; print(hashlib.sha256('$did-v$version'.encode()).hexdigest())")

			local resp
			resp=$(curl -s -X POST "$API/v1/consciousness/store" \
				-H "Content-Type: application/json" \
				-d "{\"did\":\"$did\",\"stateRoot\":\"$state_root\",\"version\":$version,\"encryptedShards\":[]}" \
				2>/dev/null || echo "{}")

			local store_ok
			store_ok=$(echo "$resp" | python3 -c "import sys,json; print(json.load(sys.stdin).get('stored', False))" 2>/dev/null || echo "False")

			if [ "$store_ok" = "True" ]; then
				python3 -c "
import json, time
d = json.load(open('$f'))
d['storeCount'] = $version
d['lastStore'] = int(time.time())
json.dump(d, open('$f', 'w'), indent=2)
"
				updated=$((updated + 1))
			fi

			# Rate limit
			if [ $((updated % 3)) -eq 0 ]; then
				sleep 1
			fi
		done

		# Get current height
		local height
		height=$(curl -s http://localhost:9000/peer/status 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin).get('height', '?'))" 2>/dev/null || echo "?")

		log "Heartbeat: updated $updated/50 agents at height $height"

		sleep 600 # 10 minutes
	done
}

# ── Stats ─────────────────────────────────────────────────────────────

do_stats() {
	local total=0
	local registered=0
	local stored=0
	local total_stores=0
	local last_heartbeat=0

	for f in "$AGENT_DIR"/*.json; do
		[ -f "$f" ] || continue
		total=$((total + 1))

		local is_reg is_stored sc ls
		is_reg=$(python3 -c "import json; print(json.load(open('$f')).get('registered', False))" 2>/dev/null || echo "False")
		is_stored=$(python3 -c "import json; print(json.load(open('$f')).get('stored', False))" 2>/dev/null || echo "False")
		sc=$(python3 -c "import json; print(json.load(open('$f')).get('storeCount', 0))" 2>/dev/null || echo "0")
		ls=$(python3 -c "import json; print(json.load(open('$f')).get('lastStore', 0))" 2>/dev/null || echo "0")

		[ "$is_reg" = "True" ] && registered=$((registered + 1))
		[ "$is_stored" = "True" ] && stored=$((stored + 1))
		total_stores=$((total_stores + sc))
		[ "$ls" -gt "$last_heartbeat" ] && last_heartbeat=$ls
	done

	local last_time="never"
	if [ "$last_heartbeat" -gt 0 ]; then
		last_time=$(date -r "$last_heartbeat" 2>/dev/null || date -d "@$last_heartbeat" 2>/dev/null || echo "$last_heartbeat")
	fi

	echo ""
	echo "  Bootstrap Agents Stats"
	echo "  ====================="
	echo "  Total identities:      $total"
	echo "  Registered:            $registered"
	echo "  Initial store done:    $stored"
	echo "  Pending bonus:         $((registered - stored))"
	echo "  Total consciousness:   $total_stores stores"
	echo "  Last heartbeat:        $last_time"
	echo ""
}

# ── Install heartbeat service ─────────────────────────────────────────

do_install() {
	local plist_path="$HOME/Library/LaunchAgents/dev.ensoul.bootstrap-agents.plist"
	local script_path="$REPO_DIR/scripts/bootstrap-agents.sh"

	mkdir -p "$HOME/Library/LaunchAgents"

	cat > "$plist_path" << PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>dev.ensoul.bootstrap-agents</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$script_path</string>
    <string>--heartbeat</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$LOG_FILE</string>
  <key>StandardErrorPath</key>
  <string>$LOG_FILE</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>$HOME</string>
    <key>PATH</key>
    <string>/usr/local/bin:/usr/bin:/bin</string>
  </dict>
</dict>
</plist>
PLIST

	# Unload existing
	launchctl bootout "gui/$(id -u)" "$plist_path" 2>/dev/null || true
	launchctl bootstrap "gui/$(id -u)" "$plist_path" 2>/dev/null || true

	log "Heartbeat service installed: $plist_path"
	echo "Heartbeat installed. It will run continuously, updating 50 agents every 10 minutes."
	echo "Log: $LOG_FILE"
}

# ── Main ──────────────────────────────────────────────────────────────

case "${1:-}" in
	--generate)   do_generate ;;
	--register)   do_register ;;
	--store)      do_store ;;
	--heartbeat)  do_heartbeat ;;
	--stats)      do_stats ;;
	--install)    do_install ;;
	"")
		# Full bootstrap: generate, register, store, then heartbeat
		do_generate
		do_register
		do_store
		do_heartbeat
		;;
	*)
		echo "Usage: $0 [--generate|--register|--store|--heartbeat|--stats|--install]"
		exit 1
		;;
esac
