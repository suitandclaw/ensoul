# Ensoul Security Audit

**Latest audit:** 2026-03-27 (infrastructure hardening + re-assessment)
**Previous audit:** 2026-03-19 (initial code audit)
**Scope:** Full infrastructure, application, cryptographic, and operational security

---

## Status Summary

| Category | Rating | Details |
|----------|--------|---------|
| VPS hardening | HARDENED | SSH port 2222, root disabled, fail2ban, UFW locked down |
| Home machine exposure | ACCEPTABLE | Behind NAT, Tailscale only. RPC should bind to 127.0.0.1 |
| Transaction signature verification | CRITICAL VULNERABILITY | Function exists but is never called |
| Consciousness data encryption | ACCEPTABLE | stateRoot (hash) stored plaintext; encrypted shards are off-chain |
| Validator key protection | SECURE | 600 permissions on all keys |
| P2P network security | SECURE | CometBFT handles peer auth and node ID verification |
| Web service security | PARTIALLY SECURE | Rate limiting exists; CORS, CSP, input validation need work |
| Telegram bot | SECURE | User ID auth, /lock command, credentials outside repo |
| Dependency vulnerabilities | LOW RISK | 4 moderate (dev-only brace-expansion) |
| Genesis keys in git history | KNOWN RISK | Seeds committed before .gitignore; repo is private |

---

## Infrastructure Hardening (2026-03-27)

### VPS (178.156.199.91)

| Control | Before | After |
|---------|--------|-------|
| SSH port | 22 | 2222 |
| Root login | Allowed | Disabled |
| Password auth | Allowed | Disabled (key-only) |
| fail2ban | Not installed | Active (3 retries, 1hr ban) |
| UFW port 26657 (RPC) | OPEN to public | CLOSED |
| UFW allowed | 22, 26656, 26657 | 2222, 26656 |
| Non-root user | None | `ensoul` with sudo |
| Unattended upgrades | Installed | Installed |

### Home Machines (MBP, Mini 1, Mini 2, Mini 3)

All behind NAT, accessible only via Tailscale. CometBFT RPC binds to 0.0.0.0 which is acceptable behind NAT but should be tightened to 127.0.0.1 at the next planned restart.

### Key File Permissions

| File | Permissions | Status |
|------|------------|--------|
| priv_validator_key.json (all machines) | 600 | Secure |
| node_key.json (all machines) | 600 | Secure |
| genesis-keys/*.json | 600 | Fixed during audit |
| ~/ensoul-key-vault/ | 700 | Fixed during audit |
| No key material in log files | Verified | Secure |

---

## Critical Findings (from both audits)

### ENSOUL-001: Transaction Signature Verification Not Enforced

**Severity: CRITICAL** (identified 2026-03-19, still open)

`verifyTxSignature()` exists in `packages/ledger/src/transactions.ts` but is never called in the ABCI application's CheckTx or FinalizeBlock handlers. Any attacker who knows a valid DID and its current nonce can forge transactions including transfers, stakes, and delegations.

**Status:** Open. Fix requires adding signature verification calls in `application.ts` CheckTx handler with public key extraction from DID.

### ENSOUL-001b: agent_register and consciousness_store Bypass All Validation

**Severity: CRITICAL** (identified 2026-03-27)

These two transaction types completely skip signature verification, nonce checking, and balance validation (application.ts lines 440-448). Additionally, the `tx.data` field has no size limit, creating a DoS vector via memory exhaustion.

**Status:** Open.

### ENSOUL-003: Browser Wallet Uses XOR Encryption

**Severity: CRITICAL** (identified 2026-03-19, still open)

The browser wallet encrypts seeds using XOR with SHA-256, which is cryptographically broken. Single-round SHA-256 is fast to brute-force and XOR leaks information.

**Status:** Open.

### ENSOUL-004: Handshake Verify Never Checks Signature

**Severity: CRITICAL** (identified 2026-03-19, still open)

The `/v1/handshake/verify` endpoint always returns `valid: true` for fresh timestamps without actually verifying the Ed25519 signature.

**Status:** Open.

---

## Medium and Lower Findings

See the previous audit (2026-03-19) for the complete list of ENSOUL-005 through ENSOUL-018. All remain open except:

- **ENSOUL-017 (genesis keys gitignored):** Confirmed. However, seeds exist in git history from early commits. Repository is private. Risk is accepted while repo access is restricted to the team.

---

## New Protections Added (2026-03-27)

### Telegram Bot Security

- Only responds to authorized user ID 383608846
- All other messages silently ignored (logged for audit)
- /restart and /update require /confirm before execution
- /lock command disables all destructive operations until /unlock
- Bot token stored in `~/.ensoul/telegram-bot.env` outside the repo
- Token never appears in any log output

### Dual Alert Channels

Process manager alerts now fire to both ntfy.sh and Telegram simultaneously. If one channel fails, the other still reaches the operator.

### Dashboard Admin Hardening

- Reset button removed (resets are SSH operations only)
- Restart button requires confirmation dialog
- All admin operations execute via authenticated SSH

---

## Dependency Audit

```
4 moderate vulnerabilities found (brace-expansion in dev tooling)
0 critical, 0 high
```

All vulnerabilities are in development-only dependencies (vitest coverage tooling). No production runtime impact. Go dependencies (CometBFT, Cosmovisor) are from official repositories.

---

## Prioritized Remediation Roadmap

### Phase 1: Before accepting external validators

1. **Implement signature verification** in CheckTx and FinalizeBlock for all transaction types
2. **Add full validation** to agent_register and consciousness_store (signature, nonce)
3. **Add payload size limits** (1 MB max for tx.data)
4. **Fix browser wallet** to use proper Ed25519 + scrypt encryption
5. **Fix handshake verification** to actually verify signatures

### Phase 2: Before external economic activity

6. Add chainId to transaction signature payload (prevent cross-chain replay)
7. Replace clock-based lockup with block-height-based lockup
8. Encrypt onboarding and genesis key files at rest
9. Include delegation registry in state root computation
10. Restrict CORS to ensoul.dev domains only

### Phase 3: Production hardening

11. Bind CometBFT RPC to 127.0.0.1 on all machines
12. Add Content-Security-Policy headers to all web properties
13. Implement HSM support for validator key signing
14. Set up sentry node architecture for DDoS protection
15. External security audit by a blockchain-specialized firm
16. Bug bounty program

---

## Attack Surface Map

```
Public Internet
  |
  +-- 178.156.199.91:26656  CometBFT P2P (node ID authenticated)
  +-- 178.156.199.91:2222   SSH (key-only, fail2ban)
  |
  +-- Cloudflare Tunnel (encrypted, Cloudflare-managed TLS)
  |     +-- explorer.ensoul.dev -> MBP:3000
  |     +-- status.ensoul.dev -> MBP:4000
  |     +-- api.ensoul.dev -> MBP:5050
  |     +-- v0.ensoul.dev -> MBP:9000
  |
  +-- Tailscale Network (WireGuard encrypted, authenticated)
        +-- 100.67.81.90:26657   MBP CometBFT RPC
        +-- 100.86.108.114:26657 Mini 1 CometBFT RPC
        +-- 100.117.84.28:26657  Mini 2 CometBFT RPC
        +-- 100.127.140.26:26657 Mini 3 CometBFT RPC
        +-- 100.72.212.104:26657 VPS CometBFT RPC
```

Public attack surface: CometBFT P2P (26656), SSH (2222), Cloudflare-proxied web services. All internal communication is over Tailscale (WireGuard encryption).
