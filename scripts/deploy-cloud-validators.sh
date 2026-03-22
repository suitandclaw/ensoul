#!/bin/bash
#
# deploy-cloud-validators.sh
#
# Deploy Ensoul validators across multiple cloud VPS instances.
#
# Usage:
#   ./scripts/deploy-cloud-validators.sh
#   ./scripts/deploy-cloud-validators.sh --verify
#
# Prerequisites:
#   - VPS IPs listed in ~/.ensoul/cloud-validators.txt (one per line)
#   - SSH key access to each VPS (root or user with sudo)
#

set -euo pipefail

VPS_FILE="$HOME/.ensoul/cloud-validators.txt"
LOG_FILE="$HOME/.ensoul/cloud-deploy.log"
SETUP_URL="https://raw.githubusercontent.com/suitandclaw/ensoul/main/scripts/cloud-validator-setup.sh"
SSH_USER="${SSH_USER:-root}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/id_rsa}"

log() {
	local ts
	ts=$(date +"%Y-%m-%d %H:%M:%S")
	echo "[$ts] $1" | tee -a "$LOG_FILE"
}

# Verify mode: check status of all deployed validators
do_verify() {
	if [ ! -f "$VPS_FILE" ]; then
		echo "No VPS file found at $VPS_FILE"
		exit 1
	fi

	local total=0
	local online=0
	local synced=0

	while IFS= read -r ip; do
		[ -z "$ip" ] && continue
		[[ "$ip" == \#* ]] && continue
		total=$((total + 1))

		local status
		status=$(curl -s --connect-timeout 5 "http://$ip:9000/peer/status" 2>/dev/null || echo "")
		if [ -n "$status" ]; then
			local height did
			height=$(echo "$status" | python3 -c "import sys,json; print(json.load(sys.stdin).get('height', 0))" 2>/dev/null || echo "0")
			did=$(echo "$status" | python3 -c "import sys,json; d=json.load(sys.stdin).get('did',''); print(d[:20]+'...' if len(d)>20 else d)" 2>/dev/null || echo "?")
			echo "  $ip: ONLINE height=$height did=$did"
			online=$((online + 1))
			if [ "$height" -gt 0 ]; then
				synced=$((synced + 1))
			fi
		else
			echo "  $ip: OFFLINE"
		fi
	done < "$VPS_FILE"

	echo ""
	echo "  Total: $total | Online: $online | Synced: $synced"
	echo ""
}

# Deploy mode
do_deploy() {
	if [ ! -f "$VPS_FILE" ]; then
		echo "Create $VPS_FILE with one VPS IP per line, then run this script."
		echo "Example:"
		echo "  echo '1.2.3.4' >> ~/.ensoul/cloud-validators.txt"
		echo "  echo '5.6.7.8' >> ~/.ensoul/cloud-validators.txt"
		exit 1
	fi

	local total=0
	local deployed=0
	local failed=0

	# Count total
	while IFS= read -r ip; do
		[ -z "$ip" ] && continue
		[[ "$ip" == \#* ]] && continue
		total=$((total + 1))
	done < "$VPS_FILE"

	log "Deploying to $total VPS instances..."

	local idx=0
	while IFS= read -r ip; do
		[ -z "$ip" ] && continue
		[[ "$ip" == \#* ]] && continue
		idx=$((idx + 1))

		log "[$idx/$total] Deploying to $ip..."

		if ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 \
			-i "$SSH_KEY" "$SSH_USER@$ip" \
			"curl -sL $SETUP_URL | bash" \
			>> "$LOG_FILE" 2>&1; then
			deployed=$((deployed + 1))
			log "[$idx/$total] SUCCESS: $ip"
		else
			failed=$((failed + 1))
			log "[$idx/$total] FAILED: $ip"
		fi
	done < "$VPS_FILE"

	log "Deploy complete: $deployed/$total succeeded, $failed failed."
	echo ""
	echo "  Deployed: $deployed/$total"
	echo "  Failed:   $failed"
	echo ""
	echo "  Run with --verify to check status."
}

# Main
case "${1:-}" in
	--verify) do_verify ;;
	*) do_deploy ;;
esac
