#!/bin/bash
#
# validator-launchd-wrapper-mini.sh: macOS supervisor for ABCI + CometBFT.
#
# Same as validator-launchd-wrapper.sh but runs CometBFT directly
# (not through Cosmovisor). Used on Mac Mini validators where
# Cosmovisor is installed but CometBFT has historically been run bare.
#
# Manages both processes in the correct dependency order (Rule 19):
#   Start:  ABCI first, wait 3s, then CometBFT
#   Stop:   CometBFT first, then ABCI
#   Upgrade: ABCI exits code 2 -> stop CometBFT -> auto-upgrade.sh -> restart both
#
# Compatible with macOS system bash (3.2). Uses a poll loop to detect
# either process exiting (2s detection latency).
#
# Usage:
#   Managed by launchd via dev.ensoul.validator.plist. Can also be run manually:
#   ./scripts/validator-launchd-wrapper-mini.sh

REPO_DIR="$HOME/ensoul"
CMT_HOME="$HOME/.cometbft-ensoul/node"
ABCI_LOG="$HOME/.ensoul/abci-server.log"
CMT_LOG="$HOME/.ensoul/cometbft.log"
WRAPPER_LOG="$HOME/.ensoul/validator-wrapper.log"
ABCI_PORT=26658
CMT_RPC_PORT=26657
MAX_RESTARTS=100
RESTART_COUNT=0

# Find cometbft binary
COMETBFT_BIN=""
if command -v cometbft >/dev/null 2>&1; then
    COMETBFT_BIN=$(command -v cometbft)
elif [ -x "$HOME/go/bin/cometbft" ]; then
    COMETBFT_BIN="$HOME/go/bin/cometbft"
fi

mkdir -p "$(dirname "$ABCI_LOG")"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] [wrapper] $1" | tee -a "$WRAPPER_LOG"; }

if [ -z "$COMETBFT_BIN" ]; then
    log "FATAL: cometbft not found in PATH or at ~/go/bin/cometbft"
    exit 1
fi
log "Using cometbft at: $COMETBFT_BIN"

# ── Stop CometBFT cleanly ──────────────────────────────────────────

stop_cometbft() {
    if [ -n "$CMT_PID" ] && kill -0 "$CMT_PID" 2>/dev/null; then
        log "Stopping CometBFT (PID $CMT_PID)..."
        kill -TERM "$CMT_PID" 2>/dev/null
        for i in 1 2 3 4 5 6 7 8 9 10; do
            if ! kill -0 "$CMT_PID" 2>/dev/null; then
                log "CometBFT stopped after ${i}s"
                return
            fi
            sleep 1
        done
        kill -KILL "$CMT_PID" 2>/dev/null
        log "CometBFT force-killed"
    fi
    # Also kill by port in case PID tracking is stale
    local port_pid
    port_pid=$(lsof -iTCP:$CMT_RPC_PORT -sTCP:LISTEN -t 2>/dev/null | head -1)
    if [ -n "$port_pid" ]; then
        kill -TERM "$port_pid" 2>/dev/null
        sleep 1
        kill -KILL "$port_pid" 2>/dev/null
    fi
}

# ── Stop ABCI cleanly ──────────────────────────────────────────────

stop_abci() {
    if [ -n "$ABCI_PID" ] && kill -0 "$ABCI_PID" 2>/dev/null; then
        log "Stopping ABCI (PID $ABCI_PID)..."
        kill -TERM "$ABCI_PID" 2>/dev/null
        for i in 1 2 3 4 5; do
            if ! kill -0 "$ABCI_PID" 2>/dev/null; then
                log "ABCI stopped after ${i}s"
                return
            fi
            sleep 1
        done
        kill -KILL "$ABCI_PID" 2>/dev/null
        log "ABCI force-killed"
    fi
}

# ── Start CometBFT directly (no Cosmovisor) ────────────────────────

start_cometbft() {
    "$COMETBFT_BIN" start \
        --proxy_app="tcp://127.0.0.1:$ABCI_PORT" \
        --home "$CMT_HOME" \
        >> "$CMT_LOG" 2>&1 &
    CMT_PID=$!
    log "CometBFT started (PID $CMT_PID)"
}

# ── Shutdown handler ───────────────────────────────────────────────

ABCI_PID=""
CMT_PID=""
cleanup() {
    log "Received shutdown signal. Stopping in Rule 19 order..."
    stop_cometbft
    stop_abci
    log "Wrapper exiting."
    exit 0
}
trap cleanup SIGTERM SIGINT

# ── Main loop ──────────────────────────────────────────────────────

log "Validator wrapper started (PID $$, bash ${BASH_VERSION})"

while true; do
    log "=== Restart cycle #$RESTART_COUNT ==="

    # ── Step 1: Start ABCI ──────────────────────────────────────
    log "Starting ABCI on port $ABCI_PORT..."
    cd "$REPO_DIR"

    DAEMON_HOME="$CMT_HOME" \
    npx tsx packages/abci-server/src/index.ts --port $ABCI_PORT >> "$ABCI_LOG" 2>&1 &
    ABCI_PID=$!
    log "ABCI started (PID $ABCI_PID)"

    # Wait for ABCI to be listening
    for i in 1 2 3 4 5 6 7 8 9 10; do
        if lsof -iTCP:$ABCI_PORT -sTCP:LISTEN -t >/dev/null 2>&1; then
            log "ABCI listening after ${i}s"
            break
        fi
        sleep 1
    done

    # ── Step 2: Start CometBFT (3s after ABCI per Rule 19) ─────
    sleep 3
    start_cometbft

    # ── Step 3: Wait for EITHER process to exit ────────────────
    # Poll both PIDs every 2 seconds. Compatible with bash 3.2.
    while true; do
        if ! kill -0 "$ABCI_PID" 2>/dev/null; then
            wait "$ABCI_PID" 2>/dev/null
            EXIT_CODE=$?
            log "ABCI exited (code $EXIT_CODE). CometBFT alive: $(kill -0 "$CMT_PID" 2>/dev/null && echo true || echo false)"
            break
        fi
        if ! kill -0 "$CMT_PID" 2>/dev/null; then
            wait "$CMT_PID" 2>/dev/null
            EXIT_CODE=$?
            log "CometBFT exited (code $EXIT_CODE). ABCI alive: $(kill -0 "$ABCI_PID" 2>/dev/null && echo true || echo false)"
            break
        fi
        sleep 2
    done

    # ── Step 4: Stop both in Rule 19 order ─────────────────────
    stop_cometbft
    stop_abci

    # ── Step 5: Run auto-upgrade.sh (ExecStopPost equivalent) ──
    if [ -f "$REPO_DIR/scripts/auto-upgrade.sh" ]; then
        log "Running auto-upgrade.sh..."
        DAEMON_HOME="$CMT_HOME" \
        ENSOUL_REPO="$REPO_DIR" \
        bash "$REPO_DIR/scripts/auto-upgrade.sh" >> "$WRAPPER_LOG" 2>&1
        UPGRADE_RC=$?
        log "auto-upgrade.sh exited with code $UPGRADE_RC"
    fi

    # ── Step 6: Restart cycle ──────────────────────────────────
    RESTART_COUNT=$((RESTART_COUNT + 1))
    if [ "$RESTART_COUNT" -ge "$MAX_RESTARTS" ]; then
        log "Hit max restarts ($MAX_RESTARTS). Stopping wrapper."
        exit 1
    fi

    log "Restarting in 5 seconds..."
    sleep 5
done
