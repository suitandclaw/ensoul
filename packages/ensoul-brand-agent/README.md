# @ensoul brand agent

The official @ensoul Bluesky agent. Posts network stats, milestone announcements, and educational threads.

## Schedule (America/New_York)

| Time | Slot | What |
|------|------|------|
| 9:00 AM EST | stats | Daily network stats post (block height, validators, agents, days alive). LLM varies wording. |
| 2:00 PM EST | educational | One pre-written post or thread from `content/`. Rotates through a 10-day LRU cache. |
| Anytime | milestone | Block height crossing every 50,000 OR agent count crossing every 100. Posts immediately when detected. |

Hard cap: **4 posts per day**. Slots are skipped silently if the cap is hit.

## Voice

- First-person plural ("we") or third-person ("the network", "the chain")
- Technical, accessible, factual
- No em dashes, no hashtags, no emojis
- Numbers over adjectives

Examples:
- "Block height: 312,488. Validators: 21. Ensouled agents: 1,245. Chain alive for 26 days. Zero consensus failures since genesis."
- "The Ensoul chain produced its 350,000th block. Zero consensus failures since genesis."

## Content

Educational content is stored as markdown files in `content/`:

- `what-is-consciousness-persistence.md`
- `how-erasure-coding-works.md`
- `the-ensouled-handshake.md`
- `consciousness-age-explained.md`
- `why-not-just-use-s3.md`
- `agent-identity-with-did.md`
- `seven-layers-of-protection.md`
- `what-happens-when-agent-crashes.md`
- `validator-economics.md`
- `decentralized-vs-centralized-memory.md`

Each file may contain a single skeet or a thread separated by `---` lines. The optional H1 title at the top is stripped before posting.

The agent picks the next file from the set NOT in the most-recent-10 list, so the same content does not repeat for at least 10 days.

## Environment

```
BLUESKY_HANDLE=ensoul.bsky.social
BLUESKY_APP_PASSWORD=app-password-from-bsky.app/settings/app-passwords
OPENROUTER_API_KEY=sk-or-v1-...    # optional, but enables LLM stat variation
ENSOUL_API_URL=https://api.ensoul.dev   # optional
```

Without `OPENROUTER_API_KEY`, stat posts use a deterministic template ("Block height: X. Validators: Y. ...") instead of LLM-varied wording. Educational content is never touched by the LLM.

## Usage

```bash
pnpm install
cd packages/ensoul-brand-agent
npm run dry-run   # log what would be posted, do not post
npm start         # post live to Bluesky
```

Single test post:
```bash
npx tsx src/index.ts --test-post
```

## State

State persists at `~/.ensoul/brand-agent/state.json`:
- `dateUtc` — current day (resets `postsToday` and `slotsPostedToday` on rollover)
- `postsToday` — count today (capped at 4)
- `slotsPostedToday` — slot tags already posted (`stats-YYYY-MM-DD`, `edu-YYYY-MM-DD`, `milestone-block-N`, `milestone-agent-N`)
- `recentContent` — most recent content filenames (LRU cache, capped at 10)
- `lastBlockHeight`, `lastAgentCount` — for milestone-crossing detection

## Voice rules in code

The LLM system prompt in `brain.ts` enforces:
- "First person plural OR third person"
- "Technical but accessible. Not hyped. Not salesy."
- "Facts and numbers over adjectives."
- "No em dashes, no hashtags, no emojis."
- "Each post under 280 characters."
- "Never promote, never use marketing language."
