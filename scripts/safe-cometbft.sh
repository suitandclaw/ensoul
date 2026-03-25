#!/usr/bin/env bash
#
# safe-cometbft.sh: wrapper around cometbft that prevents accidental
# reinitialization of a running chain.
#
# If blockstore.db exists, the "init" command is blocked. All other
# commands pass through to the real cometbft binary.
#
# Install: alias cometbft="~/ensoul/scripts/safe-cometbft.sh"
#

set -euo pipefail

COMETBFT_BIN="$HOME/go/bin/cometbft"
NODE_HOME="$HOME/.cometbft-ensoul/node"

if [ "${1:-}" = "init" ]; then
	if [ -d "$NODE_HOME/data/blockstore.db" ]; then
		echo ""
		echo "BLOCKED: cometbft init refused."
		echo ""
		echo "A live chain exists at $NODE_HOME/data/blockstore.db"
		echo "Reinitializing would destroy all block history and state."
		echo ""
		echo "If you truly need to reset (you almost certainly do not):"
		echo "  1. Stop all validators on all machines"
		echo "  2. Back up the data directory"
		echo "  3. Run: $COMETBFT_BIN init --home $NODE_HOME"
		echo ""
		echo "All state changes must go through on-chain transactions."
		echo "Genesis resets are only for consensus engine replacements."
		echo ""
		exit 1
	fi
fi

exec "$COMETBFT_BIN" "$@"
