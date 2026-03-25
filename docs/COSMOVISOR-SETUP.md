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

## On-Chain Upgrades (Live)

The SOFTWARE_UPGRADE transaction type is implemented in the ABCI server.
See docs/UPGRADES.md for the full workflow.

Summary:
1. Pioneer key submits a `software_upgrade` transaction with target height
2. All validators include the plan in their state (deterministic app_hash)
3. At the target height, the ABCI server writes to stderr:
   `UPGRADE "name" NEEDED at height: N: info`
4. Process exits with code 2 (matches Go panic behavior)
5. Cosmovisor detects the message, backs up data, swaps the binary
6. Cosmovisor restarts CometBFT with the new binary
7. Chain resumes automatically on all validators

No SSH, no manual intervention, no coordination needed.

## Verified Status (2026-03-25)

All 4 machines running CometBFT v0.38.17 through Cosmovisor v1.5.0.
Chain at height 25,000+, all validators healthy, dashboard all green.
Zero downtime during the switch from direct CometBFT to Cosmovisor.

## Troubleshooting

**Cosmovisor not starting:**
Check that DAEMON_HOME points to the node directory with config/ and data/
subdirectories. Cosmovisor expects `$DAEMON_HOME/data/` to exist.

**Binary not found:**
Ensure the CometBFT binary is at `$DAEMON_HOME/cosmovisor/genesis/bin/cometbft`
with execute permissions (`chmod +x`).

**Upgrade not detected:**
The ABCI server must write the exact Cosmos SDK panic format to stderr.
Cosmovisor scans for: `UPGRADE "name" NEEDED at height:`
Verify stderr output: `tail -f ~/.ensoul/cometbft.log | grep UPGRADE`

**After upgrade, chain doesn't resume:**
Check if the new binary exists at `cosmovisor/upgrades/{name}/bin/cometbft`.
If missing, download or place it manually, then restart Cosmovisor.

## Cloud Validator Cosmovisor Setup

New cloud validators should launch with Cosmovisor from day one.
The one-command installer includes:
1. Install Go and CometBFT binary
2. Install Cosmovisor v1.5.0
3. Set up directory structure (genesis/bin/, upgrades/, backups/)
4. Configure environment variables
5. Start CometBFT through Cosmovisor
6. Sync the chain from existing peers

No separate Cosmovisor setup step needed for cloud validators.
