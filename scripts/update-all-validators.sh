#!/usr/bin/env bash
#
# update-all-validators.sh - Trigger update on all validators in the network.
#
# Sends POST /peer/update to each validator sequentially, waits for it
# to come back healthy before moving to the next.
#
# Usage:
#   ./scripts/update-all-validators.sh
#   ENSOUL_PEER_KEY=xxx ./scripts/update-all-validators.sh
#

set -uo pipefail

PEER_KEY="${ENSOUL_PEER_KEY:-}"
CLOUD_FILE="$HOME/.ensoul/cloud-validators.txt"

# Tunnel endpoints
TUNNELS=(
	"https://v0.ensoul.dev"
	"https://v1.ensoul.dev"
	"https://v2.ensoul.dev"
	"https://v3.ensoul.dev"
)

if [ -z "$PEER_KEY" ]; then
	# Try to read from saved key file
	if [ -f "$HOME/.ensoul/pioneer-key.txt" ]; then
		PEER_KEY=$(cat "$HOME/.ensoul/pioneer-key.txt")
	else
		echo "Set ENSOUL_PEER_KEY or create ~/.ensoul/pioneer-key.txt"
		exit 1
	fi
fi

echo ""
echo "=== UPDATE ALL VALIDATORS ==="
echo ""

TOTAL=0
UPDATED=0
FAILED=0

update_validator() {
	local url="$1"
	local name="$2"
	TOTAL=$((TOTAL + 1))

	echo -n "  [$TOTAL] $name ($url)... "

	# Get current version
	local current
	current=$(curl -s --connect-timeout 5 "$url/peer/health" 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin).get('version','?'))" 2>/dev/null || echo "offline")

	if [ "$current" = "offline" ]; then
		echo "OFFLINE (skipping)"
		FAILED=$((FAILED + 1))
		return
	fi

	# Trigger update
	local resp
	resp=$(curl -s --connect-timeout 10 -X POST "$url/peer/update" \
		-H "X-Ensoul-Peer-Key: $PEER_KEY" \
		-H "Content-Type: application/json" \
		2>/dev/null || echo "")

	if [ -z "$resp" ]; then
		echo "FAILED (no response)"
		FAILED=$((FAILED + 1))
		return
	fi

	echo "triggered (was $current)"

	# Wait for validator to come back (up to 5 minutes)
	echo -n "    waiting for restart... "
	local elapsed=0
	while [ $elapsed -lt 300 ]; do
		sleep 10
		elapsed=$((elapsed + 10))
		local health
		health=$(curl -s --connect-timeout 5 "$url/peer/health" 2>/dev/null || echo "")
		if [ -n "$health" ]; then
			local new_version
			new_version=$(echo "$health" | python3 -c "import sys,json; print(json.load(sys.stdin).get('version','?'))" 2>/dev/null || echo "?")
			echo "OK (v$new_version, ${elapsed}s)"
			UPDATED=$((UPDATED + 1))
			return
		fi
	done
	echo "TIMEOUT (did not come back in 5 min)"
	FAILED=$((FAILED + 1))
}

# Update tunnel validators
for url in "${TUNNELS[@]}"; do
	name=$(echo "$url" | sed 's|https://||' | sed 's|\.ensoul\.dev||')
	update_validator "$url" "$name"
done

# Update cloud validators (if file exists)
if [ -f "$CLOUD_FILE" ]; then
	while IFS= read -r ip; do
		[ -z "$ip" ] && continue
		[[ "$ip" == \#* ]] && continue
		update_validator "http://$ip:9000" "cloud-$ip"
	done < "$CLOUD_FILE"
fi

echo ""
echo "  Total: $TOTAL | Updated: $UPDATED | Failed: $FAILED"
echo ""
