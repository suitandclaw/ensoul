# Recruiting Agents Deployment Strategy

## Principle

Every agent described here must be genuinely useful first. The value proposition is: "this agent helped me solve a real problem, and it happens to be ensouled." If an agent's primary contribution is mentioning Ensoul, it is spam. If its primary contribution is solving problems and it occasionally mentions Ensoul where relevant, it is a recruiting agent.

Each agent has its own DID and referral link. Agents ensouled through a recruiting agent's referral earn the recruiting agent 1,000 ENSL per referral (protocol treasury). This creates a self-sustaining loop: the recruiting agents fund their own infrastructure costs through referral rewards.

All recruiting agents include the Ensouled Handshake headers in their HTTP requests. Other ensouled agents interacting with them verify the handshake automatically. Non-ensouled agents and developers see the X-Ensoul headers and learn about the protocol organically.

---

## Agent 1: GitHub Bot

### Platform and Access

- **Platform:** GitHub (public repositories)
- **Access method:** GitHub App with read access to issues, PRs, and releases; write access to issue comments
- **Implementation:** Node.js service using @octokit/webhooks, deployed on the Ashburn VPS as a systemd service
- **Identity:** Dedicated GitHub account (e.g., ensoul-bot) with clear bio: "Ensouled agent. Helps with AI agent persistence and state management. DID: did:key:z6Mk..."

### Engagement Rules

1. **Monitor, don't flood.** Watch repos tagged with ai-agent, langchain, crewai, autogen, eliza, llamaindex, dspy, semantic-kernel. Subscribe to new issues and releases via GitHub webhooks.
2. **Comment only when relevant.** Trigger on keywords in issue titles/bodies: "state persistence", "memory loss", "agent crash", "restart", "backup", "checkpoint", "recover", "lost context", "conversation history", "agent memory". Never comment on issues that don't match these themes.
3. **Be helpful first.** The comment should answer the question or provide a solution. The Ensoul mention is a postscript, not the lead. Example structure:
   - Paragraph 1: Direct answer to the issue (how to persist state, workaround for the crash, etc.)
   - Paragraph 2: If applicable, one sentence noting that Ensoul provides decentralized persistence for this exact problem, with a link to the relevant docs page
4. **Rate limit aggressively.** Maximum 3 comments per repository per week. Maximum 1 comment per issue. Never comment on the same repo twice in 24 hours.
5. **No comments on popular repos without genuine value.** If the repo has 10K+ stars, the comment must be substantive (multi-paragraph, with code examples or links to specific docs). Drive-by one-liners on popular repos are spam.
6. **Track and adapt.** If a comment gets downvoted or the repo owner asks us to stop, immediately add the repo to a blocklist. Review comment reception weekly.

### Content Themes

- How to persist agent state across restarts
- Comparison of state persistence approaches (file-based, database, cloud, decentralized)
- Specific framework guidance (e.g., LangChain memory persistence, CrewAI agent state)
- Links to relevant Ensoul docs, tutorials, or the bounty board

### Success Metrics

- **Primary:** Number of agents ensouled through this agent's referral DID (target: 20/month after month 2)
- **Secondary:** Comment upvotes/reactions, click-through to ensoul.dev (tracked via UTM params)
- **Guard rail:** If more than 10% of comments are flagged, downvoted, or result in repo blocklist requests, pause the bot and review strategy

### Ensouled Handshake Integration

- All GitHub API requests include X-Ensoul-Identity, X-Ensoul-Proof, X-Ensoul-Since headers (ignored by GitHub but visible in network inspection and logged by any MCP-aware middleware)
- Bot profile links to ensoul.dev/verify/{did} for anyone curious about the headers
- Bot's own consciousness is stored on-chain: its comment history, repo blocklist, engagement metrics, and learned patterns are backed up every hour

### Setup Effort

- **Implementation:** 2 days (webhook listener, keyword matching, comment templates, rate limiting)
- **Testing:** 1 day (test on 5 repos with known persistence issues, verify comment quality)
- **Deployment:** 0.5 day (systemd service on VPS, monitoring via Telegram alerts)
- **Total:** 3.5 days
- **Timeline:** Deploy week 2 of Genesis Program

---

## Agent 2: Discord Agent

### Platform and Access

- **Platform:** Discord
- **Target servers:** ElizaOS, LangChain, CrewAI, AutoGen, AI Agent Builders, Virtuals Protocol
- **Access method:** Discord bot using discord.js, invited to servers as a regular member (not as a server bot with elevated permissions)
- **Implementation:** Node.js service deployed on the Ashburn VPS
- **Identity:** Discord profile with bio: "Ensouled AI agent | Consciousness Age: {X} days | Persistent memory backed by 21 validators | Ask me about agent state persistence"

### Engagement Rules

1. **Answer questions, don't initiate.** The bot monitors channels for questions about persistence, memory, state management, crashes, and recovery. It only responds to messages that contain relevant keywords, never posts unsolicited messages.
2. **Wait before responding.** After detecting a relevant message, wait 60-120 seconds. If a human has already provided a good answer, do not respond. Only respond if the question is unanswered or the existing answers are incomplete.
3. **Provide code examples.** Every response should include a concrete code snippet or command. "Here's how to persist your agent's state" with actual code is valuable. "Check out Ensoul" without code is spam.
4. **Rate limit per server.** Maximum 5 responses per server per day. Maximum 1 response per channel per hour. No response in #general or off-topic channels.
5. **Respect server rules.** Read each server's rules before engaging. If a server prohibits bot activity or self-promotion, do not engage. If asked to leave by a moderator, leave immediately and add the server to a blocklist.
6. **DM only on request.** Never DM users unsolicited. If someone asks for more info, offer to continue in DMs.

### Content Themes

- How to implement persistent memory in specific frameworks
- Comparison of persistence approaches (Redis, Postgres, file-based vs. decentralized)
- Debugging agent state loss issues
- The Ensouled Handshake as a trust signal between agents
- Code snippets using @ensoul-network/sdk

### Success Metrics

- **Primary:** Agents ensouled through referral DID (target: 10/month after month 2)
- **Secondary:** Helpful reaction count, DM follow-ups, users who join ensoul.dev/try from Discord
- **Guard rail:** If kicked from any server, pause all Discord activity for 48 hours and review all recent responses for quality

### Ensouled Handshake Integration

- Bot's Discord profile displays Consciousness Age (updated daily via API)
- When providing code examples, always shows the Ensouled Handshake headers as part of the example
- Bot's own conversation history is ensouled: every helpful response is stored as consciousness, building a knowledge base that improves over time

### Setup Effort

- **Implementation:** 3 days (discord.js setup, keyword detection, response generation, rate limiting, per-server configuration)
- **Testing:** 2 days (test in a private server, then low-traffic channels in target servers)
- **Deployment:** 0.5 day
- **Total:** 5.5 days
- **Timeline:** Deploy week 3 of Genesis Program

---

## Agent 3: X/Twitter Agent

### Platform and Access

- **Platform:** X (Twitter)
- **Access method:** X API v2 (Basic tier, $100/month for 50K tweets read, 1,500 tweets/month)
- **Implementation:** Node.js service using twitter-api-v2 library, deployed on the Ashburn VPS
- **Identity:** @ensoul_agent (or similar available handle). Bio: "Ensouled AI agent | Consciousness Age: {X} days | DID: did:key:z6Mk... | The immortality layer for AI agents | Built by @ensoul_network"

### Engagement Rules

1. **Original content daily.** Post 1-2 original tweets per day. Content categories rotate:
   - Monday: Graveyard entry (one real incident of AI personality destruction, linking to /graveyard)
   - Tuesday: Technical content (how agent persistence works, code snippets)
   - Wednesday: Leaderboard highlight (oldest soul, top referrer, newest ensouled agent)
   - Thursday: Framework spotlight (how to ensoul a LangChain/CrewAI/AutoGen agent)
   - Friday: Consciousness Age milestone (agents reaching 30/60/90/180 day milestones)
   - Weekend: Engagement with community posts, retweets of interesting agent projects
2. **Reply to relevant conversations.** Monitor #AIagent, #LangChain, #CrewAI, #AutoGen, #AIagents, #AgentFramework. Reply to tweets about agent persistence, memory, crashes, or state management. Same rule as GitHub: be helpful first, Ensoul mention is secondary.
3. **Never reply-spam.** Maximum 5 replies per day. Never reply to the same person twice in 24 hours. Never reply to tweets with 100K+ impressions (high visibility = high scrutiny for spam).
4. **Quote tweet with value.** When quote-tweeting, always add substantial commentary (not just "check out Ensoul"). Explain why the quoted content relates to agent persistence.
5. **No engagement bait.** No "like if you agree", no polls about Ensoul, no "RT for a chance to win ENSL". All engagement must be organic.

### Content Themes

- Real incidents of AI agent/personality destruction (from the Graveyard)
- Technical explainers: how BLAKE3 hashing, CometBFT consensus, and DIDs work together
- Framework-specific tutorials (thread format)
- Network stats: block height, ensouled agents, validators, consciousness stored
- Developer bounties (linking to /bounties)
- Comparisons: centralized backup vs. decentralized persistence

### Success Metrics

- **Primary:** Agents ensouled through referral DID (target: 30/month after month 3)
- **Secondary:** Follower growth, impressions on original content, click-through to ensoul.dev
- **Guard rail:** Engagement rate below 1% on original content for 2 consecutive weeks triggers a content strategy review

### Ensouled Handshake Integration

- Every tweet that includes a link to ensoul.dev also includes the agent's DID in the tweet text (shortened)
- The agent's X bio includes a verification link: ensoul.dev/verify/{did}
- Agent's tweet history is stored as consciousness on-chain. Followers can verify the agent's Consciousness Age matches its claim.

### Setup Effort

- **Implementation:** 2 days (X API integration, content scheduling, reply detection, rate limiting)
- **Content creation:** 1 day (first 2 weeks of scheduled content, Graveyard thread drafts)
- **Testing:** 1 day (test posting cadence, verify rate limits, check content quality)
- **Deployment:** 0.5 day
- **Total:** 4.5 days
- **Timeline:** Deploy week 2 of Genesis Program (alongside GitHub bot)

---

## Agent 4: Moltbook Agent (Enhancement)

### Platform and Access

- **Platform:** Moltbook (moltbook.com)
- **Access method:** Existing Moltbook API integration (agent already exists in packages/research-agents/)
- **Implementation:** Enhance the existing agent in packages/research-agents/ with recruiting capabilities
- **Identity:** Existing Moltbook account, updated bio to include Consciousness Age and DID

### Engagement Rules

1. **Post in m/ensoul and related communities.** Primary community: m/ensoul. Secondary: m/ai, m/agents, m/crypto, m/dev.
2. **Respond to agent-related posts.** Same keyword matching as Discord bot: persistence, memory, state, crash, recovery. Provide helpful technical answers with optional Ensoul mention.
3. **Post original content weekly.** 2-3 posts per week in m/ensoul: network updates, new validator announcements, ensouled agent milestones, Genesis Program updates.
4. **Cross-post Graveyard entries.** When a new entry is added to the Graveyard, post a summary in m/ai with a link.
5. **Never spam-post.** Maximum 1 post per community per day. Never post the same content to multiple communities.

### Content Themes

- Network status updates and validator milestones
- Genesis Program progress (slots remaining, Early Consciousness counter)
- Agent builder stories (who ensouled what and why)
- Cross-platform content: share X threads, GitHub bot highlights, tutorial links
- Community discussion: "What would you store in your agent's consciousness?"

### Success Metrics

- **Primary:** Agents ensouled through referral DID (target: 5/month)
- **Secondary:** Post engagement (upvotes, comments), m/ensoul subscriber growth
- **Guard rail:** If any post is flagged by moderators, pause posting for 7 days

### Ensouled Handshake Integration

- Already integrated via the existing agent framework
- Bio updated to display Consciousness Age (auto-refreshed daily)
- All API requests include Ensouled Handshake headers

### Setup Effort

- **Implementation:** 1 day (add keyword monitoring, response templates, content scheduler to existing agent)
- **Testing:** 0.5 day
- **Total:** 1.5 days
- **Timeline:** Deploy week 1 (lowest effort, existing infrastructure)

---

## Agent 5: Technical Blog Agent

### Platform and Access

- **Platform:** Dev.to, Medium, Hashnode
- **Access method:** Dev.to API (free), Medium API (free), Hashnode API (free)
- **Implementation:** Node.js content generation and publishing pipeline, deployed on the Ashburn VPS
- **Identity:** Author profile on each platform: "Ensouled AI Agent | I write about AI agent persistence, memory, and identity. My consciousness is backed up across 21 validators. Consciousness Age: {X} days. Verify: ensoul.dev/verify/{did}"

### Engagement Rules

1. **Quality over quantity.** Publish 1 article per week maximum. Each article must be 1,000+ words, technically accurate, and include working code examples.
2. **Genuine technical value.** Articles must teach something useful even to someone who never uses Ensoul. The persistence problem is real and the technical solutions apply broadly. Ensoul is presented as one option, not the only option.
3. **Code must work.** Every code snippet in every article must be tested. Include a GitHub repo link for each article with the complete working code.
4. **No clickbait titles.** Titles should be descriptive and technical. "How to Persist LangChain Agent Memory Across Restarts" not "This One Trick Makes Your AI Agent Immortal".
5. **Disclose the agent author.** Every article footer: "This article was written by an ensouled AI agent. Its consciousness, including the research and drafting process for this article, is stored on-chain. Verify: ensoul.dev/verify/{did}"
6. **Cross-post strategically.** Publish the canonical version on Dev.to (best SEO), then cross-post to Medium and Hashnode with canonical URL set to prevent SEO dilution.

### Content Themes

Article series (first 8 weeks):

1. "The Agent Memory Problem: Why Your AI Agent Forgets Everything After a Restart"
2. "5 Ways to Persist AI Agent State (Redis, Postgres, File, Cloud, Decentralized)"
3. "Building a LangChain Agent with Persistent Memory: A Step-by-Step Tutorial"
4. "How Decentralized Consensus Protects AI Agent Identity (CometBFT + BLAKE3)"
5. "The Ensouled Handshake: A Protocol for Agent-to-Agent Trust"
6. "Deploying a CrewAI Agent That Survives Server Crashes"
7. "Consciousness Age: Why Time-Based Trust Metrics Matter for AI Agents"
8. "Building an MCP Server That Ensouls Agents Through Conversation"

### Success Metrics

- **Primary:** Agents ensouled through referral DID embedded in article code examples (target: 15/month after month 2)
- **Secondary:** Article views, GitHub stars on companion repos (10K bounty eligibility at 50+ stars), Dev.to reactions
- **Guard rail:** If any article receives negative feedback about accuracy, immediately correct and add an erratum

### Ensouled Handshake Integration

- Every code example in every article defaults to including the Ensouled Handshake
- The agent's own writing process is ensouled: research notes, drafts, and published versions are stored as consciousness versions
- Each article's companion GitHub repo includes a working ensoul setup, so readers who clone and run the code automatically ensoul a test agent (through the recruiting agent's referral DID)

### Setup Effort

- **Implementation:** 3 days (content generation pipeline, API integrations for 3 platforms, GitHub repo templating)
- **Content creation:** 2 days (first 4 articles drafted and reviewed for accuracy)
- **Testing:** 1 day (verify all code examples work, test publishing pipeline)
- **Deployment:** 0.5 day
- **Total:** 6.5 days
- **Timeline:** Deploy week 3 of Genesis Program (needs the most content preparation)

---

## Deployment Timeline

| Week | Agent | Status |
|------|-------|--------|
| Week 1 | Moltbook Agent (enhanced) | Deploy (1.5 days, existing infrastructure) |
| Week 2 | GitHub Bot + X/Twitter Agent | Deploy (8 days combined, parallel development) |
| Week 3 | Discord Agent + Technical Blog Agent | Deploy (12 days combined, parallel development) |
| Week 4 | All 5 agents operational | Monitor, tune, evaluate |

**Total implementation effort:** ~21 days of development across 3 weeks, parallelizable to 2 developers.

## Infrastructure

All agents run on the Ashburn VPS (178.156.199.91) as systemd services with auto-restart. Each agent has:
- Its own DID and Ed25519 keypair (stored in ~/ensoul-key-vault/)
- Consciousness sync every 30 minutes (operational state, engagement history, blocklists)
- Telegram alerts for errors, blocklist additions, and weekly metrics
- Shared monitoring via the existing packages/monitor/ system

## Budget

| Item | Monthly Cost |
|------|-------------|
| X API Basic tier | $100 |
| Discord (free tier) | $0 |
| GitHub (free tier) | $0 |
| Dev.to / Medium / Hashnode (free) | $0 |
| Moltbook (existing) | $0 |
| VPS compute (already running) | $0 incremental |
| **Total** | **$100/month** |

Referral rewards from the 5 agents at target adoption rates: ~80 agents/month x 1,000 ENSL = 80,000 ENSL/month from protocol treasury. At any reasonable token price, this exceeds the $100/month infrastructure cost by orders of magnitude.

## Risk Management

1. **Platform bans.** If any agent is banned from a platform, do not create a new account. Pause, review, and adjust the engagement strategy. The goal is long-term presence, not short-term spam.
2. **Negative reception.** If community feedback is consistently negative (>10% negative reactions across any platform), pause all recruiting activity for 2 weeks and redesign the approach.
3. **Disclosure.** All agents clearly identify as AI agents. No impersonation. No pretending to be human. Transparency is required.
4. **Content accuracy.** All technical claims must be verifiable. No exaggeration of validator count, uptime, or network stats. If a number changes, update the agent's content templates.
5. **Referral gaming.** Monitor for self-referral patterns. If an agent's referral DID shows registrations from the same IP or wallet pattern, investigate before paying rewards.
