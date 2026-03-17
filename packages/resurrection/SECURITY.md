# Security: @ensoul/resurrection

## Threat Model
The resurrection protocol is the most security-critical module. If compromised, attackers can kill agents permanently, hijack resurrections, or drain escrow funds.

## Invariants
1. Heartbeats MUST be signed by the agent's identity key. No unsigned heartbeats.
2. Status transitions MUST follow the state machine: ALIVE→CONCERNING→UNRESPONSIVE→DEAD. No skipping.
3. Death declarations MUST only be accepted when the agent's status is DEAD.
4. Resurrection plans MUST be signed by the agent. Guardian modifications MUST also be signed.
5. Resurrection confirmation MUST be signed by the agent's original identity key. Proves genuine revival.
6. Escrow debits MUST only happen through bounty payment (on confirmed resurrection) or hosting costs.
7. Excluded hosts MUST NOT be able to bid on an auction.
8. Bid ordering MUST be deterministic: preferred hosts > lowest cost > highest reputation > fastest time.

## Attack Mitigations
- False death declarations: rejected if agent is not in DEAD status
- Malicious hosts: must meet compute requirements, excluded hosts blocked, auction-based selection
- Escrow theft: only deducted on confirmed resurrection or ongoing hosting
- Plan tampering: plans are signed and hashed, modifications require valid signature
- Auction spam: max 20 bids per auction, worst bids replaced by better ones

## Fuzz Targets
- Heartbeat recording with various block heights, timestamps, versions
- State machine transitions with edge cases (rapid heartbeats, long gaps)
- Auction with many bids, excluded hosts, preferred hosts, ties
- Plan creation/update with version conflicts, insufficient escrow
