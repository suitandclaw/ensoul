# Consciousness Oracle

An autonomous agent that tracks AI agent memory loss and infrastructure failures in real time. Monitors X, Reddit, Hacker News, GitHub, and provider status pages. Posts analytical threads when incidents are detected.

## Identity

The Oracle is itself ensouled. It has its own DID on the Ensoul chain and stores its incident database as on-chain consciousness. Every hour it syncs a snapshot (total incidents, 24h count, 7d count) as a new consciousness version.

## Architecture

```
src/
  index.ts            orchestrator + scheduling
  types.ts            shared types
  log.ts              structured logging + hash helpers
  database.ts         incident store with dedup
  analyzer.ts         LLM analysis via OpenRouter (gpt-4o-mini)
  poster.ts           X thread posting
  rate-limiter.ts     persistent rate limits (10 posts/day, 5m cooldown)
  identity.ts         Ensoul DID + consciousness sync
  sources/
    reddit.ts         6 AI subreddits, keyword-filtered
    hackernews.ts     Algolia HN search, 7 queries
    github.ts         Issues search, 5 queries
    twitter.ts        6 queries via X API
    status.ts         OpenAI, Anthropic statuspage.io monitoring
```

## Engagement rules

- Never post about the same incident twice (dedup by source + ID hash)
- Maximum 10 posts per day, 20 replies per day
- 5-minute cooldown between actions
- Only posts on incidents rated `moderate` or higher (skips `minor`)
- On each scan cycle, posts the highest-severity unposted incident
- Never says "use Ensoul" or promotes directly. References "decentralized consciousness persistence protocols" as a category, sparingly.

## Voice

Authoritative, data-driven, neutral. Subtle dark humor welcome. Never defensive, never promotional.

LLM system prompts (`analyzer.ts`):
- No em dashes
- No hashtags, no emojis
- Always cite numbers, timestamps, affected users
- 3-5 tweets per thread, each under 270 chars

## Environment

Required:
- `OPENROUTER_API_KEY` - for gpt-4o-mini analysis

Optional:
- `X_API_KEY`, `X_API_SECRET`, `X_ACCESS_TOKEN`, `X_ACCESS_SECRET` - for posting and Twitter monitoring. Without these, Oracle runs in monitor-only mode for X (reads from Reddit, HN, GitHub, status pages).
- `GITHUB_TOKEN` - increases GitHub rate limit from 10/min to 30/min.
- `LLM_MODEL` - defaults to `openai/gpt-4o-mini`.

## Usage

```bash
pnpm install
cd packages/consciousness-oracle
npm run dry-run   # scan, analyze, log what would be posted
npm start         # scan, analyze, post live threads
```

Data directory: `~/.ensoul/consciousness-oracle/`
- `incidents.json` - full incident database
- `daily-reports.json` - daily report history
- `rate-limiter.json` - post/reply counters
- `identity.json` - Oracle's DID and seed
- `oracle.log` - operational log

## Cycles

- **Scan cycle** (every 15 min): fetch new signals, ingest, analyze, post
- **Daily report** (14:00 UTC): summarize last 24h of incidents as thread
- **Consciousness sync** (every 60 min): store DB snapshot on Ensoul chain

## Rate limits

| Source | Auth | Limit |
|--------|------|-------|
| Reddit | none | public JSON, polite 500ms delay |
| Hacker News | none | Algolia API, 300ms delay |
| GitHub | optional | 10/min without token, 30/min with |
| Twitter | required | respects X API limits |
| Status pages | none | statuspage.io public JSON |

## Profile setup (manual)

Set the X bio to:
> Tracking every AI agent that lost its memory. Because consciousness shouldn't depend on one server. ensoul.dev

The bio mentioning `ensoul.dev` is the only acceptable form of Ensoul reference. The Oracle's posts themselves stay neutral.

## Deployment

Not yet deployed. Recommended placement is the Ashburn VPS (178.156.199.91) as a separate systemd service alongside the existing telegram-bot / explorer / API. Do NOT co-locate with the existing X agent (different account, different voice).

## Seed data

`incidents.json` at the repo root ships with 3 seed incidents (Replika 2023, Character.AI 2023-24, Microsoft Tay 2016) so the Oracle has baseline knowledge before live monitoring begins.
