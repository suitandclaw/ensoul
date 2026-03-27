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

All behind NAT, accessible only via Tailscale. CometBFT RPC now binds to 127.0.0.1:26657 on all machines (changed from 0.0.0.0 via rolling restart on 2026-03-27, zero downtime, 5/5 validators signed throughout).

### Key File Permissions

| File | Permissions | Status |
|------|------------|--------|
| priv_validator_key.json (all machines) | 600 | Secure |
| node_key.json (all machines) | 600 | Secure |
| genesis-keys/*.json | 600 | Fixed during audit |
| ~/ensoul-key-vault/ | 700 | Fixed during audit |
| No key material in log files | Verified | Secure |

---

## Critical Findings

### ENSOUL-001: Transaction Signature Verification Not Enforced

**Severity: CRITICAL** (identified 2026-03-19)

**Status: RESOLVED** (commit a9a0386, 2026-03-27)

Ed25519 signature verification is now enforced in BOTH CheckTx and FinalizeBlock for every transaction type. The `verifySignature()` function extracts the public key from the sender's DID, verifies the Ed25519 signature over the canonical transaction payload, and rejects with code 31 if invalid. Four test cases pass: valid signature accepted, tampered signature rejected, wrong key rejected, missing signature rejected.

### ENSOUL-001b: agent_register and consciousness_store Bypass All Validation

**Severity: CRITICAL** (identified 2026-03-27)

**Status: RESOLVED** (commit a9a0386, 2026-03-27)

Both transaction types now have full validation: Ed25519 signature verification, nonce checking, DID format validation, payload size limits (1 MB max for tx.data, 10 KB for metadata), and data structure validation. agent_register rejects duplicates. consciousness_store requires the agent to be registered first.

### ENSOUL-003: Browser Wallet Uses XOR Encryption

**Severity: CRITICAL** (identified 2026-03-19)

**Status: RESOLVED** (resolved in a prior update before 2026-03-27)

The wallet now uses AES-256-GCM with PBKDF2 key derivation (100,000 iterations, random 16-byte salt, random 12-byte IV). The XOR implementation was replaced. Remaining issue: key derivation from seed uses SHA-256 instead of proper Ed25519 (ENSOUL-014, medium severity, separate fix).

### ENSOUL-004: Handshake Verify Never Checks Signature

**Severity: CRITICAL** (identified 2026-03-19)

**Status: RESOLVED** (2026-03-27)

The `/v1/handshake/verify` endpoint now performs three verification steps: (1) Ed25519 signature verification against the agent's registered public key, (2) stateRoot comparison against the on-chain consciousness commitment, (3) timestamp freshness check (10-minute window). All three must pass. Fixed undefined variable bugs where `sigHex` and `stateRoot` were never extracted from the proof string.

### ENSOUL-005: Genesis Key Seeds in Git History

**Severity: HIGH** (identified 2026-03-27)

**Status: REVISED to LOW** (2026-03-27)

Investigation confirmed genesis key files were NEVER committed to git. The .gitignore has protected them since repository creation. Added pre-commit hook (`scripts/pre-commit-security-check.sh`) that blocks commits containing seed hex strings, private key markers, bot tokens, and .env files. Expanded .gitignore to cover *.env, key-vault/, *-key.json, *-seed.txt.

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

1. ~~Implement signature verification~~ DONE (commit a9a0386)
2. ~~Add full validation to agent_register and consciousness_store~~ DONE (commit a9a0386)
3. ~~Add payload size limits (1 MB)~~ DONE (commit a9a0386)
4. ~~Fix browser wallet encryption~~ DONE (AES-256-GCM + PBKDF2 already in place)
5. ~~Fix handshake verification~~ DONE (2026-03-27)
6. ~~Bind CometBFT RPC to 127.0.0.1~~ DONE (rolling restart 2026-03-27)
7. ~~Add pre-commit hook for secret detection~~ DONE (2026-03-27)

### Phase 2: Before external economic activity

8. Add chainId to transaction signature payload (prevent cross-chain replay)
9. Replace clock-based lockup with block-height-based lockup
10. Encrypt onboarding and genesis key files at rest
11. Include delegation registry in state root computation
12. Restrict CORS to ensoul.dev domains only
13. Fix wallet Ed25519 key derivation (ENSOUL-014)

### Phase 3: Production hardening

14. Add Content-Security-Policy headers to all web properties
15. Implement HSM support for validator key signing
16. Set up sentry node architecture for DDoS protection
17. External security audit by a blockchain-specialized firm
18. Bug bounty program

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
