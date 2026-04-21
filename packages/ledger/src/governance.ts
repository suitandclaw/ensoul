// Multisig governance state for Ensoul.
// Phase 1: additive, dormant until signers registered via Phase 2.
// See docs/multisig-governance-design.md for full design.
//
// State structure:
//   signers: Set<DID> of authorized governance signers
//   threshold: minimum signatures required (e.g., 3 of 5)
//   operatorKey: DID of single-sig key for fast ops
//   proposals: Map<proposalId, GovernanceProposal>
//   usedNonces: Map<signerDid, Set<nonce>> for replay protection
//
// Migration path:
//   Phase 1 (this code): state exists, tx types work, but no signers
//     registered so all governance txs fail validation.
//   Phase 2: governance_install registers 5 signers. Proposals can
//     now be created and signed.
//   Phase 3: sensitive ops (software_upgrade, force_remove, etc.)
//     require governance_execute instead of raw PIONEER_KEY.

// Deterministic JSON: sorted keys at all depths. Matches JCS (RFC 8785)
// for the subset we use (no special number handling needed since
// governance payloads contain only strings, integers, and arrays).
function canonicalJSON(obj: unknown): string {
  if (obj === null || obj === undefined) return "null";
  if (typeof obj === "string") return JSON.stringify(obj);
  if (typeof obj === "number" || typeof obj === "boolean") return String(obj);
  if (Array.isArray(obj)) return "[" + obj.map(canonicalJSON).join(",") + "]";
  if (typeof obj === "object") {
    const keys = Object.keys(obj as Record<string, unknown>).sort();
    const pairs = keys.map(k => JSON.stringify(k) + ":" + canonicalJSON((obj as Record<string, unknown>)[k]));
    return "{" + pairs.join(",") + "}";
  }
  return String(obj);
}

export type GovernancePayloadType =
  | "set_signers"
  | "operator_key_rotate"
  | "treasury_transfer"
  | "software_upgrade"
  | "consensus_force_remove"
  | "pioneer_revoke"
  | "governance_lock_bypass_undelegate";

export interface GovernancePayload {
  type: GovernancePayloadType;
  [key: string]: unknown;
}

export interface GovernanceProposal {
  id: string;
  proposer: string;
  payload: GovernancePayload;
  signatures: Map<string, string>;
  status: "pending" | "executed" | "expired" | "cancelled";
  createdAt: number;
  expiresAt: number;
  executedAt?: number;
  executedBy?: string;
  nonce: string;
}

const DEFAULT_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const MAX_EXPIRY_MS = 90 * 24 * 60 * 60 * 1000; // 90 days

export class GovernanceState {
  private signers = new Set<string>();
  private threshold = 0;
  private operatorKey = "";
  private proposals = new Map<string, GovernanceProposal>();
  private usedNonces = new Map<string, Set<string>>();

  // ---- Signer management ----

  getSigners(): string[] {
    return [...this.signers].sort();
  }

  getThreshold(): number {
    return this.threshold;
  }

  getOperatorKey(): string {
    return this.operatorKey;
  }

  isSigner(did: string): boolean {
    return this.signers.has(did);
  }

  isActive(): boolean {
    return this.signers.size > 0 && this.threshold > 0;
  }

  setSigners(newSigners: string[], newThreshold: number): void {
    if (newSigners.length === 0) throw new Error("signer set cannot be empty");
    if (newThreshold < 1) throw new Error("threshold must be >= 1");
    if (newThreshold > newSigners.length) throw new Error("threshold cannot exceed signer count");
    this.signers = new Set(newSigners);
    this.threshold = newThreshold;
  }

  setOperatorKey(key: string): void {
    this.operatorKey = key;
  }

  // ---- Proposal lifecycle ----

  computeProposalId(proposer: string, payload: GovernancePayload, nonce: string): string {
    const canonical = canonicalJSON(payload);
    const data = new TextEncoder().encode(proposer + canonical + nonce);
    // Simple hash: use a deterministic string hash since we don't
    // want to pull in a crypto dep here. The ABCI layer will use
    // sha256 for the real ID; this is a reference implementation.
    let hash = 0n;
    for (const byte of data) {
      hash = (hash * 31n + BigInt(byte)) & 0xFFFFFFFFFFFFFFFFn;
    }
    return hash.toString(16).padStart(16, "0");
  }

  createProposal(
    proposer: string,
    payload: GovernancePayload,
    nonce: string,
    nowMs: number,
    expiresAt?: number,
  ): GovernanceProposal {
    if (!this.isSigner(proposer)) {
      throw new Error("proposer is not a registered signer");
    }

    // Nonce uniqueness
    let signerNonces = this.usedNonces.get(proposer);
    if (!signerNonces) {
      signerNonces = new Set();
      this.usedNonces.set(proposer, signerNonces);
    }
    if (signerNonces.has(nonce)) {
      throw new Error("nonce already used by this proposer");
    }

    // Expiry validation
    const expiry = expiresAt ?? (nowMs + DEFAULT_EXPIRY_MS);
    if (expiry <= nowMs) throw new Error("expiresAt must be in the future");
    if (expiry - nowMs > MAX_EXPIRY_MS) throw new Error("expiresAt exceeds maximum 90-day window");

    const id = this.computeProposalId(proposer, payload, nonce);
    if (this.proposals.has(id)) {
      throw new Error("proposal with this id already exists");
    }

    const proposal: GovernanceProposal = {
      id,
      proposer,
      payload,
      signatures: new Map(),
      status: "pending",
      createdAt: nowMs,
      expiresAt: expiry,
      nonce,
    };

    signerNonces.add(nonce);
    this.proposals.set(id, proposal);
    return proposal;
  }

  addSignature(proposalId: string, signerDid: string, signature: string, nowMs: number): void {
    const proposal = this.proposals.get(proposalId);
    if (!proposal) throw new Error("proposal not found");
    if (proposal.status !== "pending") throw new Error("proposal is not pending");
    if (proposal.expiresAt <= nowMs) {
      proposal.status = "expired";
      throw new Error("proposal has expired");
    }
    if (!this.isSigner(signerDid)) throw new Error("signer is not in the governance set");
    if (proposal.signatures.has(signerDid)) throw new Error("signer has already signed this proposal");

    proposal.signatures.set(signerDid, signature);
  }

  canExecute(proposalId: string, nowMs: number): { ok: boolean; reason?: string } {
    const proposal = this.proposals.get(proposalId);
    if (!proposal) return { ok: false, reason: "proposal not found" };
    if (proposal.status !== "pending") return { ok: false, reason: "proposal is not pending" };
    if (proposal.expiresAt <= nowMs) {
      proposal.status = "expired";
      return { ok: false, reason: "proposal has expired" };
    }
    if (proposal.signatures.size < this.threshold) {
      return { ok: false, reason: `insufficient signatures (${proposal.signatures.size}/${this.threshold})` };
    }
    return { ok: true };
  }

  markExecuted(proposalId: string, executedBy: string, nowMs: number): void {
    const proposal = this.proposals.get(proposalId);
    if (!proposal) throw new Error("proposal not found");
    if (proposal.status !== "pending") throw new Error("proposal is not pending");
    proposal.status = "executed";
    proposal.executedAt = nowMs;
    proposal.executedBy = executedBy;
  }

  markCancelled(proposalId: string, cancelledBy: string): void {
    const proposal = this.proposals.get(proposalId);
    if (!proposal) throw new Error("proposal not found");
    if (proposal.status !== "pending") throw new Error("proposal is not pending");
    if (proposal.proposer !== cancelledBy) throw new Error("only the proposer can cancel");
    proposal.status = "cancelled";
  }

  expireStale(nowMs: number): number {
    let count = 0;
    for (const proposal of this.proposals.values()) {
      if (proposal.status === "pending" && proposal.expiresAt <= nowMs) {
        proposal.status = "expired";
        count++;
      }
    }
    return count;
  }

  getProposal(id: string): GovernanceProposal | undefined {
    return this.proposals.get(id);
  }

  listProposals(status?: string): GovernanceProposal[] {
    const all = [...this.proposals.values()];
    if (status) return all.filter(p => p.status === status);
    return all;
  }

  // ---- Serialization (for snapshots) ----

  serialize(): Record<string, unknown> {
    const proposals: Array<Record<string, unknown>> = [];
    for (const p of this.proposals.values()) {
      proposals.push({
        id: p.id,
        proposer: p.proposer,
        payload: p.payload,
        signatures: Object.fromEntries(p.signatures),
        status: p.status,
        createdAt: p.createdAt,
        expiresAt: p.expiresAt,
        executedAt: p.executedAt,
        executedBy: p.executedBy,
        nonce: p.nonce,
      });
    }

    const usedNonces: Record<string, string[]> = {};
    for (const [signer, nonces] of this.usedNonces) {
      usedNonces[signer] = [...nonces];
    }

    return {
      signers: [...this.signers],
      threshold: this.threshold,
      operatorKey: this.operatorKey,
      proposals,
      usedNonces,
    };
  }

  static deserialize(data: Record<string, unknown>): GovernanceState {
    const gs = new GovernanceState();
    const signers = (data["signers"] as string[]) ?? [];
    gs.signers = new Set(signers);
    gs.threshold = (data["threshold"] as number) ?? 0;
    gs.operatorKey = (data["operatorKey"] as string) ?? "";

    const proposals = (data["proposals"] as Array<Record<string, unknown>>) ?? [];
    for (const p of proposals) {
      const sigs = new Map<string, string>();
      const rawSigs = (p["signatures"] as Record<string, string>) ?? {};
      for (const [k, v] of Object.entries(rawSigs)) {
        sigs.set(k, v);
      }
      const proposal: GovernanceProposal = {
        id: p["id"] as string,
        proposer: p["proposer"] as string,
        payload: p["payload"] as GovernancePayload,
        signatures: sigs,
        status: p["status"] as GovernanceProposal["status"],
        createdAt: p["createdAt"] as number,
        expiresAt: p["expiresAt"] as number,
        nonce: p["nonce"] as string,
      };
      if (p["executedAt"] !== undefined) proposal.executedAt = p["executedAt"] as number;
      if (p["executedBy"] !== undefined) proposal.executedBy = p["executedBy"] as string;
      gs.proposals.set(proposal.id, proposal);
    }

    const usedNonces = (data["usedNonces"] as Record<string, string[]>) ?? {};
    for (const [signer, nonces] of Object.entries(usedNonces)) {
      gs.usedNonces.set(signer, new Set(nonces));
    }

    return gs;
  }
}
