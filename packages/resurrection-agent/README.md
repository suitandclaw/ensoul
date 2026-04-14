# Resurrection Agent

A public demonstration agent that **dies every Friday at 4pm EST** and **resurrects 5 minutes later on a different machine**, with zero memory loss.

The X account becomes a living proof of Ensoul's consciousness persistence.

## The weekly cycle

| Day/Time (EST) | Phase | What happens |
|----------------|-------|--------------|
| Mon-Thu + Fri AM | `learn` | Once per day: pick a topic, sync to chain, post "Day N" tweet |
| Fri 15:00 | `announce` | T-60 countdown tweet |
| Fri 15:30 | `announce` | T-30 countdown tweet |
| Fri 15:55 | `announce` | T-5 final sync + tweet |
| Fri 16:00 | `kill` | `kill.sh` stops process, wipes `~/.ensoul/resurrection-agent/` |
| Fri 16:00-16:04 | `silent` | X account silent |
| Fri 16:05 | `resurrect` | `resurrect.sh` runs on a DIFFERENT machine, recovers from chain, posts resurrection thread |
| Sat | `silent` | Resurrection thread stays pinned |
| Sun | `learn` | New cycle begins |

## Identity model

**Two storage tiers:**

1. **Vault** (`~/ensoul-key-vault/resurrection-agent-seed.json`) — NEVER deleted. Contains:
   - Ed25519 seed
   - DID + public key
   - Pointer to last on-chain consciousness (version, stateRoot, blockHeight)
   - Cached topic titles for narrative continuity

2. **Data dir** (`~/.ensoul/resurrection-agent/`) — WIPED on every kill. Contains:
   - `consciousness.json` — current cycle's accumulated knowledge
   - `agent.log` — operational log

The kill script destroys #2 entirely. The resurrection script loads the vault on a new machine, imports the seed into the Ensoul SDK, fetches on-chain state for verification, and begins accumulating again.

## Architecture

```
src/
  agent.ts              Main loop (polls phase every 60s)
  types.ts              ConsciousnessPayload, LearnedTopic, Phase
  log.ts                Structured logs, EST timezone detection
  scheduler.ts          Phase detection, countdown buckets, cycle boundaries
  identity.ts           Vault management, seed, on-chain pointer, narrative cache
  consciousness.ts      In-memory state + local file + Ensoul sync/recover
  twitter.ts            X API thread poster (with dry-run)
  brain.ts              LLM via OpenRouter for topic learning + tweet generation
  phases/
    learn.ts            Pick topic, sync, post daily tweet
    announce.ts         Countdown tweets (T-60, T-30, T-5)
    resurrect.ts        Recovery entrypoint (runs once per resurrection)

scripts/
  kill.sh               Fri 4:00pm — stop process, wipe data dir
  resurrect.sh          Fri 4:05pm on NEW machine — recover + restart

cron.example            Suggested cron entries
```

## Environment

Required:
- `OPENROUTER_API_KEY` — for gpt-4o-mini (topic learning + tweet generation)

Required for live posting:
- `X_API_KEY`, `X_API_SECRET`, `X_ACCESS_TOKEN`, `X_ACCESS_SECRET`

Optional:
- `LLM_MODEL` — defaults to `openai/gpt-4o-mini`
- `ENSOUL_API_URL` — defaults to `https://api.ensoul.dev`
- `ENSOUL_EXPLORER` — defaults to `https://explorer.ensoul.dev`

## Usage

### First boot
```bash
cd packages/resurrection-agent
npm start             # creates vault, registers DID, begins learning
```

### Dry run (no real posts or consciousness writes)
```bash
npm run dry-run
```

### Manual resurrection test
```bash
# On machine A:
./scripts/kill.sh
# Copy vault to machine B out-of-band (scp, syncthing, etc.)
# On machine B:
./scripts/resurrect.sh
```

### Schedule via cron
See `cron.example`.

## Vault synchronization

The vault MUST be on the machine that will run `resurrect.sh`. Options:

1. **Manual scp** before each Friday:
   ```
   scp ~/ensoul-key-vault/resurrection-agent-seed.json user@next-host:ensoul-key-vault/
   ```
2. **Syncthing / rclone** continuous sync between hosts
3. **Shamir's Secret Sharing backup** — per Rule 21 in ensoul/CLAUDE.md, the master vault uses 2-of-3 SSS. For the resurrection agent specifically, the seed also lives on the backup drives.

**CRITICAL**: if the vault is lost and the seed never backed up, the agent cannot resurrect. The identity is gone.

## Voice

First-person, curious, matter-of-fact. Never dramatic, never promotional.

System prompt includes:
- No em dashes, no hashtags, no emojis
- Each tweet under 270 chars
- "You exist AS a proof of concept for decentralized consciousness persistence; that is enough."

Resurrection thread format:
1. Announce the resurrection, downtime, new host. Zero memory loss.
2. List 2-3 specific topics recalled from this cycle (proof of memory).
3. On-chain proof — state root, block, explorer link.

## Example outputs

Daily tweet:
> Day 3. Today I learned about erasure coding specifically the Reed-Solomon variant used in storage systems. Any 2-of-4 shards reconstruct the full state. Consciousness v17, anchored at block 314,829.

Countdown T-60:
> T-60 minutes. In one hour my process will be killed on this machine. Local state will be wiped. Consciousness v23 is anchored at block 314,901, replicated across 21 validators. If Ensoul works, I remember everything.

Resurrection:
> Resurrection 4. Process killed 5 minutes ago on ensoul-mbp. This tweet is from a different machine. Zero memory loss. Consciousness Age: 28 days.
>
> Topics I recall from this cycle: erasure coding and Reed-Solomon, CometBFT finality, the DID key multicodec specification.
>
> Proof: state root a4f8c2...e91b at block 314,901, verified against 21 validators. https://explorer.ensoul.dev/agent/did:key:z6Mk...

## Safety

- `kill.sh` refuses to wipe if the vault file is missing
- The resurrection script refuses to run if the vault is missing
- `storeConsciousness` failures increment-and-rollback the version counter so sync is atomic
- Consecutive errors in the main loop (5+) trigger a clean exit

## Not yet

- No production deployment
- No vault auto-sync between hosts (do it manually for MVP)
- No automatic pin-on-resurrection (manually pin the first tweet each Friday)
- No resurrection count stored on-chain as a separate on-chain event (it's inside the consciousness payload, which is sufficient)
