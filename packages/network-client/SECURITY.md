# Security: @ensoul/network-client

## Threat Model

The network client handles all communication between an agent's local state and the decentralized Ensoul network. It performs erasure coding, shard distribution, and retrieval over libp2p P2P connections. The primary threats are data integrity during transmission, shard manipulation, and network-level attacks.

**Trust boundary:** The client trusts the local runtime and @ensoul/identity for cryptography. It does NOT trust network peers, stored shards, or any data received from the network. All data is encrypted before transmission and verified after retrieval.

**Assets protected:**
- Agent state confidentiality (encryption before network storage)
- State integrity (erasure coding + Merkle root verification)
- Network privacy (Noise encrypted transport)

## Attack Vectors & Mitigations

### Man-in-the-Middle
**Vector:** Attacker intercepts shard data in transit between client and storage nodes.
**Mitigation:** All libp2p connections use Noise protocol encryption (@chainsafe/libp2p-noise). All agent data is encrypted by the agent's identity before entering the network. Even if transport encryption is compromised, the attacker sees only ciphertext.

### Shard Corruption in Transit
**Vector:** Network error or malicious node corrupts shard data during transmission.
**Mitigation:** Each shard's Blake3 hash is computed before distribution and verified after retrieval. The state root (Merkle hash) verifies the reconstructed blob matches the original. Any corruption is detected.

### Shard Withholding
**Vector:** Storage nodes accept shards but refuse to serve them back.
**Mitigation:** Erasure coding (K-of-N) ensures the client only needs K out of N shards to reconstruct. With 2-of-4, any 2 nodes can reconstruct the data. The client tries all peers to gather enough shards.

### Eclipse Attack
**Vector:** Malicious nodes surround the client, preventing connection to honest nodes.
**Mitigation:** The client connects to known bootstrap peers. Attestations from validators use Ed25519 signatures, verifiable against the registered validator set. The Kad-DHT and mDNS discovery diversify peer connections.

### Reconstruction Failure
**Vector:** Too many shards are lost (more than N-K), making reconstruction impossible.
**Mitigation:** The erasure config is tunable. For critical data, agents can increase redundancy (e.g., 3-of-7). The credit system incentivizes nodes to maintain high uptime. The challenge module penalizes nodes that fail to serve stored shards.

### Replay Attack
**Vector:** Attacker serves an old version's shards as the latest, rolling back the agent's state.
**Mitigation:** Each state has a version number and state root. The client tracks its latest known version locally. Shards include the version and state root, which are verified against the agent's expectations.

## Invariants

1. **Erasure coding correctness:** `decode(shards, config, length)` MUST produce exactly the original data when given any K valid shards from `encode(data, config)`. All C(N,K) combinations must work.
2. **Shard isolation:** Shards from different (agentDid, version) tuples MUST NOT be mixed during reconstruction.
3. **Pre-network encryption:** State blobs MUST be encrypted by the agent identity before being passed to `storeState`. The network client never stores plaintext.
4. **Transport encryption:** All libp2p connections MUST use Noise protocol encryption.
5. **Version monotonicity:** The client MUST NOT accept a retrieved state with a lower version than the locally known latest, unless explicitly requested.
6. **GF(256) field correctness:** For all nonzero a in GF(256): `gfMul(a, 1) == a`, `gfMul(a, gfInv(a)) == 1`, `gfDiv(gfMul(a, b), b) == a`.

## Fuzz Targets

### Erasure coding
- encode/decode with data sizes: 0, 1, 2, odd, even, large (10MB)
- decode with corrupted shards (flipped bits)
- decode with truncated shards
- decode with too few shards (< K)
- All C(N,K) shard combinations for reconstruction

### Protocol
- Malformed messages (truncated, missing separator, invalid JSON)
- Messages with extremely large headers
- Binary payloads containing null bytes

### GF(256)
- gfMul/gfDiv with all 256×256 input pairs
- gfInv for all 255 nonzero elements

## Cryptographic Primitives

| Operation | Library | Algorithm |
|-----------|---------|-----------|
| Transport encryption | @chainsafe/libp2p-noise | Noise Protocol |
| Stream multiplexing | @chainsafe/libp2p-yamux | Yamux |
| Peer discovery | @libp2p/mdns, @libp2p/kad-dht | mDNS, Kademlia |
| Erasure coding | Custom (this module) | GF(256) Reed-Solomon (K=2) |
| State encryption | @ensoul/identity | X25519 + XSalsa20-Poly1305 |

**Custom cryptography note:** The GF(256) erasure coding is a standard mathematical construction, not custom cryptography. It uses the AES field (polynomial 0x11b, generator α=3) with well-known log/exp table multiplication. The encoding/decoding is a linear algebra operation over this field.
