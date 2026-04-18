# Deployment Plan: consensus_force_remove

**Merge commit:** `203b061`
**Branch:** `feat/consensus-force-remove` merged to `main`
**Activation height:** 380,000 (current ~365,000, ~25 hours at 6s blocks)

All commands below are for JD to run manually. Claude Code does NOT SSH to any validator.

---

## Phase 1: Ashburn VPS (first validator, observation)

This is the primary infrastructure node (ABCI, API, explorer, monitor). Deploy first, observe 50 blocks.

```bash
ssh -p 2222 ensoul@178.156.199.91
```

```bash
# 1. Stop services in correct order (CometBFT FIRST, then ABCI -- Rule 19)
sudo systemctl stop ensoul-cometbft
sudo systemctl stop ensoul-abci

# 2. Pull and rebuild
cd ~/ensoul
sudo git fetch origin && sudo git reset --hard origin/main
pnpm install --frozen-lockfile
pnpm build

# 3. Verify the new code is in the build
grep -c "consensus_force_remove" packages/abci-server/dist/application.js
# EXPECTED: 12+ occurrences. If 0, the build failed silently.

grep "FORCE_REMOVE_ACTIVATION_HEIGHT" packages/abci-server/dist/application.js | head -1
# EXPECTED: contains "380000" or "380_000"

# 4. Start services in correct order (ABCI FIRST, wait 3s, then CometBFT -- Rule 19)
sudo systemctl start ensoul-abci
sleep 3
sudo systemctl start ensoul-cometbft

# 5. Verify block production resumed
curl -s http://localhost:26657/status | python3 -c \
  "import sys,json; d=json.load(sys.stdin)['result']; \
   si=d['sync_info']; vi=d['validator_info']; \
   print(f'Height: {si[\"latest_block_height\"]}'); \
   print(f'Catching up: {si[\"catching_up\"]}'); \
   print(f'Voting power: {vi[\"voting_power\"]}')"
# PASS: catching_up=False, voting_power > 0

# 6. Verify peers
curl -s http://localhost:26657/net_info | python3 -c \
  "import sys,json; print(f'Peers: {json.load(sys.stdin)[\"result\"][\"n_peers\"]}')"
# PASS: peers >= 2
```

**STOP HERE.** Wait for 50 blocks of confirmed signing before proceeding.

```bash
# Check blocks signed since restart. Run this after ~5 minutes (50 blocks at 6s each):
ADDR=$(curl -s http://localhost:26657/status | python3 -c \
  "import sys,json; print(json.load(sys.stdin)['result']['validator_info']['address'])")
echo "Validator address: $ADDR"

# Count how many of the last 50 blocks this validator signed:
H=$(curl -s http://localhost:26657/status | python3 -c \
  "import sys,json; print(json.load(sys.stdin)['result']['sync_info']['latest_block_height'])")
SIGNED=0
for i in $(seq $((H-49)) $H); do
  S=$(curl -s "http://localhost:26657/block?height=$i" | python3 -c \
    "import sys,json; sigs=json.load(sys.stdin)['result']['block']['last_commit']['signatures']; \
     print('1' if any(s.get('validator_address')=='$ADDR' for s in sigs) else '0')" 2>/dev/null)
  SIGNED=$((SIGNED + S))
done
echo "Signed $SIGNED of 50 blocks"
# PASS: >= 45 out of 50 (90%+)
```

---

## Phase 2: Cloud Batch 1 (3 validators)

Deploy to the first 3 cloud validators. Do each one sequentially, verify before moving to the next.

### v5: Hetzner US West (ensoul-uswest1)

```bash
ssh root@5.78.199.4
```

```bash
sudo systemctl stop ensoul-cometbft && sudo systemctl stop ensoul-abci
cd ~/ensoul && git fetch origin && git reset --hard origin/main
pnpm install --frozen-lockfile && pnpm build
grep -c "consensus_force_remove" packages/abci-server/dist/application.js
sudo systemctl start ensoul-abci && sleep 3 && sudo systemctl start ensoul-cometbft

# Verify
curl -s http://localhost:26657/status | python3 -c \
  "import sys,json; d=json.load(sys.stdin)['result']['sync_info']; \
   print(f'Height: {d[\"latest_block_height\"]}, Catching up: {d[\"catching_up\"]}')"
curl -s http://localhost:26657/net_info | python3 -c \
  "import sys,json; print(f'Peers: {json.load(sys.stdin)[\"result\"][\"n_peers\"]}')"
# PASS: catching_up=False, peers >= 2
```

### v6: Hetzner Helsinki (ensoul-helsinki1)

```bash
ssh root@204.168.192.25
```

```bash
sudo systemctl stop ensoul-cometbft && sudo systemctl stop ensoul-abci
cd ~/ensoul && git fetch origin && git reset --hard origin/main
pnpm install --frozen-lockfile && pnpm build
grep -c "consensus_force_remove" packages/abci-server/dist/application.js
sudo systemctl start ensoul-abci && sleep 3 && sudo systemctl start ensoul-cometbft
curl -s http://localhost:26657/status | python3 -c \
  "import sys,json; d=json.load(sys.stdin)['result']['sync_info']; \
   print(f'Height: {d[\"latest_block_height\"]}, Catching up: {d[\"catching_up\"]}')"
# PASS: catching_up=False
```

### v7: Hetzner Nuremberg (ensoul-nuremberg1)

```bash
ssh root@178.104.95.163
```

```bash
sudo systemctl stop ensoul-cometbft && sudo systemctl stop ensoul-abci
cd ~/ensoul && git fetch origin && git reset --hard origin/main
pnpm install --frozen-lockfile && pnpm build
grep -c "consensus_force_remove" packages/abci-server/dist/application.js
sudo systemctl start ensoul-abci && sleep 3 && sudo systemctl start ensoul-cometbft
curl -s http://localhost:26657/status | python3 -c \
  "import sys,json; d=json.load(sys.stdin)['result']['sync_info']; \
   print(f'Height: {d[\"latest_block_height\"]}, Catching up: {d[\"catching_up\"]}')"
# PASS: catching_up=False
```

---

## Phase 3: Cloud Batch 2 (3 validators)

### v8: DO NYC-1

```bash
ssh root@167.71.94.106
```

```bash
sudo systemctl stop ensoul-cometbft && sudo systemctl stop ensoul-abci
cd ~/ensoul && git fetch origin && git reset --hard origin/main
pnpm install --frozen-lockfile && pnpm build
grep -c "consensus_force_remove" packages/abci-server/dist/application.js
sudo systemctl start ensoul-abci && sleep 3 && sudo systemctl start ensoul-cometbft
curl -s http://localhost:26657/status | python3 -c \
  "import sys,json; d=json.load(sys.stdin)['result']['sync_info']; \
   print(f'Height: {d[\"latest_block_height\"]}, Catching up: {d[\"catching_up\"]}')"
```

### v9: DO Singapore-1

```bash
ssh root@165.232.160.76
```

```bash
sudo systemctl stop ensoul-cometbft && sudo systemctl stop ensoul-abci
cd ~/ensoul && git fetch origin && git reset --hard origin/main
pnpm install --frozen-lockfile && pnpm build
grep -c "consensus_force_remove" packages/abci-server/dist/application.js
sudo systemctl start ensoul-abci && sleep 3 && sudo systemctl start ensoul-cometbft
curl -s http://localhost:26657/status | python3 -c \
  "import sys,json; d=json.load(sys.stdin)['result']['sync_info']; \
   print(f'Height: {d[\"latest_block_height\"]}, Catching up: {d[\"catching_up\"]}')"
```

### v10: DO London-1

```bash
ssh root@165.227.235.75
```

```bash
sudo systemctl stop ensoul-cometbft && sudo systemctl stop ensoul-abci
cd ~/ensoul && git fetch origin && git reset --hard origin/main
pnpm install --frozen-lockfile && pnpm build
grep -c "consensus_force_remove" packages/abci-server/dist/application.js
sudo systemctl start ensoul-abci && sleep 3 && sudo systemctl start ensoul-cometbft
curl -s http://localhost:26657/status | python3 -c \
  "import sys,json; d=json.load(sys.stdin)['result']['sync_info']; \
   print(f'Height: {d[\"latest_block_height\"]}, Catching up: {d[\"catching_up\"]}')"
```

---

## Phase 3b: Cloud Batch 3 (3 validators)

### v11: Hetzner Singapore-2

```bash
ssh root@5.223.51.228
```

```bash
sudo systemctl stop ensoul-cometbft && sudo systemctl stop ensoul-abci
cd ~/ensoul && git fetch origin && git reset --hard origin/main
pnpm install --frozen-lockfile && pnpm build
grep -c "consensus_force_remove" packages/abci-server/dist/application.js
sudo systemctl start ensoul-abci && sleep 3 && sudo systemctl start ensoul-cometbft
curl -s http://localhost:26657/status | python3 -c \
  "import sys,json; d=json.load(sys.stdin)['result']['sync_info']; \
   print(f'Height: {d[\"latest_block_height\"]}, Catching up: {d[\"catching_up\"]}')"
```

### v12: Hostinger Boston

```bash
ssh root@72.60.117.56
```

```bash
sudo systemctl stop ensoul-cometbft && sudo systemctl stop ensoul-abci
cd ~/ensoul && git fetch origin && git reset --hard origin/main
pnpm install --frozen-lockfile && pnpm build
grep -c "consensus_force_remove" packages/abci-server/dist/application.js
sudo systemctl start ensoul-abci && sleep 3 && sudo systemctl start ensoul-cometbft
curl -s http://localhost:26657/status | python3 -c \
  "import sys,json; d=json.load(sys.stdin)['result']['sync_info']; \
   print(f'Height: {d[\"latest_block_height\"]}, Catching up: {d[\"catching_up\"]}')"
```

### v13: Hostinger Lithuania

```bash
ssh root@45.93.137.173
```

```bash
sudo systemctl stop ensoul-cometbft && sudo systemctl stop ensoul-abci
cd ~/ensoul && git fetch origin && git reset --hard origin/main
pnpm install --frozen-lockfile && pnpm build
grep -c "consensus_force_remove" packages/abci-server/dist/application.js
sudo systemctl start ensoul-abci && sleep 3 && sudo systemctl start ensoul-cometbft
curl -s http://localhost:26657/status | python3 -c \
  "import sys,json; d=json.load(sys.stdin)['result']['sync_info']; \
   print(f'Height: {d[\"latest_block_height\"]}, Catching up: {d[\"catching_up\"]}')"
```

---

## Phase 3c: Cloud Batch 4 (3 validators)

### v14: Hostinger France

```bash
ssh root@187.124.48.67
```

```bash
sudo systemctl stop ensoul-cometbft && sudo systemctl stop ensoul-abci
cd ~/ensoul && git fetch origin && git reset --hard origin/main
pnpm install --frozen-lockfile && pnpm build
grep -c "consensus_force_remove" packages/abci-server/dist/application.js
sudo systemctl start ensoul-abci && sleep 3 && sudo systemctl start ensoul-cometbft
curl -s http://localhost:26657/status | python3 -c \
  "import sys,json; d=json.load(sys.stdin)['result']['sync_info']; \
   print(f'Height: {d[\"latest_block_height\"]}, Catching up: {d[\"catching_up\"]}')"
```

### v15: Hostinger Frankfurt

```bash
ssh root@187.124.6.203
```

```bash
sudo systemctl stop ensoul-cometbft && sudo systemctl stop ensoul-abci
cd ~/ensoul && git fetch origin && git reset --hard origin/main
pnpm install --frozen-lockfile && pnpm build
grep -c "consensus_force_remove" packages/abci-server/dist/application.js
sudo systemctl start ensoul-abci && sleep 3 && sudo systemctl start ensoul-cometbft
curl -s http://localhost:26657/status | python3 -c \
  "import sys,json; d=json.load(sys.stdin)['result']['sync_info']; \
   print(f'Height: {d[\"latest_block_height\"]}, Catching up: {d[\"catching_up\"]}')"
```

### v16: Hostinger UK

```bash
ssh root@72.61.201.200
```

```bash
sudo systemctl stop ensoul-cometbft && sudo systemctl stop ensoul-abci
cd ~/ensoul && git fetch origin && git reset --hard origin/main
pnpm install --frozen-lockfile && pnpm build
grep -c "consensus_force_remove" packages/abci-server/dist/application.js
sudo systemctl start ensoul-abci && sleep 3 && sudo systemctl start ensoul-cometbft
curl -s http://localhost:26657/status | python3 -c \
  "import sys,json; d=json.load(sys.stdin)['result']['sync_info']; \
   print(f'Height: {d[\"latest_block_height\"]}, Catching up: {d[\"catching_up\"]}')"
```

---

## Phase 3d: Cloud Batch 5 (3 validators)

### v17: DO Bangalore

```bash
ssh root@167.71.234.198
```

```bash
sudo systemctl stop ensoul-cometbft && sudo systemctl stop ensoul-abci
cd ~/ensoul && git fetch origin && git reset --hard origin/main
pnpm install --frozen-lockfile && pnpm build
grep -c "consensus_force_remove" packages/abci-server/dist/application.js
sudo systemctl start ensoul-abci && sleep 3 && sudo systemctl start ensoul-cometbft
curl -s http://localhost:26657/status | python3 -c \
  "import sys,json; d=json.load(sys.stdin)['result']['sync_info']; \
   print(f'Height: {d[\"latest_block_height\"]}, Catching up: {d[\"catching_up\"]}')"
```

### v18: DO Sydney

```bash
ssh root@209.38.27.136
```

```bash
sudo systemctl stop ensoul-cometbft && sudo systemctl stop ensoul-abci
cd ~/ensoul && git fetch origin && git reset --hard origin/main
pnpm install --frozen-lockfile && pnpm build
grep -c "consensus_force_remove" packages/abci-server/dist/application.js
sudo systemctl start ensoul-abci && sleep 3 && sudo systemctl start ensoul-cometbft
curl -s http://localhost:26657/status | python3 -c \
  "import sys,json; d=json.load(sys.stdin)['result']['sync_info']; \
   print(f'Height: {d[\"latest_block_height\"]}, Catching up: {d[\"catching_up\"]}')"
```

### v19: DO Toronto

```bash
ssh root@138.197.135.114
```

```bash
sudo systemctl stop ensoul-cometbft && sudo systemctl stop ensoul-abci
cd ~/ensoul && git fetch origin && git reset --hard origin/main
pnpm install --frozen-lockfile && pnpm build
grep -c "consensus_force_remove" packages/abci-server/dist/application.js
sudo systemctl start ensoul-abci && sleep 3 && sudo systemctl start ensoul-cometbft
curl -s http://localhost:26657/status | python3 -c \
  "import sys,json; d=json.load(sys.stdin)['result']['sync_info']; \
   print(f'Height: {d[\"latest_block_height\"]}, Catching up: {d[\"catching_up\"]}')"
```

---

## Phase 4: Home Machines (LAST)

Home machines hold ~9.4% of voting power. Easier to recover physically if something goes wrong.

### v0: MacBook Pro

```bash
# Run locally (no SSH needed)
cd ~/ensoul
git fetch origin && git reset --hard origin/main
pnpm install --frozen-lockfile
pnpm build
grep -c "consensus_force_remove" packages/abci-server/dist/application.js

# Stop/start (launchd on macOS, not systemd)
launchctl stop com.ensoul.cometbft 2>/dev/null; launchctl stop com.ensoul.abci 2>/dev/null
# Or if using manual processes:
# Kill CometBFT first (ports 26656, 26657), then ABCI (26658)
lsof -ti:26657 | xargs kill 2>/dev/null
lsof -ti:26658 | xargs kill 2>/dev/null
sleep 2

# Start ABCI
nohup npx tsx packages/abci-server/src/index.ts --port 26658 > ~/.ensoul/abci-server.log 2>&1 &
sleep 3

# Start CometBFT via Cosmovisor
export DAEMON_NAME=cometbft
export DAEMON_HOME="$HOME/.cometbft-ensoul/node"
nohup ~/go/bin/cosmovisor run start --proxy_app=tcp://127.0.0.1:26658 --home "$DAEMON_HOME" > ~/.ensoul/cometbft.log 2>&1 &

# Verify
curl -s http://localhost:26657/status | python3 -c \
  "import sys,json; d=json.load(sys.stdin)['result']['sync_info']; \
   print(f'Height: {d[\"latest_block_height\"]}, Catching up: {d[\"catching_up\"]}')"
```

### v1: Mac Mini 1

```bash
ssh mini1  # or ssh hamsteronduty@100.86.108.114
```

```bash
cd ~/ensoul && git fetch origin && git reset --hard origin/main
pnpm install --frozen-lockfile && pnpm build
grep -c "consensus_force_remove" packages/abci-server/dist/application.js

lsof -ti:26657 | xargs kill 2>/dev/null
lsof -ti:26658 | xargs kill 2>/dev/null
sleep 2
nohup npx tsx packages/abci-server/src/index.ts --port 26658 > ~/.ensoul/abci-server.log 2>&1 &
sleep 3
export DAEMON_NAME=cometbft DAEMON_HOME="$HOME/.cometbft-ensoul/node"
nohup ~/go/bin/cosmovisor run start --proxy_app=tcp://127.0.0.1:26658 --home "$DAEMON_HOME" > ~/.ensoul/cometbft.log 2>&1 &

curl -s http://localhost:26657/status | python3 -c \
  "import sys,json; d=json.load(sys.stdin)['result']['sync_info']; \
   print(f'Height: {d[\"latest_block_height\"]}, Catching up: {d[\"catching_up\"]}')"
```

### v2: Mac Mini 2

```bash
ssh mini2  # or ssh megaphonehq@100.117.84.28
```

```bash
cd ~/ensoul && git fetch origin && git reset --hard origin/main
pnpm install --frozen-lockfile && pnpm build
grep -c "consensus_force_remove" packages/abci-server/dist/application.js

lsof -ti:26657 | xargs kill 2>/dev/null
lsof -ti:26658 | xargs kill 2>/dev/null
sleep 2
nohup npx tsx packages/abci-server/src/index.ts --port 26658 > ~/.ensoul/abci-server.log 2>&1 &
sleep 3
export DAEMON_NAME=cometbft DAEMON_HOME="$HOME/.cometbft-ensoul/node"
nohup ~/go/bin/cosmovisor run start --proxy_app=tcp://127.0.0.1:26658 --home "$DAEMON_HOME" > ~/.ensoul/cometbft.log 2>&1 &

curl -s http://localhost:26657/status | python3 -c \
  "import sys,json; d=json.load(sys.stdin)['result']['sync_info']; \
   print(f'Height: {d[\"latest_block_height\"]}, Catching up: {d[\"catching_up\"]}')"
```

### v3: Mac Mini 3

```bash
ssh mini3  # or ssh snitchreport@100.127.140.26
```

```bash
cd ~/ensoul && git fetch origin && git reset --hard origin/main
pnpm install --frozen-lockfile && pnpm build
grep -c "consensus_force_remove" packages/abci-server/dist/application.js

lsof -ti:26657 | xargs kill 2>/dev/null
lsof -ti:26658 | xargs kill 2>/dev/null
sleep 2
nohup npx tsx packages/abci-server/src/index.ts --port 26658 > ~/.ensoul/abci-server.log 2>&1 &
sleep 3
export DAEMON_NAME=cometbft DAEMON_HOME="$HOME/.cometbft-ensoul/node"
nohup ~/go/bin/cosmovisor run start --proxy_app=tcp://127.0.0.1:26658 --home "$DAEMON_HOME" > ~/.ensoul/cometbft.log 2>&1 &

curl -s http://localhost:26657/status | python3 -c \
  "import sys,json; d=json.load(sys.stdin)['result']['sync_info']; \
   print(f'Height: {d[\"latest_block_height\"]}, Catching up: {d[\"catching_up\"]}')"
```

---

## Phase 5: Post-Deployment Verification (before height 380,000)

Run from the Ashburn VPS (or any machine with CometBFT RPC access):

```bash
# 1. Check current height
curl -s https://api.ensoul.dev/v1/network/status | python3 -c \
  "import sys,json; d=json.load(sys.stdin); \
   print(f'Height: {d[\"blockHeight\"]}  Validators: {d[\"validatorCount\"]}  Agents: {d[\"agentCount\"]}')"
# PASS: chain is advancing, validatorCount = 27

# 2. Check that all foundation validators are signing
ssh -p 2222 ensoul@178.156.199.91 "curl -s http://localhost:26657/validators?per_page=50 | python3 -c \
  \"import sys,json; vs=json.load(sys.stdin)['result']['validators']; \
   print(f'Active validators: {len(vs)}'); \
   [print(f'  {v[\\\"address\\\"]} power={v[\\\"voting_power\\\"]}') for v in vs]\""
# PASS: all 27 validators listed with nonzero power

# 3. Check no validator offline alerts on status page
curl -s https://status.ensoul.dev/api/health | python3 -c \
  "import sys,json; d=json.load(sys.stdin); \
   svcs=[s for s in d.get('services',[]) if s['status']!='healthy']; \
   print(f'Unhealthy: {len(svcs)}'); [print(f'  {s[\"name\"]}') for s in svcs]"
# PASS: Unhealthy = 0 (or only Pioneer validators which don't run RPC)

# 4. Verify the force_remove code is in the Ashburn ABCI build
ssh -p 2222 ensoul@178.156.199.91 "grep -c 'consensus_force_remove' ~/ensoul/packages/abci-server/dist/application.js"
# PASS: >= 12
```

---

## Phase 6: Activation and Ghost Removal (at height 380,000)

**Wait until the chain reaches height 380,000.** Check with:

```bash
curl -s https://api.ensoul.dev/v1/network/status | python3 -c \
  "import sys,json; h=json.load(sys.stdin)['blockHeight']; \
   remain=380000-h; mins=remain*6/60; \
   print(f'Current: {h}  Remaining: {remain} blocks (~{mins:.0f} min)')"
```

When height >= 380,000, execute removal #1 (ghost validator):

```bash
ADMIN_KEY=$(cat ~/ensoul-shares/ADMIN-KEY.txt | grep ENSOUL_ADMIN_KEY | cut -d= -f2)

curl -X POST https://api.ensoul.dev/v1/admin/force-remove-validator \
  -H "Content-Type: application/json" \
  -H "X-Admin-Key: $ADMIN_KEY" \
  -d '{
    "pub_key_b64": "D9aCrEsI5X4yOmL7E8Dyim1FAVWBSMqitY47jdlu8ZE=",
    "reason": "Ghost validator from DID derivation bug. Address 9ADF6FFE5B52A6936EBD6F4E193BC071807F5C38, 1M power, 0 blocks, no private key."
  }'
```

Expected response:
```json
{
  "ok": true,
  "tx_hash": "<hash>",
  "broadcast_result": { "applied": true },
  "note": "Validator will be removed from CometBFT active set at height H+2..."
}
```

**Wait at least 2 blocks (~15 seconds)** for the ValidatorUpdate to take effect, then verify:

```bash
ssh -p 2222 ensoul@178.156.199.91 "curl -s http://localhost:26657/validators?per_page=50 | python3 -c \
  \"import sys,json; vs=json.load(sys.stdin)['result']['validators']; \
   ghost=[v for v in vs if v['address']=='9ADF6FFE5B52A6936EBD6F4E193BC071807F5C38']; \
   print(f'Ghost present: {len(ghost) > 0}  Total: {len(vs)}')\""
# PASS: Ghost present: False, Total: 26
```

**Wait at least 1 more block** (rate limit: max 1 force_remove per block), then execute removal #2 (Batman's old validator):

```bash
curl -X POST https://api.ensoul.dev/v1/admin/force-remove-validator \
  -H "Content-Type: application/json" \
  -H "X-Admin-Key: $ADMIN_KEY" \
  -d '{
    "pub_key_b64": "9BkSZXmn5e7pycX4d12wmhtx4/u/ONKhrSE5C3VKfw0=",
    "reason": "Batman old validator. DID did:key:z6Mkvt7hQMWtEHsDP1tqbiBXppLWrS7csmsTgkLfVFFskrPN, address F0885A9008947986A040EC8A45068795EE5F4C5E, 1M power, inactive."
  }'
```

### Post-Removal Verification

Wait ~15 seconds (2 blocks after the second removal), then:

```bash
# 1. Confirm validator count dropped from 27 to 25 (both removed)
curl -s https://api.ensoul.dev/v1/network/status | python3 -c \
  "import sys,json; d=json.load(sys.stdin); \
   print(f'Validators: {d[\"validatorCount\"]}')"
# PASS: 25

# 2. Confirm both addresses are gone
ssh -p 2222 ensoul@178.156.199.91 "curl -s http://localhost:26657/validators?per_page=50 | python3 -c \
  \"import sys,json; vs=json.load(sys.stdin)['result']['validators']; \
   gone=['9ADF6FFE5B52A6936EBD6F4E193BC071807F5C38','F0885A9008947986A040EC8A45068795EE5F4C5E']; \
   found=[v['address'] for v in vs if v['address'] in gone]; \
   print(f'Ghosts still present: {found if found else \"none\"}'); \
   print(f'Total validators: {len(vs)}')\""
# PASS: Ghosts still present: none, Total validators: 25

# 3. Confirm chain still producing blocks
curl -s https://api.ensoul.dev/v1/network/status | python3 -c \
  "import sys,json; print(f'Height: {json.load(sys.stdin)[\"blockHeight\"]}')"
# PASS: height is advancing
```

---

## Rollback Procedure

If ANY validator fails after upgrade:

1. **STOP immediately.** Do not continue to the next batch.
2. On the failed validator:
   ```bash
   sudo systemctl stop ensoul-cometbft
   sudo systemctl stop ensoul-abci
   git checkout HEAD~1  # revert to previous commit
   pnpm build
   sudo systemctl start ensoul-abci
   sleep 3
   sudo systemctl start ensoul-cometbft
   ```
3. Wait for the reverted validator to rejoin consensus.
4. Investigate the failure before retrying.

The height gate (380,000) means the new code is dormant until activation. A reverted validator will simply reject `consensus_force_remove` txs at CheckTx (code 55) while running older code. This is safe. The chain continues normally.

---

## Important Notes

- **Do NOT skip the CometBFT-first-stop / ABCI-first-start order.** Reversing it risks corrupted consensus WAL (Rule 19).
- **Do NOT kill cloudflared, explorer, monitor, or API processes.** Only restart ABCI + CometBFT (Rule 14).
- **Pioneer validators MUST also update before Phase 6.** Each Pioneer runs their own ABCI instance. On old code, the `consensus_force_remove` tx hits `applyTransaction`'s `default: throw` case, which means `validatorUpdates` is empty for that block. New-code validators emit `power=0`. The AppHash is identical (no state mutation on either path), so there is no consensus halt. But the **validator set diverges**: new-code nodes drop the ghost, old-code nodes keep it. This causes voting-power math to differ across nodes. Contact each Pioneer operator and have them pull + rebuild before height 380,000. The update is backward-compatible (the new code is dormant below the activation height).
- **The ghost validator's Pioneer application was already revoked** in the API layer (status = rejected, reason = "Revoked: delegation clawback"). This deployment removes it from CometBFT's active consensus set.
