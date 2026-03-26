# Remote Access

## Tailscale Mesh Network

All Ensoul machines are connected via Tailscale for secure P2P
communication. CometBFT consensus traffic flows over Tailscale.

| Machine | Tailscale IP | User | Role |
|---|---|---|---|
| MBP | 100.67.81.90 | suitandclaw | Validator V0 (operator) |
| Mini 1 (hamsteronduty) | 100.86.108.114 | hamsteronduty | Validator V5 (operator) |
| Mini 2 (megaphonehq) | 100.117.84.28 | megaphonehq | Validator V15 (operator) |
| Mini 3 (snitchreport) | 100.127.140.26 | snitchreport | Validator V25 (operator) |
| VPS (Hetzner) | 100.72.212.104 | root | Cloud validator |

## SSH Access from MBP

SSH config is at `~/.ssh/config`. Passwordless key-based auth.

```bash
ssh mini1     # hamsteronduty@100.86.108.114
ssh mini2     # megaphonehq@100.117.84.28
ssh mini3     # snitchreport@100.127.140.26
ssh vps1      # root@178.156.199.91
```

## Running Remote Commands

Single command:
```bash
ssh mini1 'curl -s http://localhost:26657/status'
```

With PATH setup (needed for node/go/pnpm):
```bash
ssh mini1 'bash -l -c "cd ~/ensoul && pnpm build"'
```

## Rolling Updates

`scripts/update-all-validators.sh` updates all machines sequentially
via SSH, maintaining quorum throughout:

```bash
./scripts/update-all-validators.sh              # all machines
./scripts/update-all-validators.sh mini1         # single machine
./scripts/update-all-validators.sh --dry-run     # preview
./scripts/update-all-validators.sh --code-only   # pull + build, no restart
```

Update order: mini3, mini2, mini1, mbp (least critical first).
Each machine is health-checked before proceeding to the next.

The script:
1. SSHs into the target machine
2. Runs `git pull origin main`
3. Runs `pnpm install` and `pnpm build`
4. Restarts CometBFT + ABCI if not in code-only mode
5. Verifies the node produces/signs blocks
6. Proceeds to the next machine

## CometBFT Ports

| Port | Service | Access |
|---|---|---|
| 26656 | CometBFT P2P | Tailscale (home), public (VPS) |
| 26657 | CometBFT RPC | Tailscale (home), public (VPS) |
| 26658 | ABCI server | localhost only |
| 9000 | Compat proxy | Cloudflare tunnel |

## Cloudflare Tunnels

Public URLs are served via Cloudflare tunnels, NOT Tailscale.
Each machine runs cloudflared with its own tunnel config.

MBP tunnel: explorer.ensoul.dev, status.ensoul.dev, api.ensoul.dev, v0.ensoul.dev
Mini tunnels: v1.ensoul.dev, v2.ensoul.dev, v3.ensoul.dev
