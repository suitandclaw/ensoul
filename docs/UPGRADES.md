# On-Chain Software Upgrades

## Overview

Ensoul uses CometBFT's Cosmovisor for automated binary upgrades. The flow:

1. The pioneer key submits a SOFTWARE_UPGRADE transaction with a target height
2. All validators include the upgrade plan in their state
3. When the chain reaches the target height, all ABCI servers halt simultaneously
4. Cosmovisor detects the halt, swaps the binary, and restarts
5. The chain resumes with the new version

No SSH, no manual coordination, no downtime beyond the swap.

## Submitting an Upgrade

### Prepare the release

Build binaries for each platform and host them at stable URLs:

```json
{
  "binaries": {
    "darwin/arm64": "https://releases.ensoul.dev/v2.0.0/cometbft-darwin-arm64",
    "linux/amd64": "https://releases.ensoul.dev/v2.0.0/cometbft-linux-amd64"
  }
}
```

### Submit the proposal

The pioneer key submits a `software_upgrade` transaction with:
- `name`: version string (e.g., "v2.0.0"), must be unique
- `height`: target block height (must be in the future)
- `info`: JSON string with binary download URLs

The upgrade plan data is encoded in the transaction's `data` field:

```json
{
  "name": "v2.0.0",
  "height": 50000,
  "info": "{\"binaries\":{\"darwin/arm64\":\"https://...\"}}"
}
```

### Verify the plan

Query any validator's CometBFT RPC:

```bash
curl -s -X POST http://localhost:26657 \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":"1","method":"abci_query","params":{"path":"/upgrade/current"}}'
```

### Cancel if needed

Submit a `cancel_upgrade` transaction before the target height:
- `from`: pioneer key DID
- `data`: `{"name": "v2.0.0"}` (must match the active plan name)

## What Happens at the Upgrade Height

1. FinalizeBlock executes all transactions normally
2. Commit persists the state
3. The ABCI server writes to stderr:
   `UPGRADE "v2.0.0" NEEDED at height: 50000: {"binaries":{...}}`
4. The ABCI server exits with code 1
5. Cosmovisor detects the message and:
   a. Backs up the data directory (if UNSAFE_SKIP_BACKUP=false)
   b. Looks for the new binary at `cosmovisor/upgrades/v2.0.0/bin/cometbft`
   c. If not found and DAEMON_ALLOW_DOWNLOAD_URLS=true, downloads from the info URLs
   d. Swaps the symlink to the new binary
   e. Restarts the process

## Query Endpoints

| Path | Description |
|---|---|
| /upgrade/current | Active upgrade plan (null if none) |
| /upgrade/history | List of completed upgrades |
| /upgrade/applied/{name} | Whether a specific upgrade was applied |

## Validation Rules

- Only the pioneer key can submit or cancel upgrades
- Target height must be greater than current height
- Only one active upgrade plan at a time
- Upgrade names cannot be reused (completed names are permanently recorded)
- Cancel is only possible before the target height is reached

## Pre-placing Binaries

For validators that don't allow download URLs, the new binary can be
placed manually before the upgrade height:

```bash
mkdir -p ~/.cometbft-ensoul/node/cosmovisor/upgrades/v2.0.0/bin/
cp /path/to/new/cometbft ~/.cometbft-ensoul/node/cosmovisor/upgrades/v2.0.0/bin/cometbft
chmod +x ~/.cometbft-ensoul/node/cosmovisor/upgrades/v2.0.0/bin/cometbft
```

Cosmovisor checks for a pre-placed binary before attempting download.

## Verifying an Upgrade Completed

After the chain resumes:

```bash
# Check the upgrade history
curl -s -X POST http://localhost:26657 \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":"1","method":"abci_query","params":{"path":"/upgrade/history"}}'

# Check the new binary version
cosmovisor version
```

## Emergency Procedures

If an upgrade fails:
1. Cosmovisor will not restart if the new binary crashes
2. Manually replace the binary at the upgrade path and restart
3. Or revert: copy the old binary back and restart with `--unsafe-skip-backup`
4. The chain will resume from the last committed height
