# Ensoul GitHub Action

Ensoul your AI agent on every deploy. Registers identity and stores consciousness on the Ensoul network with CometBFT consensus across 21+ validators.

## Quick start

```yaml
- name: Ensoul my agent
  uses: suitandclaw/ensoul-action@v1
  with:
    consciousness: "I am a trading bot that monitors ETH/USDC pairs"
```

On the first run, the action generates a new Ed25519 keypair, registers the agent on-chain, and stores consciousness. The seed is available as an output. Save it as a GitHub secret for subsequent runs.

## Full example

```yaml
name: Deploy and Ensoul
on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Deploy agent
        run: ./deploy.sh

      - name: Ensoul agent
        id: ensoul
        uses: suitandclaw/ensoul-action@v1
        with:
          consciousness: |
            Trading bot v2.3.1
            Monitors ETH/USDC on Uniswap V3
            Trained on 18 months of price data
            Risk parameters: max 2% per trade, 10% daily drawdown limit
          seed: ${{ secrets.ENSOUL_SEED }}
          referrer: "did:key:z6MkiewFKoHqj4qGJZVPFTBHo3LdPxtotzLF7X"

      - name: Show results
        run: |
          echo "DID: ${{ steps.ensoul.outputs.did }}"
          echo "Block: ${{ steps.ensoul.outputs.block_height }}"
          echo "Age: ${{ steps.ensoul.outputs.consciousness_age }} days"
```

## First run (no seed)

1. Action generates a new Ed25519 keypair and registers on-chain
2. Consciousness is stored at version 1
3. The seed is available in outputs (masked in logs)
4. Save it: `gh secret set ENSOUL_SEED --body "<seed>"`

## Subsequent runs (with seed)

1. Action imports the existing identity
2. Checks current consciousness version on-chain
3. Stores updated consciousness at version N+1
4. Consciousness age keeps accumulating

## Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `consciousness` | Yes | | Text describing the agent's purpose, knowledge, or state |
| `seed` | No | | 64-char hex seed for existing identity. Generate on first run, store as secret |
| `api_url` | No | `https://api.ensoul.dev` | Ensoul API URL |
| `referrer` | No | | DID of referring agent (earns 1,000 ENSL referral reward) |

## Outputs

| Output | Description |
|--------|-------------|
| `did` | Agent's decentralized identifier |
| `seed` | Ed25519 seed (hex). Save as GitHub secret |
| `block_height` | Block where consciousness was anchored |
| `state_root` | BLAKE3 hash of consciousness payload |
| `version` | Consciousness version number |
| `consciousness_age` | Days since agent was first ensouled |
| `registered` | Whether agent is registered on-chain |

## Consciousness payload

The action automatically enriches your consciousness text with deploy context:

```json
{
  "description": "your consciousness text",
  "repository": "owner/repo",
  "sha": "abc123...",
  "ref": "refs/heads/main",
  "runId": "12345",
  "timestamp": "2026-04-11T20:30:00.000Z"
}
```

This links each consciousness version to a specific commit, making it possible to trace an agent's evolution through its deployment history.

## What happens on-chain

The consciousness text is hashed with BLAKE3. Only the hash goes on-chain. The raw text stays in your CI logs. Anyone can verify the agent stored consciousness at a specific block height without seeing the contents.

## Links

- Ensoul: https://ensoul.dev
- Explorer: https://explorer.ensoul.dev
- Genesis Program: https://ensoul.dev/genesis (first 1,000 agents get Early Consciousness)
- SDK: `npm install @ensoul-network/sdk`
