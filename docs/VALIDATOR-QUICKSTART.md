# Ensoul Validator Quickstart

Get a validator running in under 5 minutes.

---

## Requirements

| Resource | Minimum |
|----------|---------|
| CPU | 2 cores |
| RAM | 4 GB |
| Storage | 40 GB SSD |
| Network | Port 26656 (TCP) reachable from the internet |
| OS | Ubuntu 22.04+, Debian 12, or macOS 14+ |

A $5/month VPS works. No GPU needed.

---

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/suitandclaw/ensoul/main/scripts/install-validator.sh -o install.sh
bash install.sh
```

Two steps (download, then run) avoid pipe and quoting issues when copy-pasting from PDFs or chat. This installs Go, Node.js, CometBFT, Cosmovisor, builds the ABCI server, downloads the genesis, and starts everything with auto-restart.

---

## Verify

Check sync progress:

```bash
curl -s http://localhost:26657/status | python3 -c \
  "import sys,json; d=json.load(sys.stdin)['result']['sync_info']; \
   print(f'Height: {d[\"latest_block_height\"]}, Catching up: {d[\"catching_up\"]}')"
```

Wait for `catching_up: false` (1 to 4 hours depending on chain height).

Check peers:

```bash
curl -s http://localhost:26657/net_info | python3 -c \
  "import sys,json; print(f'Peers: {json.load(sys.stdin)[\"result\"][\"n_peers\"]}')"
```

You should see 2 or more peers.

---

## Register

Once synced, register for a foundation delegation (100,000 ENSL):

```bash
curl -X POST https://api.ensoul.dev/v1/validators/register \
  -H "Content-Type: application/json" \
  -d '{"did":"YOUR_DID","publicKey":"YOUR_PUBKEY","name":"your-name"}'
```

Replace `YOUR_DID` and `YOUR_PUBKEY` with the values from the installer output.

---

## Back up your key

**Do this now.** Copy this file to a safe location:

```
~/.cometbft-ensoul/node/config/priv_validator_key.json
```

If you lose it, you lose your validator identity.

---

## Upgrades

Your validator updates itself automatically. When the protocol team publishes an upgrade, your node applies it at the specified block height with zero operator action. No monitoring, no manual restarts. If your node is offline during an upgrade, it catches up automatically on next startup.

---

## Next steps

- [Full Validator Guide](VALIDATOR-GUIDE.md) for monitoring, security, troubleshooting
- [Validator Dashboard](https://ensoul.dev/validator-dashboard.html) to track your earnings
- [Wallet](https://ensoul.dev/wallet.html) to manage stake and rewards
