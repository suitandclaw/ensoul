# Ensoul Network Dashboard: Design Doc

**Status:** Design only. No implementation.

## Goal

One dashboard at status.ensoul.dev that replaces the current fragmented monitoring and admin surfaces. Public sections viewable by everyone, admin sections gated behind X-Admin-Key.

Replaces: admin.html, validators.html, validator-dashboard.html, and the current status.ensoul.dev app. Does not replace pioneer.html (different audience: Pioneer operators managing their own validator) or explorer.ensoul.dev (agent/block/tx explorer, different purpose).

## Current state (what we're consolidating)

| Surface | Location | Lines | Auth | Data source |
|---|---|---|---|---|
| Status page | status.ensoul.dev | separate app | public | /api/health, /api/social, api.ensoul.dev/v1/agents/list |
| Admin page | ensoul.dev/admin | 478 lines | X-Admin-Key | api.ensoul.dev/v1/admin/* |
| Validator list | ensoul.dev/validators | 203 lines | public | api.ensoul.dev/v1/validators |
| Validator dashboard | ensoul.dev/validator-dashboard | 371 lines | unclear | mixed |
| Pioneer status | ensoul.dev/pioneer-status | 216 lines | public | api.ensoul.dev/v1/pioneers/status |
| Explorer | explorer.ensoul.dev | separate app | public | CometBFT RPC + ABCI |
| Monitor | port 4000 on Ashburn | ~800 lines | internal | CometBFT RPC polling |
| Telegram bot | systemd on Ashburn | ~600 lines | bot token | monitor events |
| Heartbeat receiver | api.ensoul.dev/v1/telemetry/* | packages/api/telemetry/ | Ed25519 signed | validator push |
| Telemetry state | ~/.ensoul/telemetry-state.json | JSON file | local | heartbeat receiver |
| Alert log | ~/.ensoul/telemetry-alerts.log | log file | local | health engine |

Problems:
- Validator count disagrees across pages (status shows 21, admin shows 20/20, CometBFT has 28). Root cause: each page queries a different source.
- "Some services degraded" banner on status.ensoul.dev does not say which service is degraded.
- Admin page only shows 20 foundation validators, not the 8 Pioneer-tier validators.
- Heartbeat telemetry (per-validator health, peers, disk, version drift) not surfaced in any UI.
- No unified alert stream in UI. Alerts go to log files and Telegram only.
- Pioneer management (approve, reject, revoke) scattered across different views.

## Architecture

### Frontend

Single HTML page at status.ensoul.dev/index.html. Vanilla JS + CSS, same stack as the rest of ensoul.dev (no React, no build step, no bundler). Matches the pattern of pioneer.html, admin.html, explorer.

Auth: password entered in a small input at top-right. Stored in sessionStorage with 8-hour expiry timestamp. Sent as X-Admin-Key header on admin fetches. JS gates section visibility; server gates actual data access.

### Backend

All data served from api.ensoul.dev (single canonical source). New endpoints added to packages/api/start.ts:

**Public endpoints:**

| Endpoint | Returns |
|---|---|
| GET /v1/dashboard/overview | Block height, chain ID, validators online/total, blocks/min, agent count, consciousness count, service status summary |
| GET /v1/dashboard/validators | Full validator grid: CometBFT set + ABCI state + heartbeat telemetry merged per DID |
| GET /v1/dashboard/services | Per-service health: API, explorer, website, Twitter agent, Telegram bot, monitor |
| GET /v1/dashboard/agents/recent | Last 50 registered agents with DID, registered_at, storage_status |

**Admin endpoints (require X-Admin-Key):**

| Endpoint | Returns |
|---|---|
| GET /v1/admin/alerts | Last 100 entries from telemetry-alerts.log, parsed into structured JSON |
| GET /v1/admin/heartbeats | Full telemetry-state.json dump (all validators, all fields) |
| Existing /v1/admin/pioneer-approve, /v1/admin/force-remove-validator, etc. | Unchanged |

### Data flow

Dashboard polls:
- /v1/dashboard/overview every 10s (lightweight, header stats only)
- /v1/dashboard/validators every 30s (full grid data)
- /v1/dashboard/services every 60s (service health checks)
- /v1/admin/alerts every 15s (when admin view is active)

Heartbeats feed the validators endpoint:
- Each validator entry merges three sources:
  1. CometBFT /validators (voting power, address, active set membership)
  2. ABCI /validators query (DID, staked balance, delegations)
  3. telemetry-state.json (last heartbeat, health state, height history, peers, disk, version)
- "Health" column uses heartbeat healthState: healthy / degraded / unhealthy / offline / no-data
- No heartbeat in > 3 minutes = "stale" (distinct from "offline" which is > 5 min)
- No heartbeat ever received = "no-data"

Validator count truth: CometBFT /validators is authoritative for the active consensus set. ABCI state is authoritative for staked/delegated balances. Heartbeat is authoritative for operational health. The dashboard merges all three. Count displayed = CometBFT active set size.

## Page layout

### Section 1: Network Overview (public)

Hero cards in a row:

| Card | Source | Update |
|---|---|---|
| Block height | CometBFT /status | 10s |
| Chain ID | static "ensoul-1" | never |
| Validators online / total | CometBFT /validators count + heartbeat health | 30s |
| Blocks per minute | derived from height delta over 60s | 10s |
| Ensouled agents | ABCI /stats agentCount | 10s |
| Consciousness records | ABCI /stats consciousnessCount | 10s |

Status banner below cards:
- Green: "All systems operational"
- Yellow: "N services degraded: [Twitter Agent, Monitor]" (names the services)
- Red: "N services offline: [API Gateway]"

### Section 2: Validator Grid (public read-only, admin has actions)

Table columns:

| Column | Source | Coloring |
|---|---|---|
| Moniker + region | ABCI registered-validators.json | plain |
| DID | ABCI | truncated, click to copy |
| Height | heartbeat lastHeartbeat.height | green within 2 of best, yellow 3-10 behind, red 10+ |
| Peers | heartbeat lastHeartbeat.peers | green >=5, yellow 1-4, red 0 |
| Health | heartbeat healthState | badge: green/yellow/orange/red/gray |
| Last heartbeat | heartbeat lastSeenAt | "12s ago" format, red if >3min |
| ABCI version | heartbeat lastHeartbeat.abci_version | green if matches quorum majority, red if different |
| CometBFT version | heartbeat lastHeartbeat.cometbft_version | same |
| Disk % | heartbeat lastHeartbeat.disk_used_pct | green <80, yellow 80-90, red >90 |
| Mem % | heartbeat lastHeartbeat.mem_used_pct | green <80, yellow 80-90, red >90 |
| Uptime | heartbeat lastHeartbeat.uptime_seconds | formatted as "3d 14h" |
| Voting power | CometBFT /validators | formatted with commas |
| Tier | ABCI registered-validators.json tier field | badge: genesis/pioneer/standard |

Admin-only columns (visible when authenticated):
- Update button: POST /v1/admin/validator/:did/update
- Restart button: POST /v1/admin/validator/:did/restart
- Logs button: GET /v1/admin/validator/:did/logs (opens modal with last 50 lines)
- SSH button: copies `ssh root@IP -p PORT` to clipboard

Sortable by any column. Filterable by: tier (genesis/pioneer/standard), health state, version match.

### Section 3: Pioneer Management (admin only)

Three tabs:

**Pending (N):** table with DID, moniker, contact, IP, submitted_at. Each row has Approve and Reject buttons. Reject opens a modal for entering rejection reason.

**Approved (N):** table with DID, moniker, approved_at, delegation amount, lock days remaining, onboarding status (self-stake sent, delegation sent, consensus_join submitted).

**Rejected (N):** table with DID, moniker, rejected_at, reason. Re-approve button if applicable.

### Section 4: Ensouled Agents (public counts, admin detail)

Public view: large count number + "agents ensouled" label. Simple bar chart of registrations per day (last 30 days).

Admin view: scrollable table of last 20 registered agents with DID, registered_at, storage_size. (Verify these fields exist in /v1/agents/list response before Phase 2 build.)

### Section 5: API Services (public)

Cards in a grid, one per service:

| Service | Health check method |
|---|---|
| API Gateway (api.ensoul.dev) | GET /health, check response time |
| Explorer (explorer.ensoul.dev) | GET /, check HTTP 200 |
| Website (ensoul.dev) | GET /, check HTTP 200 |
| Status Page | deploy timestamp from Vercel API |
| Twitter Agent | check last tweet timestamp from ensoul-brand-agent package data |
| Telegram Bot | check uptime via monitor service |

Each card shows: status dot (green/red) + service name + last checked timestamp + response time.

### Section 6: Alert Stream (admin only)

Live feed from telemetry-alerts.log, displayed as a reverse-chronological list.

Each entry shows:
- Timestamp
- Severity badge (INFO / WARNING / CRITICAL / REMINDER / RECOVERY)
- Validator DID (truncated)
- State transition (e.g., "healthy -> unhealthy")
- Reason (e.g., "peers == 0 for 3 consecutive heartbeats")
- Contact targets attempted

Filters: by DID, by severity, by time range. Search box.

Last 50 alerts displayed. "Load more" button for pagination.

### Section 7: Quick Actions (admin only)

Action cards:

- **Broadcast SOFTWARE_UPGRADE:** modal with inputs for target version (git tag), target height, info JSON. Calls existing governance broadcast flow.
- **Remove ghost validator:** dropdown populated from CometBFT /validators filtered to known ghost addresses. Confirm modal. Calls POST /v1/admin/force-remove-validator.
- **Approve Pioneer:** DID input + contact fields. Calls existing approval flow.
- **Export validator CSV:** button that triggers CSV download of all validators with current stats.

### Section 8: System Info (public)

Footer area:
- Monitor service uptime
- Dashboard version (from packages/node/src/version.ts)
- Last Vercel deploy timestamp
- GitHub repo link
- Heartbeat protocol spec link

## Authentication

Flow:
1. Small lock icon + password input at top-right of page
2. On submit: test auth by calling GET /v1/admin/alerts with X-Admin-Key header
3. If 200: store key in sessionStorage with expiry = now + 8 hours. Show toast "Admin mode enabled". Reveal admin sections.
4. If 403: show "Invalid key" error inline.
5. All admin fetches include `X-Admin-Key: <stored>` header.
6. On page load: check sessionStorage. If key exists and not expired, auto-enable admin mode (re-validate with one test fetch).
7. Logout button: clear sessionStorage, hide admin sections, show lock icon.

## Migration path

| Old page | Action |
|---|---|
| admin.html | Redirect to status.ensoul.dev. Add `<meta http-equiv="refresh" content="0;url=https://status.ensoul.dev">` |
| validators.html | Redirect to status.ensoul.dev#validators |
| validator-dashboard.html | Already redirects to pioneer.html (keep) |
| pioneer-status.html | Keep as-is (different audience) |
| pioneer.html | Keep as-is (operator self-service) |
| status.ensoul.dev (current) | Replace with new dashboard |
| explorer.ensoul.dev | Keep as-is (separate purpose) |

## MVP (tonight, 4-hour budget)

Shipped this session:
- New endpoint: GET /v1/telemetry/state returns telemetry-state.json contents with 10s cache
- New file: packages/website/src/dashboard.html (vanilla JS, matches admin.html style)
- Deployed initially at ensoul.dev/status, DNS cutover to status.ensoul.dev follows later
- Sections built tonight:
  - Section 1 Network Overview (public)
  - Section 2 Validator Grid (public view, no admin action columns yet)
  - Section 3 Pioneer Management (admin, using existing /v1/pioneers endpoints)
  - Section 7 Quick Actions limited to: ghost removal, Pioneer approve, CSV export
- Admin auth via X-Admin-Key, sessionStorage, 8-hour expiry

Not built tonight (deferred to later phases):
- Update / Restart / Logs buttons in validator grid (Phase 4)
- Section 4 Ensouled Agents
- Section 5 API Services
- Section 6 Alert Stream
- Section 8 System Info beyond basic footer
- SOFTWARE_UPGRADE broadcast UI (Phase 4, depends on command channel)

The MVP is intentionally scoped so that:
- JD can ghost-remove validators from a single UI
- JD can approve Pioneers from a single UI
- JD can see heartbeat-derived health for all validators from a single UI
- Existing admin.html can be retired (its essential functions are replicated)

## Out of scope (explicitly not building)

- Grafana-style historical trend graphs
- Mobile-optimized layout (basic responsive only)
- Per-user authentication (shared admin key, v2 concern)
- Real-time WebSocket or SSE updates (polling for v1)
- SSH-based remote actions from the API (Phase 4, needs architecture decision)
- Alert delivery to Telegram from the dashboard (separate concern, Telegram bot already dispatches independently)
- Session storage encryption (sessionStorage is bounded to the tab, acceptable for v1)

## Implementation phases

### Phase 1: MVP (tonight, 4 hours)
New GET /v1/telemetry/state endpoint. dashboard.html with Sections 1, 2, 3, 7 (limited). Admin auth wired. Deployed at ensoul.dev/status. CometBFT + ABCI + heartbeat data merged in the validator grid.

### Phase 2: Agents + services + cleanup (~1 day)
Section 4 (agents), Section 5 (services), Section 8 full (system info). Retire admin.html with redirect.

### Phase 3: Alert stream + grid polish (~1 day)
Section 6 (alert stream). Integrate telemetry-alerts.log reading endpoint. Sortable and filterable validator grid. Version drift coloring, disk/mem gauges.

### Phase 4: Remote validator actions (2-3 days)
Update/Restart/Logs buttons that actually work. This is the most complex phase because the API needs to trigger actions on remote validators. Architectural options:

1. **API SSHs directly:** API holds SSH keys, executes commands on validators. Simple but requires key management in the API runtime and opens an attack surface.
2. **Command polling via heartbeat client:** Each validator's heartbeat client polls for pending commands (GET /v1/telemetry/commands?did=X). API queues commands, client executes them. No inbound SSH needed. Delay = up to 60s (heartbeat interval; acceptable for non-emergency ops; emergency commands can use a dedicated short-poll mode when an outstanding command exists).
3. **Signed command channel:** Commands are signed by PIONEER_KEY and delivered via a dedicated endpoint. Heartbeat client verifies signature before executing. Most secure but most complex.

Recommendation: Option 2 for v1. The heartbeat client already runs on every validator and trusts the API. Adding a command poll is a small extension. Security: only accept commands from the API over HTTPS, validate command types against an allowlist (restart, update, logs), never execute arbitrary shell. SOFTWARE_UPGRADE broadcast UI also lands in this phase.

### Phase 5: DNS cutover + polish (~1 day)
DNS cutover to status.ensoul.dev. Retire current status.ensoul.dev app. Mobile responsive polish. Auto-refresh indicators.

## Open questions

1. **How do admin.html's Update/Restart/Logs buttons currently work?** They appear to be UI-only placeholders. Need to verify before designing Phase 4.
2. **Single admin password vs per-user auth:** Start with the existing single ENSOUL_ADMIN_KEY. Per-user auth (JWT, OAuth) is a v2 consideration.
3. **Historical trend graphs:** Out of scope for v1. The retention store has hourly aggregates for 90 days, which could power sparkline graphs in a future phase.

## Estimated effort

5-7 days after tonight's MVP lands. Total including MVP: 6-8 days of focused work across 5 phases.

## Related docs

- Heartbeat protocol spec: docs/heartbeat-protocol.md
- Receiver implementation: packages/api/telemetry/
- Pioneer portal: packages/website/src/pioneer.html
- Current admin page: packages/website/src/admin.html
- API routes: packages/api/start.ts
