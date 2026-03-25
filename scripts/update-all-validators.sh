#!/usr/bin/env bash
#
# update-all-validators.sh
#
# Rolls out code updates to all validator machines sequentially,
# maintaining quorum throughout. Each machine is updated only
# after the previous one is confirmed healthy.
#
# Usage:
#   ./scripts/update-all-validators.sh              # update all
#   ./scripts/update-all-validators.sh mini1         # update one
#   ./scripts/update-all-validators.sh --dry-run     # show plan
#   ./scripts/update-all-validators.sh --code-only   # pull + build, no restart
#

set -euo pipefail

HEALTH_TIMEOUT=60

log() { echo "[$(date +%H:%M:%S)] $1"; }

DRY_RUN=false
CODE_ONLY=false
TARGET=""

for arg in "$@"; do
  case "$arg" in
    --dry-run)   DRY_RUN=true ;;
    --code-only) CODE_ONLY=true ;;
    mini1|mini2|mini3|mbp) TARGET="$arg" ;;
  esac
done

if [ -n "$TARGET" ]; then
  MACHINES="$TARGET"
else
  MACHINES="mini3 mini2 mini1 mbp"
fi

get_ip() {
  case "$1" in
    mbp)   echo "100.67.81.90" ;;
    mini1) echo "100.86.108.114" ;;
    mini2) echo "100.117.84.28" ;;
    mini3) echo "100.127.140.26" ;;
  esac
}

run_on() {
  local machine="$1"; shift
  local prefix='export PATH="/opt/homebrew/bin:$HOME/go/bin:$PATH"; export NVM_DIR="$HOME/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh";'
  if [ "$machine" = "mbp" ]; then
    eval "$prefix $*"
  else
    ssh -o ConnectTimeout=10 -o BatchMode=yes "$machine" "$prefix $*"
  fi
}

check_health() {
  local machine="$1"
  local ip; ip=$(get_ip "$machine")
  local elapsed=0
  while [ $elapsed -lt "$HEALTH_TIMEOUT" ]; do
    local height
    height=$(curl -s "http://$ip:26657/status" 2>/dev/null | \
      python3 -c "import sys,json; print(json.load(sys.stdin)['result']['sync_info']['latest_block_height'])" 2>/dev/null || echo "0")
    if [ "$height" != "0" ] && [ -n "$height" ]; then
      log "  Health OK: $machine at height $height"
      return 0
    fi
    sleep 5
    elapsed=$((elapsed + 5))
  done
  log "  HEALTH FAILED: $machine not responding within ${HEALTH_TIMEOUT}s"
  return 1
}

update_machine() {
  local machine="$1"
  log ""
  log "=== Updating $machine ==="

  if $DRY_RUN; then
    log "  [dry-run] Would: git pull, build, restart"
    return 0
  fi

  log "  Pulling latest code..."
  run_on "$machine" "cd ~/ensoul && git pull origin main 2>&1 | tail -2" || {
    log "  FAILED: git pull"; return 1
  }

  log "  Installing dependencies..."
  run_on "$machine" "cd ~/ensoul && pnpm install 2>&1 | tail -1" || true

  log "  Building ABCI server..."
  run_on "$machine" "cd ~/ensoul && rm -rf .turbo node_modules/.cache packages/abci-server/dist && pnpm build --filter @ensoul/abci-server 2>&1 | tail -2" || {
    log "  FAILED: build"; return 1
  }

  if $CODE_ONLY; then
    log "  Code updated (no restart)"
    return 0
  fi

  log "  Restarting validator..."
  run_on "$machine" "cd ~/ensoul && ./scripts/start-cometbft-validators.sh stop 2>&1 | tail -1" || true
  sleep 3
  run_on "$machine" "cd ~/ensoul && nohup ./scripts/start-cometbft-validators.sh > /tmp/validator-restart.log 2>&1 &" || {
    log "  FAILED: restart"; return 1
  }

  log "  Waiting for health..."
  sleep 15
  if ! check_health "$machine"; then
    log "  FAILED: $machine did not recover"
    return 1
  fi

  log "  $machine updated successfully"
}

log "ENSOUL VALIDATOR ROLLING UPDATE"
log "Targets: $MACHINES"
$DRY_RUN && log "Mode: DRY RUN"
$CODE_ONLY && log "Mode: CODE ONLY"

CURRENT=$(curl -s http://localhost:26657/status 2>/dev/null | \
  python3 -c "import sys,json; print(json.load(sys.stdin)['result']['sync_info']['latest_block_height'])" 2>/dev/null || echo "0")
log "Chain height: $CURRENT"

FAILED=""
for machine in $MACHINES; do
  if ! update_machine "$machine"; then
    FAILED="$machine"
    log ""; log "STOPPING: $machine failed."
    break
  fi
done

log ""
if [ -z "$FAILED" ]; then
  FINAL=$(curl -s http://localhost:26657/status 2>/dev/null | \
    python3 -c "import sys,json; print(json.load(sys.stdin)['result']['sync_info']['latest_block_height'])" 2>/dev/null || echo "?")
  log "=== ALL UPDATES SUCCESSFUL ==="
  log "Chain height: $CURRENT -> $FINAL"
else
  log "=== FAILED at $FAILED ==="
  exit 1
fi
