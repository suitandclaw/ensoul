/**
 * Tendermint-style BFT consensus engine.
 *
 * Implements the core state machine from "The latest gossip on BFT consensus"
 * (Buchman, Kwon, Milosevic 2018). Key safety properties:
 *
 * 1. Safety: No two honest validators commit different blocks at the same height.
 *    Guaranteed by the LOCK mechanism: once a validator precommits for block B,
 *    it only prevotes B (or nil) in subsequent rounds until it sees a polka
 *    (2/3+ prevotes) for a different block.
 *
 * 2. Liveness: The chain makes progress if 2/3+ validators are online.
 *    Guaranteed by round timeouts that increase each round, ensuring
 *    eventual proposer overlap with network synchrony.
 *
 * 3. Accountability: Double-signing evidence is collected and stored.
 *    If a validator votes for two different blocks at the same (height, round, step),
 *    the conflicting votes are recorded as evidence for future slashing.
 *
 * State machine per height:
 *   For each round R:
 *     PROPOSE: proposer = roster[(H + R) % N]. Broadcast block or wait for it.
 *     PREVOTE: Vote for the proposed block if valid (respecting lock). Collect votes.
 *     PRECOMMIT: If 2/3+ prevotes for block B, precommit B and LOCK on B.
 *                If 2/3+ prevotes for nil, precommit nil.
 *     COMMIT: If 2/3+ precommits for block B, commit B and advance height.
 *
 * Lock rules (Algorithm 1 from the paper):
 *   - On precommitting B at round R: set lockedValue = B, lockedRound = R
 *   - On prevoting in round R' > R:
 *     * If lockedValue is set and the proposal matches lockedValue, prevote lockedValue
 *     * If lockedValue is set but proposal differs: prevote nil (unless polka unlock)
 *     * Polka unlock: if 2/3+ prevotes for B' != lockedValue in round R' > lockedRound,
 *       unlock (set lockedValue = null) and prevote B'
 */

import type { Block } from "@ensoul/ledger";
import { computeBlockHash } from "@ensoul/ledger";
import type { NodeBlockProducer } from "./producer.js";

// ── Types ────────────────────────────────────────────────────────────

export type ConsensusStep = "propose" | "prevote" | "precommit" | "commit";

/** A consensus vote/proposal message. */
export interface ConsensusMessage {
	type: ConsensusStep;
	height: number;
	round: number;
	blockHash: string;   // "nil" for nil votes
	from: string;        // validator DID
	block?: Block;       // included only on propose messages
}

/** Serialized form for network transport. */
export interface SerializedConsensusMessage {
	type: string;
	height: number;
	round: number;
	blockHash: string;
	from: string;
	block?: Record<string, unknown>;
}

/** Evidence of equivocation (double-signing at the same height+round+step). */
export interface EquivocationEvidence {
	validator: string;
	height: number;
	round: number;
	step: ConsensusStep;
	voteA: string; // blockHash of first vote
	voteB: string; // blockHash of conflicting vote
	timestamp: number;
}

// ── Consensus engine ────────────────────────────────────────────────

export class TendermintConsensus {
	private producer: NodeBlockProducer;
	private myDid: string;
	private roster: string[];
	private threshold: number;

	/** Epoch length: roster is updated every N blocks. */
	private static readonly EPOCH_LENGTH = 100;
	/** Maximum round before auto-reset to prevent timeout growth. */
	private static readonly MAX_ROUND = 50;
	/** Default stall threshold: 2 minutes without a commit. */
	private static readonly DEFAULT_STALL_MS = 120_000;
	private thresholdFraction: number;
	private stallThresholdMs: number;

	// ── State machine ────────────────────────────────────────────
	private height = 1;
	private round = 0;
	private step: ConsensusStep = "propose";
	private lastCommitTime = Date.now();
	private stallCheckTimer: ReturnType<typeof setInterval> | null = null;
	private rejoinCheckTimer: ReturnType<typeof setInterval> | null = null;

	// ── Lock state (critical for safety) ─────────────────────────
	// Per the Tendermint paper: a validator that precommits for block B
	// at round R is LOCKED on B. It can only prevote B (or nil) in
	// subsequent rounds, unless it sees 2/3+ prevotes for a different
	// block (polka unlock).
	private lockedValue: Block | null = null;
	private lockedRound = -1;

	// ── Valid value (last block with 2/3+ prevotes) ──────────────
	private validValue: Block | null = null;
	private validRound = -1;

	// ── Vote tracking ────────────────────────────────────────────
	// Maps: roundKey -> Map<validatorDID, blockHash>
	private prevotes: Map<string, Map<string, string>> = new Map();
	private precommits: Map<string, Map<string, string>> = new Map();
	private proposals: Map<string, Block> = new Map(); // roundKey -> Block

	// ── Evidence collection ──────────────────────────────────────
	private evidence: EquivocationEvidence[] = [];
	// Track all votes to detect equivocation: "H:R:step:validator" -> blockHash
	private voteRecord: Map<string, string> = new Map();

	// ── Timeouts ─────────────────────────────────────────────────
	private proposeTimeoutMs: number;
	private prevoteTimeoutMs: number;
	private precommitTimeoutMs: number;
	private roundTimeoutIncrement: number;
	private currentTimer: ReturnType<typeof setTimeout> | null = null;

	// ── Callbacks ────────────────────────────────────────────────
	onBroadcast: ((msg: ConsensusMessage) => void) | null = null;
	onCommit: ((block: Block) => void) | null = null;
	onLog: ((msg: string) => void) | null = null;

	// ── Dedup and control ────────────────────────────────────────
	private seenMessages: Set<string> = new Set();
	private running = false;

	constructor(
		producer: NodeBlockProducer,
		myDid: string,
		options?: {
			proposeTimeoutMs?: number;
			prevoteTimeoutMs?: number;
			precommitTimeoutMs?: number;
			roundTimeoutIncrement?: number;
			thresholdFraction?: number;
			stallThresholdMs?: number;
		},
	) {
		this.producer = producer;
		this.myDid = myDid;
		this.thresholdFraction = options?.thresholdFraction ?? (2 / 3);
		this.stallThresholdMs = options?.stallThresholdMs ?? TendermintConsensus.DEFAULT_STALL_MS;

		const consensusSet = producer.getState().getConsensusSet();
		if (consensusSet.length > 0) {
			// On-chain consensus set exists: use it
			this.roster = consensusSet;
			this.threshold = Math.floor(this.roster.length * this.thresholdFraction) + 1;
		} else {
			// Bootstrap mode: consensus set is empty, no CONSENSUS_JOIN committed yet.
			// Use self as the only roster member and threshold=1 so this validator
			// can self-commit blocks (including the CONSENSUS_JOIN transaction).
			// Once the consensus set has members, the roster switches to on-chain.
			this.roster = [myDid];
			this.threshold = 1;
		}

		this.proposeTimeoutMs = options?.proposeTimeoutMs ?? 10_000;
		this.prevoteTimeoutMs = options?.prevoteTimeoutMs ?? 10_000;
		this.precommitTimeoutMs = options?.precommitTimeoutMs ?? 10_000;
		this.roundTimeoutIncrement = options?.roundTimeoutIncrement ?? 2_000;
	}

	// ── Public API ───────────────────────────────────────────────

	/** Start consensus at the given height. */
	start(startHeight?: number): void {
		if (this.roster.length === 0) {
			this.log("Cannot start consensus: empty validator roster");
			return;
		}
		this.height = startHeight ?? this.producer.getHeight() + 1;
		this.running = true;
		this.lastCommitTime = Date.now();
		this.log(`Consensus started at height ${this.height}, threshold=${this.threshold}/${this.roster.length}`);

		// Stall detection: check every 30 seconds
		this.stallCheckTimer = setInterval(() => this.checkStall(), 30_000);

		// Auto-rejoin: check every 60 seconds if we fell out of the consensus set
		this.rejoinCheckTimer = setInterval(() => this.checkRejoin(), 60_000);

		this.startRound(this.height, 0);
	}

	/** Stop consensus. */
	stop(): void {
		this.running = false;
		this.clearTimer();
		if (this.stallCheckTimer) {
			clearInterval(this.stallCheckTimer);
			this.stallCheckTimer = null;
		}
		if (this.rejoinCheckTimer) {
			clearInterval(this.rejoinCheckTimer);
			this.rejoinCheckTimer = null;
		}
	}

	/** Current state for debugging and the /peer/consensus-state endpoint. */
	getState(): {
		height: number; round: number; step: ConsensusStep; running: boolean;
		lockedRound: number; validRound: number; prevoteCount: number;
		precommitCount: number; consensusSetSize: number; lastCommitTime: number;
		stallDetected: boolean; proposerDid: string; rosterSize: number;
	} {
		const rk = String(this.round);
		return {
			height: this.height,
			round: this.round,
			step: this.step,
			running: this.running,
			lockedRound: this.lockedRound,
			validRound: this.validRound,
			prevoteCount: this.prevotes.get(rk)?.size ?? 0,
			precommitCount: this.precommits.get(rk)?.size ?? 0,
			consensusSetSize: this.producer.getState().getConsensusSet().length,
			lastCommitTime: this.lastCommitTime,
			stallDetected: Date.now() - this.lastCommitTime > this.stallThresholdMs,
			proposerDid: this.selectProposer(this.height, this.round),
			rosterSize: this.roster.length,
		};
	}

	/** Quorum threshold. */
	getThreshold(): number {
		return this.threshold;
	}

	/** Collected equivocation evidence. */
	getEvidence(): EquivocationEvidence[] {
		return [...this.evidence];
	}

	/**
	 * Handle an incoming consensus message.
	 * Returns true if the message was new, valid, and processed.
	 */
	handleMessage(msg: ConsensusMessage): boolean {
		if (!this.running) return false;

		// Dedup by (height, round, type, from)
		const dedupKey = `${msg.height}:${msg.round}:${msg.type}:${msg.from}`;
		if (this.seenMessages.has(dedupKey)) return false;
		this.seenMessages.add(dedupKey);
		this.pruneSeenMessages();

		// Reject messages for old or far-future heights
		if (msg.height < this.height) return false;
		if (msg.height > this.height + 1) return false;

		// Validate sender is in the roster
		if (!this.roster.includes(msg.from)) return false;

		// Check for equivocation (double-signing)
		this.checkEquivocation(msg);

		switch (msg.type) {
			case "propose": return this.onPropose(msg);
			case "prevote": return this.onPrevote(msg);
			case "precommit": return this.onPrecommit(msg);
			default: return false;
		}
	}

	/** Called when chain advances externally (e.g., block sync). */
	onBlockSynced(height: number): void {
		if (height >= this.height) {
			this.height = height + 1;
			this.resetLockState();
			this.startRound(this.height, 0);
		}
	}

	/** Select proposer for height H, round R. */
	selectProposer(height: number, round: number): string {
		const idx = (height + round) % this.roster.length;
		return this.roster[idx] ?? this.roster[0]!;
	}

	// ── Round management ────────────────────────────────────────

	private startRound(height: number, round: number): void {
		if (!this.running) return;

		this.height = height;
		this.round = round;
		this.step = "propose";

		// Clear vote maps on new height (but preserve lock across rounds)
		if (round === 0) {
			this.prevotes.clear();
			this.precommits.clear();
			this.proposals.clear();
			// Lock state persists across heights only if explicitly kept
			// (it resets on new height per the spec)
			this.resetLockState();
		}

		const proposer = this.selectProposer(height, round);
		this.log(`H=${height} R=${round} proposer=${this.shortDid(proposer)}`);

		if (proposer === this.myDid) {
			this.doPropose(height, round);
		} else {
			// Wait for proposal
			this.startTimer(this.getTimeout("propose"), () => {
				this.log(`H=${height} R=${round}: propose timeout, prevoting nil`);
				this.doPrevote(height, round, "nil");
			});
		}
	}

	private advanceRound(): void {
		this.clearTimer();
		const nextRound = this.round + 1;

		// Round cap: prevent unbounded timeout growth
		if (nextRound > TendermintConsensus.MAX_ROUND) {
			this.log(`Round cap reached (${TendermintConsensus.MAX_ROUND}). Resetting to round 0.`);
			this.resetForStallRecovery();
			return;
		}

		this.log(`Advancing to round ${nextRound}`);
		this.startRound(this.height, nextRound);
	}

	// ── Propose ─────────────────────────────────────────────────

	private doPropose(height: number, round: number): void {
		// Per the paper: if we have a validValue from a previous round, re-propose it
		let block: Block | null = this.validValue;

		if (!block) {
			// Produce a candidate block. The block is NOT applied to state yet.
			// It will only be applied when committed via applyBlock after 2/3+ precommits.
			block = this.producer.produceBlock(this.myDid, true);
		}

		if (block) {
			const hash = computeBlockHash(block);
			this.proposals.set(String(round), block);
			this.broadcast({
				type: "propose",
				height,
				round,
				blockHash: hash,
				from: this.myDid,
				block,
			});
			this.doPrevote(height, round, hash);
		} else {
			this.doPrevote(height, round, "nil");
		}
	}

	// ── Prevote (with lock rules) ───────────────────────────────

	/**
	 * Cast a prevote, respecting the lock mechanism.
	 *
	 * Lock rules from the paper (Algorithm 1, line 22-28):
	 * - If locked on a value and the proposal matches: prevote it
	 * - If locked on a value and the proposal differs: prevote nil
	 *   (unless polka unlock has occurred)
	 * - If not locked: prevote the proposal
	 */
	private doPrevote(height: number, round: number, proposedHash: string): void {
		this.step = "prevote";
		let voteHash = proposedHash;

		if (this.lockedValue !== null && proposedHash !== "nil") {
			const lockedHash = computeBlockHash(this.lockedValue);
			if (proposedHash !== lockedHash) {
				const polkaRound = this.findPolkaRound(proposedHash);
				if (polkaRound !== null && polkaRound > this.lockedRound) {
					this.log(`Polka unlock: saw 2/3+ prevotes for ${proposedHash.slice(0, 12)} in R=${polkaRound}, unlocking from R=${this.lockedRound}`);
					this.lockedValue = null;
					this.lockedRound = -1;
					voteHash = proposedHash;
				} else {
					voteHash = "nil";
				}
			}
		}

		// Record own vote directly (don't go through handleMessage to avoid recursion)
		const rk = String(round);
		if (!this.prevotes.has(rk)) this.prevotes.set(rk, new Map());
		this.prevotes.get(rk)!.set(this.myDid, voteHash);
		this.recordVote({ type: "prevote", height, round, blockHash: voteHash, from: this.myDid });

		// Broadcast to peers
		this.broadcast({ type: "prevote", height, round, blockHash: voteHash, from: this.myDid });

		// Check if own vote creates a quorum
		this.checkPrevoteQuorum(rk, height, round);

		this.startTimer(this.getTimeout("prevote"), () => {
			this.log(`H=${height} R=${round}: prevote timeout`);
			this.advanceRound();
		});
	}

	/** Check if prevotes for a round have reached quorum. */
	private checkPrevoteQuorum(rk: string, height: number, round: number): void {
		const votes = this.prevotes.get(rk);
		if (!votes) return;
		const counts = this.countVotes(votes);
		for (const [hash, count] of counts) {
			if (count >= this.threshold) {
				if (hash === "nil") {
					this.log(`H=${height} R=${round}: 2/3+ nil prevotes`);
					this.advanceRound();
					return;
				}
				const block = this.findProposalByHash(hash);
				if (block) {
					this.validValue = block;
					this.validRound = round;
				}
				if (this.step === "prevote") {
					this.clearTimer();
					this.doPrecommit(height, round, hash);
				}
				return;
			}
		}
	}

	// ── Precommit (sets lock) ───────────────────────────────────

	private doPrecommit(height: number, round: number, blockHash: string): void {
		this.step = "precommit";

		// LOCK MECHANISM: precommitting for a non-nil block sets the lock
		if (blockHash !== "nil") {
			const block = this.findProposalByHash(blockHash);
			if (block) {
				this.lockedValue = block;
				this.lockedRound = round;
				this.validValue = block;
				this.validRound = round;
				this.log(`LOCKED on block ${blockHash.slice(0, 12)} at R=${round}`);
			}
		}

		// Record own vote directly
		const rk = String(round);
		if (!this.precommits.has(rk)) this.precommits.set(rk, new Map());
		this.precommits.get(rk)!.set(this.myDid, blockHash);
		this.recordVote({ type: "precommit", height, round, blockHash, from: this.myDid });

		// Broadcast to peers
		this.broadcast({ type: "precommit", height, round, blockHash, from: this.myDid });

		// Check if own vote creates a quorum
		this.checkPrecommitQuorum(rk, height, round);

		this.startTimer(this.getTimeout("precommit"), () => {
			this.log(`H=${height} R=${round}: precommit timeout`);
			this.advanceRound();
		});
	}

	/** Check if precommits for a round have reached quorum. */
	private checkPrecommitQuorum(rk: string, height: number, round: number): void {
		const votes = this.precommits.get(rk);
		if (!votes) return;
		const counts = this.countVotes(votes);
		for (const [hash, count] of counts) {
			if (count >= this.threshold) {
				if (hash === "nil") {
					this.log(`H=${height} R=${round}: 2/3+ nil precommits`);
					this.advanceRound();
					return;
				}
				this.commitBlock(hash);
				return;
			}
		}
	}

	// ── Message handlers ────────────────────────────────────────

	private onPropose(msg: ConsensusMessage): boolean {
		if (msg.height !== this.height || msg.round < this.round) return false;
		if (msg.round > this.round) return true; // store for future round

		// Verify correct proposer
		const expected = this.selectProposer(msg.height, msg.round);
		if (msg.from !== expected) {
			this.log(`Rejected proposal from ${this.shortDid(msg.from)}, expected ${this.shortDid(expected)}`);
			return false;
		}

		if (!msg.block) return false;

		// Verify block hash
		const hash = computeBlockHash(msg.block);
		if (hash !== msg.blockHash) return false;

		// Store proposal
		this.proposals.set(String(msg.round), msg.block);

		// Cancel propose timeout and prevote
		if (this.step === "propose") {
			this.clearTimer();
			this.doPrevote(msg.height, msg.round, hash);
		}

		return true;
	}

	private onPrevote(msg: ConsensusMessage): boolean {
		if (msg.height !== this.height || msg.round !== this.round) return false;

		const rk = String(msg.round);
		if (!this.prevotes.has(rk)) this.prevotes.set(rk, new Map());
		this.prevotes.get(rk)!.set(msg.from, msg.blockHash);

		this.checkPrevoteQuorum(rk, msg.height, msg.round);
		return true;
	}

	private onPrecommit(msg: ConsensusMessage): boolean {
		if (msg.height !== this.height || msg.round !== this.round) return false;

		const rk = String(msg.round);
		if (!this.precommits.has(rk)) this.precommits.set(rk, new Map());
		this.precommits.get(rk)!.set(msg.from, msg.blockHash);

		this.checkPrecommitQuorum(rk, msg.height, msg.round);
		return true;
	}

	// ── Commit ──────────────────────────────────────────────────

	private commitBlock(blockHash: string): void {
		this.clearTimer();
		this.step = "commit";

		const block = this.findProposalByHash(blockHash);
		if (!block) {
			this.log(`Cannot commit: block ${blockHash.slice(0, 16)} not found`);
			this.advanceRound();
			return;
		}

		// Apply block to state (skip if already applied by the proposer)
		const currentHeight = this.producer.getHeight();
		if (block.height <= currentHeight) {
			// Block already applied (we were the proposer)
		} else {
			const result = this.producer.applyBlock(block, true);
			if (!result.valid) {
				this.log(`Cannot commit: validation failed: ${result.error}`);
				this.advanceRound();
				return;
			}
		}

		this.lastCommitTime = Date.now();
		this.log(`COMMITTED H=${block.height} hash=${blockHash.slice(0, 16)} proposer=${this.shortDid(block.proposer)}`);

		if (this.onCommit) {
			this.onCommit(block);
		}

		// Update roster if this block contains consensus_join/leave transactions
		// or at epoch boundaries
		const hasConsensusChange = block.transactions.some(
			(tx) => tx.type === "consensus_join" || tx.type === "consensus_leave",
		);
		if (hasConsensusChange || (block.height > 0 && block.height % TendermintConsensus.EPOCH_LENGTH === 0)) {
			this.updateRoster();
		}

		// Advance to next height. Enforce minimum 6-second block time to
		// prevent runaway block production when self-committing.
		this.height = block.height + 1;
		const elapsed = Date.now() - this.lastCommitTime;
		const minDelay = Math.max(0, 6000 - elapsed);
		setTimeout(() => this.startRound(this.height, 0), minDelay);
	}

	/**
	 * Update the validator roster from the on-chain consensus set.
	 * Called at epoch boundaries (every 100 blocks) and on consensus_join/leave.
	 * Falls back to genesis roster if the consensus set is empty (bootstrap).
	 */
	private updateRoster(): void {
		const consensusSet = this.producer.getState().getConsensusSet();
		const epoch = Math.floor(this.height / TendermintConsensus.EPOCH_LENGTH);

		if (consensusSet.length > 0) {
			// On-chain consensus set exists: use it
			if (consensusSet.length !== this.roster.length) {
				this.log(`Epoch ${epoch}: roster updated ${this.roster.length} -> ${consensusSet.length} (on-chain consensus set)`);
			}
			this.roster = consensusSet;
			this.threshold = Math.floor(this.roster.length * this.thresholdFraction) + 1;
		} else {
			// Bootstrap: self-only roster until CONSENSUS_JOIN commits
			if (this.roster.length !== 1 || this.roster[0] !== this.myDid) {
				this.log(`Epoch ${epoch}: bootstrap mode, self-only roster (threshold=1)`);
				this.roster = [this.myDid];
				this.threshold = 1;
			}
		}
	}

	// ── Equivocation detection ──────────────────────────────────

	/**
	 * Check if a message constitutes double-signing.
	 * A validator is equivocating if it sends two different votes
	 * for the same (height, round, step).
	 */
	private checkEquivocation(msg: ConsensusMessage): void {
		if (msg.type === "propose") return; // proposals are not votes

		const key = `${msg.height}:${msg.round}:${msg.type}:${msg.from}`;
		const existing = this.voteRecord.get(key);

		if (existing !== undefined && existing !== msg.blockHash) {
			// EQUIVOCATION DETECTED
			const ev: EquivocationEvidence = {
				validator: msg.from,
				height: msg.height,
				round: msg.round,
				step: msg.type,
				voteA: existing,
				voteB: msg.blockHash,
				timestamp: Date.now(),
			};
			this.evidence.push(ev);
			this.log(`EQUIVOCATION: ${this.shortDid(msg.from)} double-signed at H=${msg.height} R=${msg.round} step=${msg.type}: ${existing.slice(0, 12)} vs ${msg.blockHash.slice(0, 12)}`);
		}

		if (existing === undefined) {
			this.voteRecord.set(key, msg.blockHash);
		}
	}

	private recordVote(msg: ConsensusMessage): void {
		const key = `${msg.height}:${msg.round}:${msg.type}:${msg.from}`;
		this.voteRecord.set(key, msg.blockHash);
	}

	// ── Lock helpers ────────────────────────────────────────────

	/**
	 * Find the highest round where 2/3+ prevotes exist for a given hash.
	 * Returns null if no such polka exists.
	 */
	private findPolkaRound(blockHash: string): number | null {
		let highest: number | null = null;
		for (const [roundStr, votes] of this.prevotes) {
			const round = Number(roundStr);
			const counts = this.countVotes(votes);
			const count = counts.get(blockHash) ?? 0;
			if (count >= this.threshold) {
				if (highest === null || round > highest) {
					highest = round;
				}
			}
		}
		return highest;
	}

	private resetLockState(): void {
		this.lockedValue = null;
		this.lockedRound = -1;
		this.validValue = null;
		this.validRound = -1;
		this.voteRecord.clear();
	}

	// ── Stall detection and recovery ─────────────────────────────

	/**
	 * Check for consensus stall. Called every 30 seconds.
	 * If no block committed within stallThresholdMs, reset to round 0.
	 */
	private checkStall(): void {
		if (!this.running) return;
		const elapsed = Date.now() - this.lastCommitTime;
		if (elapsed > this.stallThresholdMs) {
			this.log(`Consensus stall detected at height ${this.height}, round ${this.round}. No commit for ${Math.round(elapsed / 1000)}s. Resetting.`);
			this.resetForStallRecovery();
		}
	}

	/**
	 * Reset consensus state for stall recovery.
	 * Clears votes, locks, dedup, and restarts from round 0.
	 * Safe because no block was committed at this height.
	 */
	private resetForStallRecovery(): void {
		this.clearTimer();
		this.prevotes.clear();
		this.precommits.clear();
		this.proposals.clear();
		this.lockedValue = null;
		this.lockedRound = -1;
		this.validValue = null;
		this.validRound = -1;
		this.voteRecord.clear();
		// Clear dedup entries for current height so fresh votes are accepted
		const prefix = `${this.height}:`;
		for (const key of this.seenMessages) {
			if (key.startsWith(prefix)) this.seenMessages.delete(key);
		}
		// Also refresh the roster in case it changed
		this.updateRoster();
		this.log(`Recovery: reset to H=${this.height} R=0, roster=${this.roster.length}`);
		this.startRound(this.height, 0);
	}

	/**
	 * Check if this validator fell out of the consensus set and should rejoin.
	 * Called every 60 seconds.
	 */
	private checkRejoin(): void {
		if (!this.running) return;
		const consensusSet = this.producer.getState().getConsensusSet();
		if (consensusSet.length > 0 && !consensusSet.includes(this.myDid)) {
			// We have an on-chain consensus set but we're not in it
			const account = this.producer.getState().getAccount(this.myDid);
			if (account.stakedBalance > 0n) {
				this.log("Not in consensus set. Auto-rejoining...");
				try {
					this.producer.submitTransaction({
						type: "consensus_join",
						from: this.myDid,
						to: this.myDid,
						amount: 0n,
						nonce: account.nonce,
						timestamp: Date.now(),
						signature: new Uint8Array(64),
					});
					this.log("CONSENSUS_JOIN submitted for auto-rejoin");
				} catch {
					// Already in mempool or other error
				}
			}
		}
	}

	// ── Helpers ─────────────────────────────────────────────────

	private findProposalByHash(hash: string): Block | null {
		for (const [, block] of this.proposals) {
			if (computeBlockHash(block) === hash) return block;
		}
		return null;
	}

	private countVotes(votes: Map<string, string>): Map<string, number> {
		const counts = new Map<string, number>();
		for (const [, hash] of votes) {
			counts.set(hash, (counts.get(hash) ?? 0) + 1);
		}
		return counts;
	}

	private getTimeout(step: ConsensusStep): number {
		const base = step === "propose"
			? this.proposeTimeoutMs
			: step === "prevote"
				? this.prevoteTimeoutMs
				: this.precommitTimeoutMs;
		return base + this.round * this.roundTimeoutIncrement;
	}

	private broadcast(msg: ConsensusMessage): void {
		if (this.onBroadcast) this.onBroadcast(msg);
	}

	private startTimer(ms: number, fn: () => void): void {
		this.clearTimer();
		this.currentTimer = setTimeout(fn, ms);
	}

	private clearTimer(): void {
		if (this.currentTimer) {
			clearTimeout(this.currentTimer);
			this.currentTimer = null;
		}
	}

	private pruneSeenMessages(): void {
		if (this.seenMessages.size > 10000) {
			const arr = [...this.seenMessages];
			this.seenMessages = new Set(arr.slice(-5000));
		}
	}

	private shortDid(did: string): string {
		return did.length > 30 ? `${did.slice(0, 16)}...${did.slice(-6)}` : did;
	}

	private log(msg: string): void {
		if (this.onLog) this.onLog(msg);
	}
}
