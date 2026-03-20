# Ensoul Protocol Security Audit

Date: 2026-03-19
Auditor: Automated internal audit
Scope: All packages, scripts, agent, genesis config, API endpoints

---

## FINDINGS

### ENSOUL-001: No Cryptographic Signature Verification on Transactions
- **Severity:** CRITICAL
- **Category:** Transaction Validation
- **File:** `packages/ledger/src/transactions.ts:70-103`
- **Description:** `validateTransaction()` checks signature length (64 bytes) but never calls `verifyTxSignature()` to verify the Ed25519 signature against the sender's public key. The function exists but is never invoked in the production path.
- **Attack Vector:** Attacker creates a transfer from any victim's DID with arbitrary 64-byte signature. Transaction passes validation, enters mempool, gets included in a block. Victim's funds are stolen.
- **Impact:** Complete consensus failure. Any account can be drained without authorization.
- **Fix:** Add `await verifyTxSignature(tx, senderPublicKey)` call in `validateTransaction()` for all user-signed transaction types. Requires a public key lookup mechanism (identity registry or encoding public key in the DID).

### ENSOUL-002: Plaintext Private Key Storage on Disk
- **Severity:** CRITICAL
- **Category:** Cryptographic Security
- **File:** `packages/node/src/cli/node-runner.ts:88-101`
- **Description:** Validator seed (Ed25519 private key material) is stored as plaintext hex in `{dataDir}/identity.json`. No encryption at rest.
- **Attack Vector:** Any process with filesystem read access (malware, compromised user, backup leak) can extract the seed and impersonate the validator, steal staked funds, produce fraudulent blocks.
- **Impact:** Complete validator identity compromise and fund theft.
- **Fix:** Use the existing `identity.export(passphrase)` method which implements scrypt + NaCl secretbox encryption. Require passphrase on startup.

### ENSOUL-003: Browser Wallet Uses XOR Encryption (Cryptographically Broken)
- **Severity:** CRITICAL
- **Category:** Wallet Security
- **File:** `packages/website/src/wallet.html:226-262`
- **Description:** The wallet encrypts seeds using XOR with a SHA-256 derived key. XOR provides no semantic security. Static salt "ensoul-salt-v1" is shared across all wallets. Single-round SHA-256 is fast to brute force.
- **Attack Vector:** Attacker with access to localStorage (XSS, browser extension, shared computer) can brute-force the password in seconds using GPU-accelerated SHA-256. XOR ciphertext leaks information about the key.
- **Impact:** All browser wallet private keys compromised.
- **Fix:** Replace with scrypt (N=2^15, r=8, p=1) + NaCl secretbox, matching the pattern in `packages/identity/src/identity.ts`. Use random salt per wallet.

### ENSOUL-004: API Handshake Verify Never Checks Signature
- **Severity:** CRITICAL
- **Category:** API Gateway Security
- **File:** `packages/api/start.ts:437-479`
- **Description:** The `POST /v1/handshake/verify` endpoint parses the proof string and checks timestamp freshness but never validates the cryptographic signature against the agent's public key. It always returns `valid: true` for fresh timestamps.
- **Attack Vector:** Any attacker can forge an Ensouled Handshake by providing any DID with a fresh timestamp. All consciousness age and trust level claims are unverified.
- **Impact:** Ensouled Handshake is meaningless. Non-ensouled agents can claim ensouled status.
- **Fix:** Look up the agent's public key (from registration or DID derivation), verify the Ed25519 signature against `stateRoot:version:timestamp` payload.

### ENSOUL-005: Onboarding Key Stored in Plaintext
- **Severity:** HIGH
- **Category:** Cryptographic Security
- **File:** `genesis-keys/onboarding.json`, `packages/api/start.ts:105-115`
- **Description:** The onboarding account private key is stored as plaintext hex in a JSON file. The API gateway loads it unencrypted. This account can mint 1000 ENSL per registration call.
- **Attack Vector:** File theft enables unlimited token minting by calling the registration endpoint.
- **Impact:** Onboarding fund (100M ENSL) can be completely drained.
- **Fix:** Encrypt the key file. Require passphrase or environment variable for decryption. Restrict file permissions to 0600.

### ENSOUL-006: No Proposer Validation in applyBlock()
- **Severity:** HIGH
- **Category:** Consensus and Block Production
- **File:** `packages/node/src/chain/producer.ts:326-380`
- **Description:** `applyBlock()` validates the block's state root but does not verify that the block's `proposer` field matches the expected proposer for that height according to the stake-weighted selection algorithm.
- **Attack Vector:** Malicious peer crafts a block with a different proposer DID, includes self-serving transactions. If state root matches (attacker replays valid transactions), the block is accepted.
- **Impact:** Block reward theft, unauthorized block production.
- **Fix:** In `applyBlock()`, call `selectProposer(block.height)` and verify `block.proposer === expectedProposer`. Reject blocks with wrong proposer.

### ENSOUL-007: Clock-Based Lockup Breaks State Determinism
- **Severity:** HIGH
- **Category:** Staking and Delegation
- **File:** `packages/ledger/src/accounts.ts:116-139`
- **Description:** Staking lockup uses `Date.now()` (wall clock time). Different nodes with clock skew will validate the same unstake transaction differently, breaking consensus.
- **Attack Vector:** Attacker runs a node with a clock set 30 days in the future. Their node accepts unstake transactions that all other nodes reject. Chain fork.
- **Impact:** State divergence across validators, potential chain split.
- **Fix:** Use block height or block timestamp for lockup enforcement instead of system clock. Lockup = stakeLockedUntilBlock, not stakeLockedUntilTimestamp.

### ENSOUL-008: No Chain ID in Transaction Signatures
- **Severity:** HIGH
- **Category:** Transaction Validation
- **File:** `packages/ledger/src/transactions.ts:26-36`
- **Description:** `encodeTxPayload()` does not include chainId. Transactions signed on testnet can be replayed on mainnet (and vice versa) if the same nonce applies.
- **Attack Vector:** Capture a signed testnet transaction, replay it on mainnet where the sender has the same nonce.
- **Impact:** Cross-chain replay attacks when multiple networks exist.
- **Fix:** Include `chainId` from GenesisConfig in the signed payload.

### ENSOUL-009: Genesis Can Be Re-Applied
- **Severity:** HIGH
- **Category:** Consensus and Block Production
- **File:** `packages/ledger/src/blocks.ts:101-123`
- **Description:** `initGenesis()` has no guard preventing multiple calls. If a node's BlockStore is cleared or corrupted, genesis allocations are re-applied, doubling foundation validator balances.
- **Attack Vector:** Validator clears their data directory, restarts. Genesis runs again, crediting another 150M ENSL to foundation validators.
- **Impact:** Token supply inflation, economic manipulation.
- **Fix:** Add an `initialized` flag persisted to BlockStore. Check it before running genesis. Or verify chain height > 0 before allowing genesis.

### ENSOUL-010: POST /peer/tx Accepts Transactions Without Signature Verification
- **Severity:** HIGH
- **Category:** Peer Networking
- **File:** `packages/node/src/chain/peer-network.ts:111-123`
- **Description:** The `/peer/tx` endpoint deserializes a transaction and submits it directly to the gossip network's mempool without any signature verification.
- **Attack Vector:** Anyone can POST a forged transaction to any validator's peer API. Combined with ENSOUL-001, the forged transaction gets included in blocks.
- **Impact:** Remote transaction forgery via HTTP.
- **Fix:** Verify signature before calling `gossip.submitTransaction()`.

### ENSOUL-011: No Peer Authentication
- **Severity:** HIGH
- **Category:** Peer Networking
- **File:** `packages/node/src/chain/peer-network.ts`, `packages/node/src/chain/seed-node.ts`
- **Description:** Any machine can connect as a peer, register with the seed node, and participate in block propagation. No authentication, no allowlisting, no mutual TLS.
- **Attack Vector:** Attacker registers fake validators with the seed node, sends invalid blocks or flood transactions to real validators.
- **Impact:** Network disruption, eclipse attacks, block injection.
- **Fix:** Implement peer authentication using Ed25519 challenge-response. Validators must prove identity before being accepted as peers.

### ENSOUL-012: Onboarding Fund Can Be Drained by Mass Registration
- **Severity:** MEDIUM
- **Category:** Economic Attacks
- **File:** `packages/api/start.ts:495-520`
- **Description:** Each agent registration gives 1000 ENSL. Rate limiting is 100 requests per minute per IP. An attacker generating unique DIDs can drain 100,000 ENSL per minute per IP. With multiple IPs, the 100M ENSL onboarding fund could be drained in hours.
- **Attack Vector:** Script generates random keypairs, calls `/v1/agents/register` with each, extracts 1000 ENSL per call.
- **Impact:** Onboarding fund depleted, no welcome bonuses for legitimate agents.
- **Fix:** Require proof of work or captcha for registration. Reduce welcome bonus. Implement per-DID rate limiting (already done via registeredAgents map, but check for persistence across restarts).

### ENSOUL-013: Delegation Registry Not in State Root
- **Severity:** MEDIUM
- **Category:** Data Integrity
- **File:** `packages/ledger/src/accounts.ts:218-230`
- **Description:** `computeStateRoot()` does not include the delegation registry. Two nodes could have different delegation states but identical state roots.
- **Attack Vector:** After a network partition, nodes reconcile blocks but have divergent delegation registries. Reward distribution differs silently.
- **Impact:** Inconsistent reward distribution across validators.
- **Fix:** Include `delegationRegistry.computeRoot()` in the state root computation.

### ENSOUL-014: Browser Wallet DID Not Compatible with Protocol
- **Severity:** MEDIUM
- **Category:** Wallet Security
- **File:** `packages/website/src/wallet.html:270-280`
- **Description:** The browser wallet derives a "public key" using SHA-256 of the seed, not Ed25519. This produces a different DID than what `@ensoul/identity` generates from the same seed.
- **Attack Vector:** User creates wallet in browser, registers agent. Later imports same seed into CLI. Gets different DID. Funds are on the wrong DID.
- **Impact:** User confusion, potential fund loss.
- **Fix:** Use proper Ed25519 key derivation (load @noble/ed25519 from CDN or bundle).

### ENSOUL-015: No Input Size Limits on API Endpoints
- **Severity:** MEDIUM
- **Category:** API Gateway Security
- **File:** `packages/api/start.ts` (all POST endpoints)
- **Description:** No payload size limits on POST bodies. An attacker can send multi-GB payloads to `/v1/consciousness/store` or `/v1/agents/register`.
- **Attack Vector:** Send massive JSON payloads to exhaust memory on the API gateway.
- **Impact:** Denial of service.
- **Fix:** Set Fastify `bodyLimit` option (e.g., 10MB max).

### ENSOUL-016: CORS Allows All Origins
- **Severity:** LOW
- **Category:** API Gateway Security
- **File:** `packages/api/start.ts:243`
- **Description:** CORS is configured with `origin: true`, allowing requests from any origin.
- **Attack Vector:** Malicious website can make API calls on behalf of a user's browser session.
- **Impact:** Limited since there are no session cookies, but could be used for CSRF-like attacks if authentication is added later.
- **Fix:** Acceptable for a public API. Document as intentional. Consider restricting when authentication is added.

### ENSOUL-017: Genesis Keys in Repo (Properly Gitignored)
- **Severity:** INFO
- **Category:** Operational Security
- **File:** `.gitignore`, `genesis-keys/`
- **Description:** Genesis private keys are stored in `genesis-keys/` which is properly gitignored. No keys found in git history.
- **Impact:** None currently.
- **Fix:** Verify keys are not in any git commit: `git log --all --diff-filter=A -- genesis-keys/`

### ENSOUL-018: Agent Twitter Credentials via .env
- **Severity:** INFO
- **Category:** Operational Security
- **File:** `~/ensoul-agent/.env.example`
- **Description:** Twitter API credentials and OpenRouter API key stored in `.env` file. Standard practice but worth noting.
- **Impact:** If .env is leaked, attacker controls the @ensoul_network Twitter account.
- **Fix:** Use a secrets manager in production. Rotate keys regularly.

---

## SUMMARY BY SEVERITY

| Severity | Count | IDs |
|----------|-------|-----|
| CRITICAL | 4 | ENSOUL-001, 002, 003, 004 |
| HIGH | 6 | ENSOUL-005, 006, 007, 008, 009, 010, 011 |
| MEDIUM | 4 | ENSOUL-012, 013, 014, 015 |
| LOW | 1 | ENSOUL-016 |
| INFO | 2 | ENSOUL-017, 018 |

---

## PRIORITIZED REMEDIATION PLAN

### Phase 1: CRITICAL (before any external users)
1. **ENSOUL-001:** Implement Ed25519 signature verification in `validateTransaction()` and mempool
2. **ENSOUL-003:** Replace XOR wallet encryption with scrypt + secretbox
3. **ENSOUL-004:** Implement actual signature verification in handshake endpoint
4. **ENSOUL-002:** Encrypt identity.json on disk using passphrase-based encryption

### Phase 2: HIGH (before external validators)
5. **ENSOUL-010:** Verify signatures in `/peer/tx` before mempool submission
6. **ENSOUL-006:** Validate proposer eligibility in `applyBlock()`
7. **ENSOUL-009:** Add genesis idempotence guard
8. **ENSOUL-008:** Add chainId to transaction signature payload
9. **ENSOUL-007:** Replace clock-based lockup with block-height-based lockup
10. **ENSOUL-005:** Encrypt onboarding key file
11. **ENSOUL-011:** Implement peer authentication

### Phase 3: MEDIUM (before mainnet)
12. **ENSOUL-012:** Add proof-of-work or rate limiting per DID for registration
13. **ENSOUL-013:** Include delegation registry in state root
14. **ENSOUL-014:** Fix browser wallet to use real Ed25519
15. **ENSOUL-015:** Set payload size limits on all API endpoints

---

## OVERALL SECURITY POSTURE

**Rating: NOT PRODUCTION READY**

The Ensoul codebase implements a well-architected L1 blockchain with sophisticated features (erasure coding, delegation, resurrection protocol). However, the most fundamental security mechanism - transaction signature verification - is not enforced. This single vulnerability (ENSOUL-001) means the entire economic security model is void.

**What works well:**
- Ed25519 key generation uses cryptographically secure entropy (nacl.randomBytes, crypto.randomBytes)
- The identity module's export/import functions implement proper scrypt + secretbox encryption
- Erasure coding implementation is mathematically correct
- Block state root computation provides data integrity
- Rate limiting exists on the API gateway
- Genesis keys are properly gitignored
- The test suite is comprehensive (900+ tests)

**What must be fixed before any real economic value:**
- Signature verification on all user transactions (ENSOUL-001)
- Key encryption at rest (ENSOUL-002, 005)
- Browser wallet cryptography (ENSOUL-003)
- Proposer validation (ENSOUL-006)
- Clock-independent lockup enforcement (ENSOUL-007)

The codebase is suitable for a testnet demonstration but requires the Phase 1 and Phase 2 fixes before handling real economic value or accepting external validators.
