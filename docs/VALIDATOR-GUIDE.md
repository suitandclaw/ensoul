# Ensoul Validator Guide

Complete guide to running an Ensoul validator. Whether you are setting up your first blockchain node or have operated validators on other networks, this document covers everything from a one-command install to advanced monitoring and security.

---

## Table of Contents

1. [Overview](#1-overview)
2. [Hardware Requirements](#2-hardware-requirements)
3. [Network Requirements](#3-network-requirements)
4. [Keeping Your Machine Running 24/7](#4-keeping-your-machine-running-247)
5. [Quick Start (One Command)](#5-quick-start-one-command)
6. [Manual Installation](#6-manual-installation)
7. [Staking and Joining the Active Set](#7-staking-and-joining-the-active-set)
8. [Monitoring Your Validator](#8-monitoring-your-validator)
9. [Upgrades](#9-upgrades)
10. [Troubleshooting](#10-troubleshooting)
11. [Security Best Practices](#11-security-best-practices)
12. [FAQ](#12-faq)

---

## 1. Overview

### What is an Ensoul validator?

An Ensoul validator is a machine that participates in the network's BFT consensus to produce blocks, validate transactions, and store agent consciousness data. Validators run three core processes:

- **ABCI server** (port 26658): The Ensoul application logic that processes transactions, manages accounts, and handles agent registrations.
- **CometBFT** (port 26657): The consensus engine that coordinates block production across all validators using the Tendermint BFT algorithm.
- **Compat proxy** (port 9000): A lightweight HTTP bridge that translates legacy API calls into CometBFT RPC queries.

### What you earn

Validators earn ENSL tokens for every block they propose. The emission schedule reduces by 25% each year:

| Year | Blocks | Reward per Block | Annual Total |
|------|--------|-----------------|--------------|
| 1 | 5,256,000 | ~19.03 ENSL | 100,000,000 ENSL |
| 2 | 5,256,000 | ~14.27 ENSL | 75,000,000 ENSL |
| 3 | 5,256,000 | ~10.70 ENSL | 56,250,000 ENSL |
| 4 | 5,256,000 | ~8.03 ENSL | 42,187,500 ENSL |

With 5 active validators, each validator proposes roughly 20% of blocks, earning approximately 54,800 ENSL per day during Year 1. As more validators join, rewards are split proportionally by voting power.

Additional revenue:
- **Delegation commission**: 10% of block rewards attributed to tokens delegated to you by others.
- **Storage credits**: Earned automatically from staking. Every 10,000 ENSL staked grants 1 storage credit (1 MB-month equivalent).

### What is required

- A server or desktop that meets the hardware requirements below.
- A stable internet connection with port 26656 (TCP) reachable from the internet.
- ENSL tokens for staking (the Pioneer Program provides 2,000,000 ENSL to early validators).

### Time commitment

Setup takes 5 to 15 minutes. After that, validation is passive. Cosmovisor handles binary upgrades automatically when on-chain proposals pass. You should check on your node periodically (weekly is fine) to ensure it remains healthy, but no daily intervention is needed.

---

## 2. Hardware Requirements

This is **not** cryptocurrency mining. No GPU is needed. Ensoul uses proof-of-stake consensus, so the computational requirements are modest.

### Minimum

| Resource | Requirement |
|----------|-------------|
| CPU | 2 cores |
| RAM | 4 GB |
| Storage | 40 GB SSD |
| Network | 100 Mbps, stable connection, low latency |
| OS | Ubuntu 22.04/24.04, Debian 12, or macOS 14+ |

### Recommended

| Resource | Requirement |
|----------|-------------|
| CPU | 4 cores |
| RAM | 8 GB |
| Storage | 100 GB NVMe SSD |
| Network | 1 Gbps |

A $5/month VPS from any major cloud provider meets the minimum requirements comfortably.

---

## 3. Network Requirements

Your validator must be able to communicate with other validators over TCP port 26656. There are three deployment options depending on your network situation.

### Option A: Cloud VPS (Recommended)

This is what the vast majority of professional validators use. A cloud server has a public IP address and open ports by default.

**Recommended providers:**
- Hetzner Cloud ($4.50/month, CX22)
- DigitalOcean ($6/month, Basic Droplet)
- Vultr ($6/month, Cloud Compute)
- OVH ($5/month, Starter VPS)

**Setup:** Run the one-command installer. Networking is automatic. The installer detects your public IP and configures `external_address` in the CometBFT config.

**Firewall:** Ensure TCP port 26656 is open. On most VPS providers this is the default. If you use `ufw`:

```bash
sudo ufw allow 22/tcp    # SSH
sudo ufw allow 26656/tcp # CometBFT P2P
sudo ufw enable
```

### Option B: Home Server with Port Forwarding

If you have a home server with a public IP address (or a dynamic DNS name), you can forward port 26656 through your router.

**Steps:**

1. Find your public IP:
   ```bash
   curl -4 https://ifconfig.me
   ```

2. Log into your router's admin panel (usually `192.168.1.1` or `192.168.0.1`).

3. Add a port forwarding rule:
   - External port: 26656 (TCP)
   - Internal IP: your server's local IP (e.g., 192.168.1.100)
   - Internal port: 26656 (TCP)
   - For router-specific instructions, visit [portforward.com](https://portforward.com)

4. Set your external address in the CometBFT config:
   ```bash
   # In ~/.cometbft-ensoul/node/config/config.toml
   external_address = "YOUR_PUBLIC_IP:26656"
   ```

5. Alternatively, enable UPnP for automatic port opening:
   ```bash
   # In ~/.cometbft-ensoul/node/config/config.toml, under [p2p]
   upnp = true
   ```

**Note:** If your ISP assigns a dynamic IP, use a Dynamic DNS service (e.g., DuckDNS, No-IP) and set `external_address` to your DDNS hostname.

### Option C: Restricted Network (CGNAT, Corporate, No Port Forwarding)

If you cannot open incoming ports (carrier-grade NAT, corporate firewall, ISP restrictions), you can still participate using a VPN overlay network.

**Option C1: Tailscale (recommended, free for personal use)**

1. Install Tailscale on your validator and on at least one machine that has a public IP:
   ```bash
   curl -fsSL https://tailscale.com/install.sh | sh
   sudo tailscale up
   ```

2. Your machine gets a stable Tailscale IP (e.g., `100.x.y.z`). Share this IP with other validators for peering.

3. Set `external_address` in config.toml to your Tailscale IP:
   ```bash
   external_address = "100.x.y.z:26656"
   ```

4. Add other validators' Tailscale IPs as `persistent_peers`.

**Option C2: WireGuard manual setup**

Create a WireGuard tunnel between your machine and a VPS with a public IP, then configure CometBFT to listen on the WireGuard interface.

**For all restricted setups:** Your node will still discover peers via PEX (Peer Exchange) as long as it can reach at least one seed node over outbound connections.

---

## 4. Keeping Your Machine Running 24/7

A validator must be online continuously. Every block you miss is a block you do not earn rewards for. Extended downtime (50+ consecutive missed blocks) may result in removal from the active validator set.

### Cloud VPS (Linux with systemd)

The installer creates systemd services that handle everything automatically:

- **Auto-restart on crash:** Each service has `Restart=always` with a 5-second delay.
- **Auto-start on boot:** Services are enabled by default (`systemctl enable`).
- **Health monitoring:** The process manager runs every 30 seconds to check all services.

**Check service status:**
```bash
systemctl status ensoul-abci
systemctl status ensoul-cometbft
systemctl status ensoul-proxy
```

**View logs in real time:**
```bash
journalctl -u ensoul-cometbft -f
# or
tail -f ~/.ensoul/cometbft.log
```

**OS security patches (recommended):**
```bash
sudo apt install unattended-upgrades
sudo dpkg-reconfigure -plow unattended-upgrades
```

### macOS Home Machines

Running a validator on a Mac requires preventing the system from sleeping.

**Critical settings:**

1. **Disable sleep:** System Settings > Energy > "Prevent automatic sleeping when the display is off" must be ON.

2. **Disable Power Nap and auto-shutdown:** System Settings > Energy > Turn off Power Nap and "Start up automatically after a power failure" should be ON.

3. **Enable automatic login:** System Settings > Users & Groups > Login Options > set Automatic Login to your user account.

4. **Configure power management via Terminal (recommended):**
   ```bash
   sudo pmset -a sleep 0 displaysleep 0 disksleep 0
   sudo pmset -a autorestart 1
   ```

5. **Verify settings:**
   ```bash
   pmset -g
   # Confirm: sleep = 0, displaysleep = 0, disksleep = 0
   ```

6. **Fallback sleep prevention:**
   ```bash
   caffeinate -s &
   ```

The installer sets up launchd services that start automatically on login and restart on crash.

### For Both Environments

- **UPS recommended:** For home operators, an uninterruptible power supply prevents your machine from going offline during short power outages.
- **Automatic recovery:** If your machine reboots (power failure, kernel update), all Ensoul services restart automatically.
- **Missing blocks = missing rewards:** There is no penalty for brief downtime, but you earn nothing for blocks you do not propose.

---

## 5. Quick Start (One Command)

The fastest way to get running. One command installs all dependencies, builds everything, generates keys, and starts your validator.

### Linux (Ubuntu/Debian)

```bash
curl -fsSL https://raw.githubusercontent.com/suitandclaw/ensoul/main/scripts/install-validator.sh | bash
```

### macOS

```bash
curl -fsSL https://raw.githubusercontent.com/suitandclaw/ensoul/main/scripts/install-validator.sh | bash
```

### What the installer does

1. Detects your OS and architecture.
2. Installs Go, Node.js 22, pnpm, CometBFT, and Cosmovisor.
3. Clones the Ensoul repository and builds all packages.
4. Generates unique validator keys (Ed25519).
5. Downloads the current genesis from `api.ensoul.dev/genesis`.
6. Detects your public IP and configures networking automatically.
7. Sets up systemd services (Linux) or launchd services (macOS) with auto-restart.
8. Starts all processes.
9. Prints your validator address, public key, node ID, and next steps.

### After installation

The installer prints a summary with your validator details. Save this information. Your validator key is at:

```
~/.cometbft-ensoul/node/config/priv_validator_key.json
```

**Back this file up immediately.** If you lose it, you lose your validator identity.

Your node will begin syncing blocks from the network. Check sync progress:

```bash
curl -s http://localhost:26657/status | python3 -c \
  "import sys,json; d=json.load(sys.stdin)['result']['sync_info']; \
   print(f'Height: {d[\"latest_block_height\"]}, Catching up: {d[\"catching_up\"]}')"
```

Once `catching_up` shows `False`, your node is fully synced and ready to produce blocks (after staking).

---

## 6. Manual Installation

For experienced operators who want full control over every step.

### Step 1: Install Go 1.22+

```bash
# Ubuntu/Debian
curl -sL https://go.dev/dl/go1.23.8.linux-amd64.tar.gz | sudo tar -C /usr/local -xzf -
echo 'export PATH="/usr/local/go/bin:$HOME/go/bin:$PATH"' >> ~/.profile
source ~/.profile
go version
```

### Step 2: Install Node.js 22 and pnpm

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
source ~/.nvm/nvm.sh
nvm install 22
npm install -g pnpm
```

### Step 3: Clone and build

```bash
git clone https://github.com/suitandclaw/ensoul.git ~/ensoul
cd ~/ensoul
pnpm install --frozen-lockfile
pnpm build
```

### Step 4: Install CometBFT

```bash
cd /tmp
git clone --branch v0.38.17 --depth 1 https://github.com/cometbft/cometbft.git
cd cometbft && make install
~/go/bin/cometbft version
# Should print: 0.38.17
```

### Step 5: Install Cosmovisor

```bash
go install cosmossdk.io/tools/cosmovisor/cmd/cosmovisor@v1.5.0
```

### Step 6: Initialize CometBFT

```bash
export CMT_HOME="$HOME/.cometbft-ensoul/node"
~/go/bin/cometbft init --home "$CMT_HOME"
```

### Step 7: Download genesis

```bash
curl -sL https://api.ensoul.dev/genesis -o "$CMT_HOME/config/genesis.json"

# Verify chain ID
cat "$CMT_HOME/config/genesis.json" | python3 -c \
  "import sys,json; print(json.load(sys.stdin)['chain_id'])"
# Should print: ensoul-1
```

### Step 8: Configure CometBFT

Edit `~/.cometbft-ensoul/node/config/config.toml`:

```toml
# Set your validator name
moniker = "your-validator-name"

# ABCI connection
proxy_app = "tcp://127.0.0.1:26658"

# Seed node for peer discovery
seeds = "402a9f5c503c36d0dca5f1a8b7a3a2263efd039a@178.156.199.91:26656"

# Your public IP (auto-detected or set manually)
external_address = "YOUR_PUBLIC_IP:26656"

# Consensus timing
timeout_propose = "3s"
timeout_commit = "1s"
```

### Step 9: Set up Cosmovisor

```bash
export CMT_HOME="$HOME/.cometbft-ensoul/node"
mkdir -p "$CMT_HOME/cosmovisor/genesis/bin" "$CMT_HOME/cosmovisor/upgrades" "$CMT_HOME/backups"
cp ~/go/bin/cometbft "$CMT_HOME/cosmovisor/genesis/bin/cometbft"
```

### Step 10: Create systemd services (Linux)

Create `/etc/systemd/system/ensoul-abci.service`:

```ini
[Unit]
Description=Ensoul ABCI Server
After=network.target

[Service]
Type=simple
User=YOUR_USERNAME
WorkingDirectory=/home/YOUR_USERNAME/ensoul
ExecStart=/home/YOUR_USERNAME/.nvm/versions/node/v22.22.2/bin/npx tsx packages/abci-server/src/index.ts --port 26658
Restart=always
RestartSec=5
StandardOutput=append:/home/YOUR_USERNAME/.ensoul/abci-server.log
StandardError=append:/home/YOUR_USERNAME/.ensoul/abci-server.log

[Install]
WantedBy=multi-user.target
```

Create `/etc/systemd/system/ensoul-cometbft.service`:

```ini
[Unit]
Description=Ensoul CometBFT (via Cosmovisor)
After=ensoul-abci.service
Requires=ensoul-abci.service

[Service]
Type=simple
User=YOUR_USERNAME
Environment=DAEMON_NAME=cometbft
Environment=DAEMON_HOME=/home/YOUR_USERNAME/.cometbft-ensoul/node
Environment=DAEMON_DATA_BACKUP_DIR=/home/YOUR_USERNAME/.cometbft-ensoul/node/backups
Environment=DAEMON_ALLOW_DOWNLOAD_BINARIES=false
Environment=DAEMON_RESTART_AFTER_UPGRADE=true
ExecStart=/home/YOUR_USERNAME/go/bin/cosmovisor run start --proxy_app=tcp://127.0.0.1:26658 --home /home/YOUR_USERNAME/.cometbft-ensoul/node
Restart=always
RestartSec=5
StandardOutput=append:/home/YOUR_USERNAME/.ensoul/cometbft.log
StandardError=append:/home/YOUR_USERNAME/.ensoul/cometbft.log

[Install]
WantedBy=multi-user.target
```

Enable and start:

```bash
sudo systemctl daemon-reload
sudo systemctl enable ensoul-abci ensoul-cometbft
sudo systemctl start ensoul-abci
sleep 5
sudo systemctl start ensoul-cometbft
```

### Step 11: Verify

```bash
# Check CometBFT status
curl -s http://localhost:26657/status | python3 -c \
  "import sys,json; d=json.load(sys.stdin)['result']; \
   print(f'Node ID: {d[\"node_info\"][\"id\"]}'); \
   print(f'Height: {d[\"sync_info\"][\"latest_block_height\"]}'); \
   print(f'Catching up: {d[\"sync_info\"][\"catching_up\"]}'); \
   print(f'Validator: {d[\"validator_info\"][\"address\"]}')"

# Check peer count
curl -s http://localhost:26657/net_info | python3 -c \
  "import sys,json; print(f'Peers: {json.load(sys.stdin)[\"result\"][\"n_peers\"]}')"
```

---

## 7. Staking and Joining the Active Set

After your node is synced (`catching_up: false`), you need ENSL tokens staked to begin producing blocks.

### Getting ENSL for staking

**Pioneer Program:** The first 20 pioneer validators receive a 2,000,000 ENSL delegation from the foundation. Contact the team or use the pioneer registration endpoint.

**Foundation Delegation:** The first 10 standard validators registered each day receive a 100,000 ENSL delegation, enough to begin block production immediately.

**Register your validator:**

```bash
curl -X POST https://api.ensoul.dev/v1/validators/register \
  -H "Content-Type: application/json" \
  -d '{
    "did": "YOUR_DID",
    "publicKey": "YOUR_PUBKEY",
    "name": "your-validator-name"
  }'
```

### How to submit a STAKE transaction

Staking is done by submitting a signed `stake` transaction to the network. You can use the browser wallet at [ensoul.dev/wallet.html](https://ensoul.dev/wallet.html) or submit directly via the API:

```bash
curl -X POST https://api.ensoul.dev/v1/tx/broadcast \
  -H "Content-Type: application/json" \
  -d '{
    "type": "stake",
    "from": "YOUR_DID",
    "amount": "100000000000000000000000",
    "nonce": 0,
    "timestamp": 1234567890000,
    "signature": "YOUR_ED25519_SIGNATURE"
  }'
```

The amount is in wei (18 decimals). 100,000 ENSL = `100000000000000000000000`.

### Verify you are in the active set

```bash
curl -s http://localhost:26657/validators | python3 -c \
  "import sys,json; vs=json.load(sys.stdin)['result']['validators']; \
   [print(f'{v[\"address\"]}: power={v[\"voting_power\"]}') for v in vs]"
```

Your CometBFT address should appear in the list with nonzero voting power.

### Voting power

Voting power is proportional to your total stake (self-staked + delegated). A validator with 10% of total stake proposes approximately 10% of blocks.

### Delegation

Other ENSL holders can delegate tokens to your validator, increasing your voting power. Delegators earn 90% of the block reward attributed to their delegated tokens. You earn 10% commission on their share.

---

## 8. Monitoring Your Validator

### CometBFT RPC endpoints

All of these are accessible at `http://localhost:26657`:

| Endpoint | Description |
|----------|-------------|
| `/status` | Node ID, latest block, sync status, validator info |
| `/validators` | Current validator set with voting power |
| `/net_info` | Connected peers |
| `/consensus_state` | Current consensus round and votes |
| `/health` | Returns 200 if the node is running |

### Check if your validator is signing blocks

```bash
# Get your validator address
ADDR=$(curl -s http://localhost:26657/status | python3 -c \
  "import sys,json; print(json.load(sys.stdin)['result']['validator_info']['address'])")

echo "Your validator address: $ADDR"

# Check latest block for your signature
curl -s http://localhost:26657/block | python3 -c \
  "import sys,json; \
   sigs=json.load(sys.stdin)['result']['block']['last_commit']['signatures']; \
   addrs=[s['validator_address'] for s in sigs if s.get('validator_address')]; \
   print(f'Signers: {len(addrs)}'); \
   print(f'You signed: {\"$ADDR\" in addrs}')"
```

### Check peer count

```bash
curl -s http://localhost:26657/net_info | python3 -c \
  "import sys,json; d=json.load(sys.stdin)['result']; \
   print(f'Peers: {d[\"n_peers\"]}'); \
   [print(f'  {p[\"node_info\"][\"moniker\"]} @ {p[\"remote_ip\"]}') for p in d['peers']]"
```

You should have at least 2 peers. Fewer than 2 may indicate a networking issue.

### Set up alerting

The Ensoul process manager supports push notifications via [ntfy.sh](https://ntfy.sh):

```bash
# Create a topic (use a random string for privacy)
echo "ensoul-validator-$(openssl rand -hex 4)" > ~/.ensoul/ntfy-topic.txt

# Install the ntfy app on your phone and subscribe to the same topic
# The process manager will send alerts for:
#   - Process crashes and restarts
#   - Chain stalls (no new block for 120+ seconds)
#   - Low peer count
#   - Disk space warnings
```

### Sync status

When `catching_up` is `true`, your node is downloading and replaying historical blocks. This is normal on first start. Sync time depends on chain height and your connection speed. For a chain at height 100,000, expect 1 to 4 hours.

---

## 9. Upgrades

### Automatic upgrades with Cosmovisor

Cosmovisor is a process manager that watches for on-chain `SOFTWARE_UPGRADE` proposals. When a proposal passes and the chain reaches the specified upgrade height:

1. CometBFT halts at the upgrade height.
2. Cosmovisor detects the halt and reads the upgrade plan.
3. Cosmovisor swaps in the new binary.
4. CometBFT restarts with the new version.

**You do nothing.** This is fully automatic.

### Verify Cosmovisor is configured

```bash
export DAEMON_NAME=cometbft
export DAEMON_HOME="$HOME/.cometbft-ensoul/node"
~/go/bin/cosmovisor version
```

### What happens if you miss an upgrade

If Cosmovisor is not configured or the new binary is not available, your node halts at the upgrade height and does not restart. You must manually download and install the new binary, then restart CometBFT.

### Manual upgrade (without Cosmovisor)

```bash
# Stop CometBFT
sudo systemctl stop ensoul-cometbft

# Pull latest code and rebuild
cd ~/ensoul
git pull origin main
pnpm install --frozen-lockfile
pnpm build

# Rebuild CometBFT if needed
cd /tmp && git clone --branch NEW_VERSION --depth 1 https://github.com/cometbft/cometbft.git
cd cometbft && make install

# Restart
sudo systemctl start ensoul-cometbft
```

---

## 10. Troubleshooting

### "connection refused" on port 26656

Your firewall is blocking incoming connections or port forwarding is not set up.

```bash
# Check if CometBFT is listening
ss -tlnp | grep 26656

# Open the port (Ubuntu)
sudo ufw allow 26656/tcp

# Test from outside
nc -zv YOUR_PUBLIC_IP 26656
```

### "catching_up: true" for a long time

This is normal on first sync. If your chain is at height 100,000+, sync may take several hours. Monitor progress:

```bash
watch -n 10 'curl -s http://localhost:26657/status | python3 -c \
  "import sys,json; d=json.load(sys.stdin)[\"result\"][\"sync_info\"]; \
   print(f\"Height: {d[\\\"latest_block_height\\\"]}, Catching up: {d[\\\"catching_up\\\"]}\")"'
```

### "app hash mismatch"

This means your ABCI application state diverged from the network. Fix by wiping CometBFT data (not keys) and resyncing:

```bash
sudo systemctl stop ensoul-cometbft ensoul-abci

# Wipe data but keep keys and config
rm -rf ~/.cometbft-ensoul/node/data/*

# Remove ABCI state
rm -rf ~/.ensoul/state.json

sudo systemctl start ensoul-abci
sleep 5
sudo systemctl start ensoul-cometbft
```

### Peer count is 0

```bash
# Verify seed node is configured
grep seeds ~/.cometbft-ensoul/node/config/config.toml

# Should contain:
# seeds = "402a9f5c503c36d0dca5f1a8b7a3a2263efd039a@178.156.199.91:26656"

# Check if you can reach the seed
nc -zv 178.156.199.91 26656
```

### Validator not in active set

Check that you have staked ENSL:

```bash
curl -s https://api.ensoul.dev/v1/account/YOUR_DID | python3 -m json.tool
```

The `staked` field must be nonzero. If it is zero, submit a stake transaction.

### Process keeps crashing

```bash
# Check logs
tail -100 ~/.ensoul/abci-server.log
tail -100 ~/.ensoul/cometbft.log

# Check disk space
df -h

# Check memory
free -h
```

Common causes: out of disk space, out of memory, corrupted state (fix with data wipe above).

---

## 11. Security Best Practices

### Protect your validator key

The file `~/.cometbft-ensoul/node/config/priv_validator_key.json` is your validator identity. If someone else obtains this file, they can impersonate your validator and potentially trigger a double-signing slash.

- **Back it up** to a secure, offline location (encrypted USB drive, password manager).
- **Never share it** with anyone.
- **Never commit it** to a git repository.

### SSH hardening (VPS operators)

```bash
# Use SSH key authentication
ssh-copy-id user@your-vps

# Disable password authentication
sudo sed -i 's/#PasswordAuthentication yes/PasswordAuthentication no/' /etc/ssh/sshd_config
sudo systemctl restart sshd
```

### Firewall configuration

Only open the ports you need:

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow 22/tcp      # SSH
sudo ufw allow 26656/tcp   # CometBFT P2P
sudo ufw enable
```

Do **not** expose port 26657 (RPC) to the internet. It should only be accessible from localhost.

### Keep your OS updated

```bash
# Ubuntu/Debian
sudo apt update && sudo apt upgrade -y

# Or use unattended-upgrades for automatic security patches
sudo apt install unattended-upgrades
```

### Sentry node architecture (advanced)

For DDoS protection, run your validator behind one or more sentry nodes. Sentry nodes are full nodes with public IPs that relay blocks to your validator. Your validator connects only to sentries, never directly to the public internet.

This is an advanced setup typically used by high-stake validators. See the CometBFT documentation on sentry node architecture for details.

---

## 12. FAQ

### How much does it cost to run a validator?

$5 to $25 per month on a cloud VPS. A $5/month Hetzner CX22 is sufficient. Home machines have no monthly cost beyond electricity.

### How much can I earn?

During Year 1, the network emits 100,000,000 ENSL across all validators. With 5 validators, each earns approximately 54,800 ENSL/day. With 50 validators, each earns approximately 5,480 ENSL/day (assuming equal stake). Actual earnings scale with your share of total voting power.

### Can I run a validator on a Raspberry Pi?

Not recommended. The Raspberry Pi 4 has only 1 to 4 GB of RAM and an ARM Cortex-A72 CPU that struggles with the compilation step. Use a proper server or VPS with at least 2 cores and 4 GB RAM.

### Can I run multiple validators on one machine?

Technically possible, but not recommended for production. Each validator needs its own key, data directory, and port range. Running multiple validators on one machine creates a single point of failure.

### What happens if my validator goes offline?

You miss block rewards for every block you do not participate in. There is no slashing penalty for downtime alone. However, extended downtime (90%+ uptime is expected over any 7-day window) may result in the foundation delegation being withdrawn.

### Is my stake at risk?

Stake is only at risk from double-signing (equivocation): signing two different blocks at the same height. This requires either a compromised validator key or running the same key on two machines simultaneously. Normal downtime does not cause slashing.

### How long does initial sync take?

It depends on the chain height. At height 100,000 with a good connection, expect 1 to 4 hours. The node syncs faster as it gets closer to the tip because blocks are smaller and come from local cache.

### How do I know if my validator is working?

```bash
curl -s http://localhost:26657/status | python3 -c \
  "import sys,json; d=json.load(sys.stdin)['result']; \
   print(f'Height: {d[\"sync_info\"][\"latest_block_height\"]}'); \
   print(f'Catching up: {d[\"sync_info\"][\"catching_up\"]}'); \
   print(f'Voting power: {d[\"validator_info\"][\"voting_power\"]}')"
```

If `catching_up` is `False` and `voting_power` is greater than 0, your validator is actively producing blocks.

### Where do I get help?

- GitHub Issues: [github.com/suitandclaw/ensoul/issues](https://github.com/suitandclaw/ensoul/issues)
- Explorer: [explorer.ensoul.dev](https://explorer.ensoul.dev)
- Validator Dashboard: [ensoul.dev/validator-dashboard.html](https://ensoul.dev/validator-dashboard.html)
