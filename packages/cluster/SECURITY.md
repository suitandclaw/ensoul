# Security: @ensoul/cluster

## Threat Model

### Assets
- Validator Ed25519 private keys (seed.hex files in each validator directory)
- Cluster configuration (cluster.json) containing validator DIDs and ports
- Genesis configuration with token allocations
- DID export files used in cross-machine genesis coordination

### Threats

1. **Key Extraction**: Seed files stored as hex on disk. An attacker with filesystem access can steal validator identities.
   - Mitigation: File permissions should be set to 0600 on seed.hex files.
   - Mitigation: Each validator has an independent key; compromise of one does not affect others.
   - Mitigation: Encrypted-at-rest seed storage planned for v2.

2. **Configuration Tampering**: Modified cluster.json could alter port assignments, bootstrap peers, or genesis.
   - Mitigation: Genesis config is validated (allocations sum, percentages sum to 100%) before use.
   - Mitigation: Validators verify blocks via Ed25519 signatures regardless of config.

3. **Process Injection**: Malicious process claiming to be a validator.
   - Mitigation: All blocks require Ed25519 signatures from registered validator DIDs.
   - Mitigation: Round-robin proposer selection prevents unauthorized block production.

4. **Cross-Machine DID Export Tampering**: Modified DID export files during genesis coordination.
   - Mitigation: DID files should be transferred over secure channels (SSH/SCP).
   - Mitigation: Final merged genesis is validated before distribution.
   - Mitigation: Each machine retains its own seeds; only public DIDs are exported.

5. **Denial of Service**: Resource exhaustion from too many validator processes.
   - Mitigation: Process manager limits automatic restarts (max 5 per validator).
   - Mitigation: Graceful shutdown with SIGTERM then SIGKILL escalation.

## Invariants

1. Each validator has a unique Ed25519 identity (generated from independent random seeds).
2. Seeds are never transmitted over the network; only public DIDs are exported.
3. Genesis allocations must sum to total supply (1 billion ENSL).
4. Genesis percentages must sum to 100%.
5. Validator stakes are drawn from the 15% Foundation Validators allocation.
6. Total validator stake cannot exceed the Foundation allocation.
7. Bootstrap peer is always validator-0 on each machine.
8. API ports are always P2P port + 1000.
9. Process manager never spawns more processes than the configured validator count.
10. Shutdown always terminates all child processes (SIGTERM with timeout, then SIGKILL).
