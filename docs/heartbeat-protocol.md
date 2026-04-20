# Ensoul Validator Heartbeat Protocol

**Status:** Spec only. No implementation.

## Research preamble

Existing blockchain validator observability falls into two camps:

**Pull-based (external monitor queries the validator's RPC):** Cosmos's Tenderduty, cosmos-validator-watcher, Solana's watchtower, and most Prometheus-based setups. The monitor scrapes CometBFT's `/status`, `/net_info`, and Prometheus port 26660. Advantages: zero operator setup, centralized view. Disadvantage: requires the validator's RPC to be reachable from the monitor, which Pioneers explicitly block (RPC bound to localhost, no public port).

**Push-based (validator posts telemetry to a receiver):** Rare in blockchain. Ethereum's beaconcha.in mobile app gets push notifications but the data source is the chain itself (attestation records), not client-side telemetry. Solana watchtower pushes alerts to Slack/Discord but pulls data from the cluster RPC, not from individual validators.

**What Ensoul needs that none of these provide:** A push-based, signed heartbeat from validators whose RPC is unreachable. Pioneers bind CometBFT to localhost. We cannot pull. The validator must push. And because we don't trust operators (permissionless network), the push must be signed with the validator's on-chain identity.

**What we copy from existing tools:**
- From Tenderduty: the specific health signals (missed blocks, peer count, sync lag, catching_up regression)
- From Cosmos watcher: the simplicity (single binary, minimal config)
- From Solana watchtower: the multi-channel alert dispatch (ntfy, Telegram, email)
- From all: the principle that the chain is the source of truth; client telemetry is a hint, not authoritative

**What we skip:**
- Prometheus/Grafana stack (too heavy for hobbyist operators)
- Historical time-series storage (v1 stores last-known state only)
- Proactive probing (we go passive push only)

---

## 1. Payload schema

```json
{
  "version": 1,
  "chain_id": "ensoul-1",
  "did": "did:key:z6Mk...",
  "timestamp": 1745100000000,
  "height": 378000,
  "catching_up": false,
  "peers": 12,
  "cometbft_version": "0.38.17",
  "abci_version": "1.4.91",
  "uptime_seconds": 604800,
  "restart_count": 0,
  "disk_used_pct": 42,
  "mem_used_pct": 65,
  "signature": "a1b2c3..."
}
```

The receiver enriches each heartbeat with chain-sourced data (moniker,
voting power) looked up by DID at receipt time. The validator only
reports what only it can know.

### Field justification

| Field | Type | Required | Why |
|---|---|---|---|
| `version` | int | yes | Must be exactly `1`. Receiver rejects any other value with 400. |
| `chain_id` | string | yes | Prevents cross-chain replay. Signing domain. |
| `did` | string | yes | On-chain identity. Lookup key for everything. |
| `timestamp` | int (ms) | yes | Replay resistance. Unix epoch milliseconds. |
| `height` | int | yes | Core health signal. Detects sync stall (height not increasing across heartbeats). |
| `catching_up` | bool | yes | Detects regression from synced to catching-up. Direct from CometBFT `/status`. |
| `peers` | int | yes | Detects peer isolation (peers=0 is the #1 failure mode we've seen). |
| `cometbft_version` | string | yes | Detects version drift from network consensus. Self-reported, unverified (see note below). |
| `abci_version` | string | yes | Detects operators running old ABCI code. Self-reported, unverified (see note below). |
| `uptime_seconds` | int | optional | Detects frequent restarts. Seconds since ABCI process started. |
| `restart_count` | int | optional | Number of ABCI restarts since wrapper started. Spikes indicate instability. |
| `disk_used_pct` | int | optional | Detects impending disk-full crash. Integer 0-100. |
| `mem_used_pct` | int | optional | Detects memory pressure. Integer 0-100. |
| `signature` | string | yes | Ed25519 hex signature over all fields except `signature` itself. |

**Note on self-reported versions:** `cometbft_version` and `abci_version`
are read from the local CometBFT `/status` endpoint and the local
`version.ts` file respectively. A compromised or modified validator could
lie about these. This is acceptable for observability (version drift
detection is a hint, not a security boundary). The chain itself is the
source of truth for what code a validator actually runs. Alerts driven by
`abci_version` or `cometbft_version` drift are advisory. They detect
honest operator lag, not malicious behavior. Do not treat them as a
security signal.

### Canonical signing form

The signed message is the JCS canonical JSON encoding (RFC 8785) of the
payload with the `signature` field removed. Clients MUST use an RFC 8785
compliant serializer. Different key orderings will produce different
signatures and fail verification.

Both the Linux systemd client and the macOS launchd client must use
compatible JCS libraries. The TypeScript receiver uses the same JCS
implementation for verification.

### Timestamp validation

Two rules govern the `timestamp` field:

1. **Skew tolerance.** The receiver rejects heartbeats where
   `|timestamp - receiver_now|` exceeds 300000 ms (5 minutes) with 400
   and body `{"error": "timestamp out of range"}`.

2. **Monotonicity.** The receiver rejects heartbeats where
   `timestamp <= last_stored_timestamp[did]` with 400 and body
   `{"error": "replayed or out-of-order timestamp"}`.

### Bounds validation

The receiver validates numeric and string fields before processing:

| Field | Constraint | On violation |
|---|---|---|
| `disk_used_pct` | Integer in [0, 100] | Reject 400 |
| `mem_used_pct` | Integer in [0, 100] | Reject 400 |
| `peers` | Integer >= 0 | Reject 400 |
| `height` | Integer >= 0 | Reject 400 |
| `uptime_seconds` | Integer >= 0 | Reject 400 |
| `restart_count` | Integer >= 0 | Reject 400 |
| `signature` | Exactly 128 hex characters | Reject 400 |
| `did` | Max 256 characters | Reject 400 |
| `chain_id` | Exactly `"ensoul-1"` | Reject 400 |

### Fields sourced from the chain (NOT in the payload)

The receiver looks these up by DID from on-chain state at receipt time:

| Field | Source | Why not self-reported |
|---|---|---|
| `moniker` | CometBFT validator set / Pioneer application | Trust the chain. Operator could claim any name. |
| `voting_power` | CometBFT validator set | Trust the chain. A removed validator could lie about having power. |

### Fields explicitly excluded

| Excluded field | Why |
|---|---|
| IP address | Privacy. The DID is public; the operator's IP is not. |
| OS / kernel version | Not actionable. Adds noise. |
| Block proposer history | Available on-chain. Redundant. |
| Transaction pool size | Not useful for health detection at our scale. |
| CPU usage | Too noisy. Spikes are normal during block processing. |
| Raw memory bytes | Percentage is sufficient. Bytes leak machine specs. |

### Size budget

Typical payload: ~500 bytes JSON. With signature: ~630 bytes. Well under the 1KB target at 1/minute.

---

## 2. DID admission

The receiver looks up the submitted DID against on-chain state at receipt
time. If the DID is not in the active CometBFT validator set AND not in
the approved Pioneer application set, the receiver rejects with 403 and
body `{"error": "unknown DID"}`.

Signature verification runs AFTER the admission check to avoid wasting
CPU on unknown DIDs. The processing order is:

0. Per-IP rate limit (429 on failure)
1. Parse JSON and validate required fields (400 on failure)
2. Bounds validation (400 on failure)
3. Timestamp skew tolerance (400 on failure)
4. DID admission check (403 on failure)
5. Timestamp monotonicity (400 on failure)
6. Signature verification (403 on failure)
7. Per-DID rate limit (429 on failure)
8. Accept and process

Steps 3 and 5 (both timestamp checks) are split across the admission
check (step 4) because skew tolerance is stateless (compares payload
timestamp against server clock) while monotonicity requires the per-DID
last-seen timestamp, which is only meaningful for admitted DIDs. Running
monotonicity before admission would either require storing timestamps
for unknown DIDs (memory leak vector) or skipping the check for unknown
DIDs (defeating its purpose).

---

## 3. Signing and verification

### What is signed

The signed message is the JCS canonical JSON encoding (RFC 8785) of the
heartbeat payload with the `signature` field removed. See "Canonical
signing form" in Section 1.

### Signing domain

The signing payload implicitly includes `chain_id` and `did` as fields, which binds the signature to a specific chain and identity. A signature from validator X on chain `ensoul-1` cannot be replayed as validator Y on chain `ensoul-test-1`.

### Signature algorithm

Ed25519 using the validator's on-chain identity key (the same key that signs transactions). The receiver extracts the public key from the DID (`did:key:z...` multicodec decode) and verifies against it.

### Verification pseudocode

```typescript
function verifyHeartbeat(payload: Heartbeat): boolean {
  // Full processing order is in Section 2. This pseudocode covers
  // signature verification only (step 5 of Section 2).

  // 1. Extract pubkey from DID
  const pubkey = pubkeyFromDid(payload.did);
  if (!pubkey) return false;

  // 2. Check timestamp freshness (5 minute skew tolerance)
  if (Math.abs(Date.now() - payload.timestamp) > 300_000) return false;

  // 3. Check monotonic increase
  const lastSeen = lastTimestamps.get(payload.did);
  if (lastSeen && payload.timestamp <= lastSeen) return false;

  // 4. Reconstruct signing payload (JCS canonical form)
  const { signature, ...rest } = payload;
  const canonical = jcsSerialize(rest);

  // 5. Verify Ed25519
  return ed25519.verify(hexToBytes(signature), encode(canonical), pubkey);
}
```

---

## 4. Transport and endpoint

**Endpoint:** `POST /v1/telemetry/heartbeat`

**Host:** `https://api.ensoul.dev` (same as existing API; no separate service for v1)

**Headers:**
```
Content-Type: application/json
X-Ensoul-Version: 1
```

**HTTPS only.** Plaintext HTTP rejected at the load balancer.

**Response codes:**

| Code | Meaning |
|---|---|
| 200 | Accepted. Body: `{"status": "ok", "server_time": <unix_ms>}`. The `server_time` field lets clients detect clock skew. |
| 400 | Bad payload (missing fields, unknown version, bad JSON, bounds violation, timestamp out of range) |
| 403 | Unknown DID or signature invalid |
| 429 | Rate limited. `Retry-After` header present. |
| 503 | Receiver temporarily unavailable. Client should retry. |

---

## 5. Rate limiting

The receiver applies per-IP rate limits BEFORE signature verification to
prevent forged-heartbeat CPU exhaustion.

**Per-IP limit:** 30 requests per minute per source IP across all
telemetry endpoints (`/v1/telemetry/*`). Exceeded: 429 with
`Retry-After` header.

**Per-DID limit:** 2 heartbeats per minute per DID. Applied AFTER
signature verification (only verified heartbeats count against the DID
quota). Exceeded: 429 with `Retry-After: 30`. This allows the normal
1/minute cadence plus one retry without enabling flood.

---

## 6. Server-side storage model

### Per-DID state (in-memory + JSON persistence)

```typescript
interface ValidatorTelemetry {
  did: string;
  lastHeartbeat: Heartbeat;       // Most recent accepted heartbeat
  lastSeenAt: number;             // Timestamp of last accepted heartbeat
  healthState: "healthy" | "degraded" | "unhealthy" | "offline";
  healthChangedAt: number;        // When health state last changed
  heightHistory: number[];        // Last 10 heights (for stall detection)
  alertSentAt: number;            // Last alert dispatch time (debounce)
  contact?: ContactRegistration;  // Optional operator contact
}
```

### Persistence

File: `~/.ensoul/telemetry-state.json`. Written every 60 seconds (not on every heartbeat). Loaded at API boot.

### Index

In-memory `Map<did, ValidatorTelemetry>`. At current scale (20 foundation + 20 Pioneer = 40 validators) this is trivially small. No database needed.

---

## 7. Storage and retention

Raw heartbeats retained for 7 days. After 7 days, compacted to hourly
aggregates (min/max/avg of each numeric field per DID per hour) retained
for 90 days. Contact registrations retained indefinitely until superseded
or explicitly revoked.

---

## 8. Health state computation

Computed on every incoming heartbeat AND on a 60-second background tick (to detect offline validators that stopped sending heartbeats).

```
OFFLINE:
  No heartbeat received in the last 5 minutes.

UNHEALTHY (any of):
  peers == 0 for the last 3 consecutive heartbeats (>= 3 minutes)
  catching_up == true for the last 5 consecutive heartbeats (>= 5 minutes)
  height unchanged across last 5 heartbeats (sync stall)
  voting_power == 0 (removed from active set)

DEGRADED (any of):
  peers < 3
  disk_used_pct > 90
  abci_version differs from the majority version across all reporting validators
  cometbft_version differs from the majority version
  restart_count > 5 (excessive restarts)

HEALTHY:
  None of the above conditions apply.
```

**Majority version quorum:** Version drift is only evaluated when at
least 10 validators have reported in the last 10 minutes. Below quorum,
version-drift conditions do not contribute to DEGRADED state. Majority
means strict majority (more than 50 percent of reporting validators).

### State transitions and alerting

State changes are logged. Alert dispatch rules:

1. **First transition to unhealthy/offline fires immediately.** When a
   DID transitions from healthy or degraded to unhealthy or offline for
   the first time (or for the first time after 30 minutes of silence),
   the alert fires with zero delay. An operator whose validator just
   went dark needs to know in seconds, not minutes.

2. **Subsequent transitions within the same 30-minute window are
   debounced.** If the same DID transitions again within 30 minutes of
   the last alert sent for this DID (e.g., flapping between unhealthy
   and degraded), no additional alert fires. This prevents spam loops.

3. **Recovery notifications always fire.** A transition back to healthy
   always sends a notification regardless of debounce state. Operators
   need positive confirmation that the problem resolved.

4. **Offline reminders.** A DID that remains offline fires a reminder
   alert every 60 minutes until it recovers. Reminder alerts use the
   same delivery channels as the initial offline alert and are labeled
   "REMINDER" in the message subject.

5. **Boot-time state resume.** When the API restarts and loads
   telemetry-state.json, any DID already in unhealthy or offline state
   is treated as a resumed state, not a new transition. The first
   post-boot health tick does NOT fire an alert for these DIDs. Only a
   subsequent state change (e.g., offline to healthy, or unhealthy to
   offline) triggers an alert. This prevents alert storms on API
   restarts.

**Degraded transitions are dashboard-only.** Transitions to degraded do
NOT dispatch push alerts. They appear on the status dashboard only.
Operators are expected to check the dashboard for degraded signals. This
is intentional to avoid alert fatigue on lower-severity conditions.

---

## 9. Operator contact registration

### Registration payload

```json
{
  "version": 1,
  "did": "did:key:z6Mk...",
  "timestamp": 1745100000000,
  "contacts": [
    {"type": "ntfy", "target": "my-validator-topic"},
    {"type": "telegram", "target": "123456789"},
    {"type": "email", "target": "operator@example.com"}
  ],
  "signature": "a1b2c3..."
}
```

**Endpoint:** `POST /v1/telemetry/contact`

Signed with the same Ed25519 key as heartbeats. Only the DID owner can register or update their contact methods. The same timestamp validation rules from Section 1 apply: skew tolerance of 300000 ms and strict monotonic increase per DID.

### Supported contact types for v1

| Type | Target format | Delivery method |
|---|---|---|
| `ntfy` | Topic string | POST to ntfy.sh |
| `telegram` | Chat ID | Bot API sendMessage (uses the existing Ensoul Telegram bot token) |
| `email` | Email address | Out of scope for v1 (logged but not sent) |

### Alert content

```
[Ensoul] Validator UNHEALTHY: ensoul-pioneer-jd
DID: did:key:z6Mk...
State: unhealthy (was: healthy)
Reason: peers == 0 for 3+ minutes
Height: 378000 (chain tip: 378050)
Last heartbeat: 2 minutes ago

Dashboard: https://status.ensoul.dev
```

### Opt-in

Contact registration is fully optional. Validators with no registered contact still have their telemetry collected and visible on the status dashboard. They just don't get push alerts.

---

## 10. Client-side behavior

### Data collection (runs every 60 seconds)

```bash
# Query CometBFT
STATUS=$(curl -s -m 5 http://localhost:26657/status)
NET_INFO=$(curl -s -m 5 http://localhost:26657/net_info)

# Extract fields
HEIGHT=$(echo "$STATUS" | python3 -c "...")
CATCHING_UP=$(echo "$STATUS" | python3 -c "...")
PEERS=$(echo "$NET_INFO" | python3 -c "...")
CMT_VERSION=$(echo "$STATUS" | python3 -c "...")

# System metrics
DISK_PCT=$(df / | tail -1 | awk '{print $5}' | tr -d '%')
MEM_PCT=$(...)  # platform-specific

# ABCI version from the repo
ABCI_VERSION=$(cat ~/ensoul/packages/node/src/version.ts | grep VERSION | ...)
```

### Signing

The client loads the validator's Ed25519 seed from `~/.ensoul/identity.json` (or `~/.cometbft-ensoul/node/config/priv_validator_key.json`), constructs the payload, serializes it using JCS (RFC 8785) with the `signature` field omitted, signs the canonical bytes, and appends the hex-encoded signature.

### Posting

```bash
curl -s -m 10 -X POST https://api.ensoul.dev/v1/telemetry/heartbeat \
  -H "Content-Type: application/json" \
  -H "X-Ensoul-Version: 1" \
  -d "$PAYLOAD"
```

On failure (non-200): wait 10 seconds, retry once. On second failure: log locally, continue. Never block.

### Installation

**Linux (systemd):** A systemd timer unit (`ensoul-heartbeat.timer`) firing every 60 seconds, calling a oneshot service (`ensoul-heartbeat.service`) that runs the heartbeat script.

**macOS (launchd):** A launchd plist with `StartInterval: 60` that runs the heartbeat script.

Both are installed by `install-validator.sh` (for new validators) or by the launchd wrapper setup script (for existing home machines).

### Local logging

Appends one line per heartbeat to `~/.ensoul/heartbeat.log`:

```
[2026-04-19T20:15:00Z] height=378000 peers=12 catching_up=false sent=ok
[2026-04-19T20:16:00Z] height=378001 peers=12 catching_up=false sent=ok
[2026-04-19T20:17:00Z] height=378001 peers=0  catching_up=false sent=fail(timeout) retry=ok
```

Log rotation: keep last 1000 lines (truncate on startup if larger).

---

## 11. Backward compatibility and upgrade path

Every heartbeat and contact registration includes a `version` field.

**Receiver behavior:**
- Version `1`: accept and process.
- Any other value (including 0, missing, or values > 1): reject with 400 and body `{"error": "unsupported version", "supported_versions": [1]}`.

There is no forward-compatibility. When v2 is defined, the receiver will be updated to accept both `1` and `2` simultaneously. Until then, unknown versions are rejected, not stored, not guessed at.

**Client upgrade path:** When the receiver rejects with 400, the client logs a warning: `"[heartbeat] Server rejected version M. Update your validator."` This surfaces in the operator's heartbeat.log without breaking anything. The client continues attempting to send on every cycle (the rejection is cheap).

**Schema evolution rules:**
- New optional fields can be added without bumping version.
- Removing a required field or changing semantics of an existing field requires a version bump.
- When a new version is introduced, the receiver accepts both the new and previous version simultaneously. Old versions are deprecated with a release cycle, not dropped immediately.

---

## 12. Threat model

### Defended

| Threat | Defense |
|---|---|
| **Impersonation** (attacker posts heartbeat as validator X) | Ed25519 signature verified against DID's public key. Attacker needs X's private key. |
| **Replay** (captured heartbeat replayed later) | Timestamp must be within 5 minutes of server clock. Monotonic increase enforced per DID. |
| **Cross-chain replay** (heartbeat from testnet replayed on mainnet) | `chain_id` is part of the signed payload. |
| **Unauthorized contact registration** (attacker registers their own contact for validator X) | Contact registration is signed with X's key. |
| **Alert flooding** (attacker triggers rapid state transitions to spam alerts) | 30-minute debounce per DID. |
| **Forged-heartbeat CPU exhaustion** (flood of unsigned payloads to waste signature verification CPU) | Per-IP rate limit (30/min) applied before signature verification. DID admission check before signature verification. |

### Not defended (acceptable)

| Threat | Why acceptable |
|---|---|
| **Validator lying about its own state** (reporting healthy when actually down) | The chain itself is the source of truth for block signatures. Heartbeats are hints for operators, not authoritative for consensus. A lying validator still misses blocks, which is observable on-chain. |
| **DoS on the receiver** (flood of signed heartbeats from many DIDs) | Mitigated by per-DID rate limiting (2/min) and per-IP rate limiting (30/min). A determined attacker with many valid DIDs could flood, but creating valid DIDs requires on-chain registration. Acceptable at our scale. |
| **Passive traffic analysis** (observer learns which IPs are validators) | HTTPS encrypts payload content. The receiver IP (api.ensoul.dev) is public anyway. Source IPs are visible to network observers but not to the Ensoul team (we don't log source IPs from heartbeats). |

---

## 13. What we DON'T do in v1

- **Complex alerting rules.** v1 alerts on state transitions (healthy to unhealthy). Custom thresholds, escalation chains, and PagerDuty integration are v2.
- **Multi-region receiver redundancy.** Single endpoint on api.ensoul.dev. If the API is down, heartbeats fail silently and validators continue operating.
- **Proactive probes.** The receiver never initiates connections to validators. This is passive-push only.
- **Heartbeat-based slashing.** Heartbeats are observability, not consensus. Missing heartbeats have zero on-chain consequences.
- **Validator-to-validator heartbeats.** Validators post to the central receiver only. Peer-to-peer health gossip is architecturally different and out of scope.

---

## Rejected alternatives

### Alternative 1: Pull-based monitoring (Tenderduty-style)

**Considered:** Run a Tenderduty-like monitor on Ashburn that queries each validator's CometBFT RPC.

**Rejected because:** Pioneer validators bind RPC to localhost. We cannot reach their RPC from outside. We would need to either (a) ask Pioneers to open port 26657 (security risk, operator burden) or (b) route through Tailscale (requires Pioneers to install Tailscale, which they haven't). Push-based is the only architecture that works without operator cooperation beyond running the standard install.

### Alternative 2: On-chain heartbeat transactions

**Considered:** Validators submit a `heartbeat` transaction every N blocks, recorded on-chain.

**Rejected because:** Adds unnecessary chain load (40 validators x 1 tx/min = 40 tx/min = significant fraction of block space). Burns gas/fees. The chain already records block signatures, which is the authoritative liveness signal. Off-chain telemetry is appropriate for the richer metadata (peers, disk, version) that doesn't belong on-chain.

### Alternative 3: Prometheus metrics endpoint on each validator

**Considered:** Each validator exposes a Prometheus endpoint; central Prometheus scrapes them all.

**Rejected because:** Same reachability problem as Alternative 1. Also requires operators to configure and maintain Prometheus, which is unrealistic for hobbyist Pioneers on $5 VPSes.

### Alternative 4: Unsigned heartbeats with IP allowlisting

**Considered:** Skip signatures; instead, the receiver maintains an IP allowlist per validator.

**Rejected because:** Validator IPs change (dynamic cloud IPs, ISP reassignment). Maintaining an allowlist requires operator communication on every IP change. Signatures are self-authenticating and don't require any out-of-band coordination.

### Alternative 5: WebSocket persistent connection instead of HTTP POST

**Considered:** Validators maintain a WebSocket connection to the receiver for real-time telemetry.

**Rejected because:** Persistent connections are fragile on cheap VPSes with aggressive NAT timeouts. HTTP POST is stateless, works through any proxy/firewall, and is trivially retryable. WebSocket adds connection management complexity for negligible latency benefit (60-second heartbeat interval doesn't need sub-second delivery).
