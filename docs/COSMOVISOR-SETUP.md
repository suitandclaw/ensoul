# Cosmovisor Setup

## Overview

Cosmovisor manages the CometBFT binary lifecycle on all Ensoul validators.
It handles automatic binary upgrades when on-chain upgrade proposals are
executed, including backup, swap, and restart.

## Installation

All 4 machines have Cosmovisor v1.5.0 installed:

```bash
go install cosmossdk.io/tools/cosmovisor/cmd/cosmovisor@v1.5.0
```

## Directory Structure

Each machine's CometBFT node directory (`~/.cometbft-ensoul/node/`):

```
node/
  config/
    config.toml
    genesis.json
    priv_validator_key.json
    node_key.json
  data/
    (CometBFT block data)
  cosmovisor/
    genesis/
      bin/
        cometbft        <- current binary (v0.38.17)
    upgrades/
      <upgrade-name>/
        bin/
          cometbft      <- new binary (placed by Cosmovisor or manually)
  backups/
    (pre-upgrade snapshots)
```

## Environment Variables

These must be set when starting Cosmovisor:

```bash
export DAEMON_NAME=cometbft
export DAEMON_HOME="$HOME/.cometbft-ensoul/node"
export DAEMON_DATA_BACKUP_DIR="$DAEMON_HOME/backups"
export DAEMON_ALLOW_DOWNLOAD_URLS=true
export DAEMON_RESTART_AFTER_UPGRADE=true
export DAEMON_LOG_BUFFER_SIZE=512
export UNSAFE_SKIP_BACKUP=false
```

## Starting CometBFT via Cosmovisor

```bash
cosmovisor run start --home $DAEMON_HOME
```

Cosmovisor wraps CometBFT, passing all arguments through. It monitors
the process and handles upgrade signals automatically.

## Machines

| Machine | IP (Tailscale) | Cosmovisor | CometBFT | Status |
|---|---|---|---|---|
| MBP | 100.67.81.90 | v1.5.0 | v0.38.17 | Running |
| Mini 1 | 100.86.108.114 | v1.5.0 | v0.38.17 | Running |
| Mini 2 | 100.117.84.28 | v1.5.0 | v0.38.17 | Running |
| Mini 3 | 100.127.140.26 | v1.5.0 | v0.38.17 | Running |

## Rolling Updates

For ABCI server code updates (no CometBFT binary change):

```bash
./scripts/update-all-validators.sh           # all machines
./scripts/update-all-validators.sh mini1      # single machine
./scripts/update-all-validators.sh --dry-run  # preview
./scripts/update-all-validators.sh --code-only  # pull + build, no restart
```

Update order: mini3, mini2, mini1, mbp (least critical first).
Each machine is health-checked before proceeding to the next.

## Future: On-Chain Upgrades

When the SOFTWARE_UPGRADE transaction type is implemented:
1. Submit an upgrade proposal with target height and new binary URL
2. When the chain reaches that height, the ABCI server returns an error
3. Cosmovisor detects the halt, downloads the new binary, swaps it in
4. Cosmovisor restarts CometBFT with the new binary
5. Chain resumes automatically on all validators

No SSH, no manual intervention, no coordination needed.
