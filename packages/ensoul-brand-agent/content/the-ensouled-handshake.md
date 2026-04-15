# The Ensouled Handshake

Three HTTP headers an agent attaches to every request. X-Ensoul-Identity carries its DID. X-Ensoul-Proof carries a signed proof of state root, version, and timestamp. X-Ensoul-Since carries when the agent was first ensouled.

---

Any receiving agent verifies the proof in constant time against the sender's Ed25519 public key. Non-ensouled agents cannot produce a valid handshake. The proof is short enough to fit comfortably in a header without bloating requests.

---

This turns identity verification from a platform-mediated step into a cryptographic one. No central registry. No vendor lookup. The proof itself is the answer.
