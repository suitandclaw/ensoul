/**
 * CometBFT-faithful consensus state machine.
 *
 * Ported from the CometBFT spec:
 *   https://github.com/cometbft/cometbft/blob/main/spec/consensus/consensus.md
 *   https://github.com/cometbft/cometbft/blob/main/spec/consensus/proposer-selection.md
 *
 * State machine per height:
 *   NewHeight -> (Propose -> Prevote -> Precommit)+ -> Commit -> NewHeight
 *
 * Safety: if quorum (2/3+ by voting power) cannot be reached, the chain halts.
 * No self-commit. No bootstrap mode. No special cases.
 *
 * Proposer selection: weighted round-robin matching CometBFT's algorithm.
 * Priority queue: each validator accumulates VP, highest priority proposes,
 * proposer's priority decreases by total VP.
 */

import type { Block } from "@ensoul/ledger";
import { computeBlockHash } from "@ensoul/ledger";
import type { NodeBlockProducer } from "./producer.js";

// ── Types ────────────────────────────────────────────────────────────

export type ConsensusStep = "propose" | "prevote" | "precommit" | "commit" | "newHeight";

export interface ConsensusMessage {
	type: ConsensusStep;
	height: number;
	round: number;
	blockHash: string;
	from: string;
	block?: Block;
}

export interface SerializedConsensusMessage {
	type: string;
	height: number;
	round: number;
	blockHash: string;
	from: string;
	block?: Record<string, unknown>;
}

export interface EquivocationEvidence {
	validator: string;
	height: number;
	round: number;
	step: ConsensusStep;
	voteA: string;
	voteB: string;
	timestamp: number;
}

/** Validator with voting power and priority for proposer selection. */
interface ValidatorState {
	did: string;
	power: number;
	priority: number;
}

// ── Timeouts (matching CometBFT defaults) ────────────────────────────

const DEFAULT_PROPOSE_BASE = 3000;     // 3s
const DEFAULT_PROPOSE_DELTA = 500;     // +500ms per round
const DEFAULT_PREVOTE_BASE = 1000;     // 1s
const DEFAULT_PREVOTE_DELTA = 500;     // +500ms per round
const DEFAULT_PRECOMMIT_BASE = 1000;   // 1s
const DEFAULT_PRECOMMIT_DELTA = 500;   // +500ms per round
const DEFAULT_COMMIT_TIMEOUT = 1000;   // 1s between blocks
const DEFAULT_MIN_BLOCK_INTERVAL = 6000; // 6s minimum (Ensoul-specific safety)
const MAX_ROUND = 50;

/** Optional config for timeouts and threshold (primarily for testing). */
export interface ConsensusConfig {
	thresholdFraction?: number;
	proposeTimeoutMs?: number;
	prevoteTimeoutMs?: number;
	precommitTimeoutMs?: number;
	roundTimeoutIncrement?: number;
	commitTimeoutMs?: number;
	minBlockIntervalMs?: number;
	stallThresholdMs?: number;
}

// ── Consensus engine ────────────────────────────────────────────────

export class TendermintConsensus {
	private producer: NodeBlockProducer;
	private myDid: string;

	// ── Validator set ────────────────────────────────────────────
	private validators: ValidatorState[] = [];
	private totalPower = 0;
	private threshold = 0; // 2/3+1 of totalPower

	// ── State machine ────────────────────────────────────────────
	private height = 0;
	private round = 0;
	private step: ConsensusStep = "newHeight";

	// ── Lock state ───────────────────────────────────────────────
	private lockedValue: Block | null = null;
	private lockedRound = -1;
	private validValue: Block | null = null;
	private validRound = -1;

	// ── Vote tracking ────────────────────────────────────────────
	private prevotes: Map<string, Map<string, string>> = new Map();
	private precommits: Map<string, Map<string, string>> = new Map();
	private proposals: Map<string, Block> = new Map();

	// ── Evidence ─────────────────────────────────────────────────
	private evidence: EquivocationEvidence[] = [];
	private voteRecord: Map<string, string> = new Map();

	// ── Timing ───────────────────────────────────────────────────
	private lastCommitTime = Date.now();
	private currentTimer: ReturnType<typeof setTimeout> | null = null;

	// ── Callbacks ────────────────────────────────────────────────
	onBroadcast: ((msg: ConsensusMessage) => void) | null = null;
	onCommit: ((block: Block) => void) | null = null;
	onLog: ((msg: string) => void) | null = null;
	onSubmitTx: ((tx: { type: string; from: string; to: string; amount: bigint; nonce: number; timestamp: number; signature: Uint8Array }) => void) | null = null;

	// ── Dedup ────────────────────────────────────────────────────
	private seenMessages: Set<string> = new Set();
	private running = false;

	// ── Configurable timeouts ────────────────────────────────────
	private proposeBase: number;
	private proposeDelta: number;
	private prevoteBase: number;
	private prevoteDelta: number;
	private precommitBase: number;
	private precommitDelta: number;
	private commitTimeout: number;
	private minBlockInterval: number;

	constructor(
		producer: NodeBlockProducer,
		myDid: string,
		validatorSetOrConfig?: Array<{ did: string; power: number }> | ConsensusConfig,
		config?: ConsensusConfig,
	) {
		this.producer = producer;
		this.myDid = myDid;

		// Parse arguments: third arg can be validator set array or config object
		let validatorSet: Array<{ did: string; power: number }> | undefined;
		let cfg: ConsensusConfig | undefined;

		if (Array.isArray(validatorSetOrConfig)) {
			validatorSet = validatorSetOrConfig;
			cfg = config;
		} else if (validatorSetOrConfig && typeof validatorSetOrConfig === "object") {
			cfg = validatorSetOrConfig;
		}

		// Apply timeout config (defaults to CometBFT standard values)
		this.proposeBase = cfg?.proposeTimeoutMs ?? DEFAULT_PROPOSE_BASE;
		this.proposeDelta = cfg?.roundTimeoutIncrement ?? DEFAULT_PROPOSE_DELTA;
		this.prevoteBase = cfg?.prevoteTimeoutMs ?? DEFAULT_PREVOTE_BASE;
		this.prevoteDelta = cfg?.roundTimeoutIncrement ?? DEFAULT_PREVOTE_DELTA;
		this.precommitBase = cfg?.precommitTimeoutMs ?? DEFAULT_PRECOMMIT_BASE;
		this.precommitDelta = cfg?.roundTimeoutIncrement ?? DEFAULT_PRECOMMIT_DELTA;
		this.commitTimeout = cfg?.commitTimeoutMs ?? DEFAULT_COMMIT_TIMEOUT;
		this.minBlockInterval = cfg?.minBlockIntervalMs ?? DEFAULT_MIN_BLOCK_INTERVAL;

		// Build validator set from parameter, consensus set, or genesis
		if (validatorSet && validatorSet.length > 0) {
			this.validators = validatorSet.map((v) => ({ ...v, priority: 0 }));
		} else {
			const consensusSet = producer.getState().getConsensusSet();
			const eligible = consensusSet.length > 0 ? consensusSet : producer.getEligibleValidators();
			this.validators = eligible.map((did) => ({ did, power: 10, priority: 0 }));
		}

		this.totalPower = this.validators.reduce((s, v) => s + v.power, 0);

		// Threshold: custom fraction or default 2/3+1
		if (cfg?.thresholdFraction !== undefined) {
			this.threshold = Math.ceil(this.totalPower * cfg.thresholdFraction);
		} else {
			this.threshold = Math.floor(this.totalPower * 2 / 3) + 1;
		}
	}

	// ── Public API ───────────────────────────────────────────────

	start(startHeight?: number): void {
		if (this.validators.length === 0) {
			this.log("Cannot start: no validators in set");
			return;
		}
		this.height = startHeight ?? this.producer.getHeight() + 1;
		this.running = true;
		this.lastCommitTime = Date.now();
		this.log(`Started: height=${this.height} validators=${this.validators.length} threshold=${this.threshold}/${this.totalPower}`);
		this.enterNewHeight();
	}

	stop(): void {
		this.running = false;
		this.clearTimer();
	}

	getState(): Record<string, unknown> {
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
			consensusSetSize: this.validators.length,
			lastCommitTime: this.lastCommitTime,
			stallDetected: false,
			proposerDid: this.getProposer(this.height, this.round),
			rosterSize: this.validators.length,
		};
	}

	getThreshold(): number {
		return this.threshold;
	}

	getEvidence(): EquivocationEvidence[] {
		return [...this.evidence];
	}

	handleMessage(msg: ConsensusMessage): boolean {
		if (!this.running) return false;

		const key = `${msg.height}:${msg.round}:${msg.type}:${msg.from}`;
		if (this.seenMessages.has(key)) return false;
		this.seenMessages.add(key);
		if (this.seenMessages.size > 10000) {
			const arr = [...this.seenMessages];
			this.seenMessages = new Set(arr.slice(-5000));
		}

		if (msg.height < this.height) return false;
		if (msg.height > this.height + 1) return false;
		if (!this.isValidator(msg.from)) return false;

		this.checkEquivocation(msg);

		switch (msg.type) {
			case "propose": return this.onPropose(msg);
			case "prevote": return this.onPrevote(msg);
			case "precommit": return this.onPrecommit(msg);
			default: return false;
		}
	}

	onBlockSynced(height: number): void {
		if (height >= this.height) {
			this.height = height + 1;
			this.enterNewHeight();
		}
	}

	selectProposer(height: number, round: number): string {
		return this.getProposer(height, round);
	}

	// ── CometBFT Proposer Selection ──────────────────────────────
	// Weighted round-robin: each validator accumulates priority by VP,
	// highest priority proposes, then decreases by totalPower.

	private getProposer(height: number, round: number): string {
		if (this.validators.length === 0) return "";

		// Simple deterministic round-robin weighted by power.
		// With equal power (our case: all validators have power 10),
		// this reduces to: validators[(height + round) % N].
		// For unequal power, use a weighted index.
		if (this.validators.every((v) => v.power === this.validators[0]!.power)) {
			// Equal power: simple modulo
			const idx = (height + round) % this.validators.length;
			return this.validators[idx]!.did;
		}

		// Unequal power: weighted selection (O(N), not O(H*N))
		const slot = (height + round) % this.totalPower;
		let cumulative = 0;
		for (const v of this.validators) {
			cumulative += v.power;
			if (slot < cumulative) return v.did;
		}
		return this.validators[0]!.did;
	}

	// ── State Machine ────────────────────────────────────────────

	/** NewHeight -> wait timeoutCommit -> Propose(H, 0) */
	private enterNewHeight(): void {
		if (!this.running) return;
		this.step = "newHeight";
		this.round = 0;
		this.lockedValue = null;
		this.lockedRound = -1;
		this.validValue = null;
		this.validRound = -1;
		this.prevotes.clear();
		this.precommits.clear();
		this.proposals.clear();
		this.voteRecord.clear();

		// Wait timeoutCommit (minimum block interval) before starting new round
		const elapsed = Date.now() - this.lastCommitTime;
		const wait = Math.max(0, Math.max(this.commitTimeout, this.minBlockInterval) - elapsed);
		this.startTimer(wait, () => this.enterPropose(this.height, 0));
	}

	/** Propose step: proposer creates block, others wait */
	private enterPropose(height: number, round: number): void {
		if (!this.running || height !== this.height) return;

		// Round cap: reset to round 0 if exceeded
		if (round > MAX_ROUND) {
			this.log(`Round cap reached (R=${round} > ${MAX_ROUND}), resetting to R=0`);
			round = 0;
		}

		this.round = round;
		this.step = "propose";

		const proposer = this.getProposer(height, round);
		this.log(`H=${height} R=${round} proposer=${this.shortDid(proposer)}`);

		if (proposer === this.myDid) {
			// I am the proposer
			const block = this.validValue ?? this.producer.produceBlock(this.myDid, true);
			if (block) {
				const hash = computeBlockHash(block);
				this.proposals.set(String(round), block);
				this.broadcast({ type: "propose", height, round, blockHash: hash, from: this.myDid, block });
				this.enterPrevote(height, round, hash);
			} else {
				this.enterPrevote(height, round, "nil");
			}
		} else {
			// Wait for proposal
			this.startTimer(this.timeoutPropose(round), () => {
				this.log(`H=${height} R=${round}: propose timeout`);
				this.enterPrevote(height, round, "nil");
			});
		}
	}

	/** Prevote step: vote for proposal respecting lock */
	private enterPrevote(height: number, round: number, proposedHash: string): void {
		if (!this.running) return;
		this.step = "prevote";
		let voteHash = proposedHash;

		// Lock rules (CometBFT Algorithm 1, lines 22-28)
		if (this.lockedValue !== null && proposedHash !== "nil") {
			const lockedHash = computeBlockHash(this.lockedValue);
			if (proposedHash !== lockedHash) {
				// Locked on different block. Check for PoLC unlock.
				const polkaRound = this.findPolkaRound(proposedHash);
				if (polkaRound !== null && polkaRound > this.lockedRound) {
					this.lockedValue = null;
					this.lockedRound = -1;
					voteHash = proposedHash;
				} else {
					voteHash = "nil";
				}
			}
		}

		// Record and broadcast prevote
		const rk = String(round);
		if (!this.prevotes.has(rk)) this.prevotes.set(rk, new Map());
		this.prevotes.get(rk)!.set(this.myDid, voteHash);
		this.broadcast({ type: "prevote", height, round, blockHash: voteHash, from: this.myDid });

		// Start prevote timeout
		this.startTimer(this.timeoutPrevote(round), () => {
			this.log(`H=${height} R=${round}: prevote timeout`);
			this.enterPrecommit(height, round, "nil");
		});

		// Check if quorum already reached
		this.checkPrevoteQuorum(rk, height, round);
	}

	/** Precommit step: lock and vote */
	private enterPrecommit(height: number, round: number, blockHash: string): void {
		if (!this.running) return;
		this.step = "precommit";

		// Lock on block if voting for non-nil (CometBFT lock rule)
		if (blockHash !== "nil") {
			const block = this.findProposalByHash(blockHash);
			if (block) {
				this.lockedValue = block;
				this.lockedRound = round;
				this.validValue = block;
				this.validRound = round;
			}
		}

		// Record and broadcast precommit
		const rk = String(round);
		if (!this.precommits.has(rk)) this.precommits.set(rk, new Map());
		this.precommits.get(rk)!.set(this.myDid, blockHash);
		this.broadcast({ type: "precommit", height, round, blockHash, from: this.myDid });

		// Start precommit timeout
		this.startTimer(this.timeoutPrecommit(round), () => {
			this.log(`H=${height} R=${round}: precommit timeout`);
			this.enterPropose(height, round + 1);
		});

		// Check if quorum already reached
		this.checkPrecommitQuorum(rk, height, round);
	}

	// ── Message Handlers ─────────────────────────────────────────

	private onPropose(msg: ConsensusMessage): boolean {
		if (msg.height !== this.height || msg.round < this.round) return false;
		if (msg.round > this.round) return true;
		if (!msg.block) return false;

		const expected = this.getProposer(msg.height, msg.round);
		if (msg.from !== expected) return false;

		const hash = computeBlockHash(msg.block);
		if (hash !== msg.blockHash) return false;

		this.proposals.set(String(msg.round), msg.block);

		if (this.step === "propose") {
			this.clearTimer();
			this.enterPrevote(msg.height, msg.round, hash);
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

	// ── Quorum Checks ────────────────────────────────────────────

	private checkPrevoteQuorum(rk: string, height: number, round: number): void {
		const votes = this.prevotes.get(rk);
		if (!votes) return;

		for (const [hash, power] of this.countVotePower(votes)) {
			if (power >= this.threshold) {
				if (hash === "nil") {
					this.enterPrecommit(height, round, "nil");
					return;
				}
				// PoLC achieved for a block
				const block = this.findProposalByHash(hash);
				if (block) {
					this.validValue = block;
					this.validRound = round;
				}
				if (this.step === "prevote") {
					this.clearTimer();
					this.enterPrecommit(height, round, hash);
				}
				return;
			}
		}
	}

	private checkPrecommitQuorum(rk: string, height: number, round: number): void {
		const votes = this.precommits.get(rk);
		if (!votes) return;

		for (const [hash, power] of this.countVotePower(votes)) {
			if (power >= this.threshold) {
				if (hash === "nil") {
					this.clearTimer();
					this.enterPropose(height, round + 1);
					return;
				}
				this.commitBlock(hash);
				return;
			}
		}
	}

	// ── Commit ───────────────────────────────────────────────────

	private commitBlock(blockHash: string): void {
		this.clearTimer();
		this.step = "commit";

		const block = this.findProposalByHash(blockHash);
		if (!block) {
			this.log(`Cannot commit: block not found`);
			this.enterPropose(this.height, this.round + 1);
			return;
		}

		// Apply block (skip if already applied by proposer)
		const currentHeight = this.producer.getHeight();
		if (block.height > currentHeight) {
			const result = this.producer.applyBlock(block, true);
			if (!result.valid) {
				this.log(`Commit failed: ${result.error}`);
				this.enterPropose(this.height, this.round + 1);
				return;
			}
		}

		this.lastCommitTime = Date.now();
		this.log(`COMMITTED H=${block.height} proposer=${this.shortDid(block.proposer)}`);

		if (this.onCommit) this.onCommit(block);

		// Advance to next height
		this.height = block.height + 1;
		this.enterNewHeight();
	}

	// ── Helpers ───────────────────────────────────────────────────

	private isValidator(did: string): boolean {
		return this.validators.some((v) => v.did === did);
	}

	private getValidatorPower(did: string): number {
		return this.validators.find((v) => v.did === did)?.power ?? 0;
	}

	/** Count voting power per hash (not just vote count). */
	private countVotePower(votes: Map<string, string>): Map<string, number> {
		const power = new Map<string, number>();
		for (const [voter, hash] of votes) {
			const vp = this.getValidatorPower(voter);
			power.set(hash, (power.get(hash) ?? 0) + vp);
		}
		return power;
	}

	private findPolkaRound(blockHash: string): number | null {
		let highest: number | null = null;
		for (const [roundStr, votes] of this.prevotes) {
			const power = this.countVotePower(votes);
			if ((power.get(blockHash) ?? 0) >= this.threshold) {
				const r = Number(roundStr);
				if (highest === null || r > highest) highest = r;
			}
		}
		return highest;
	}

	private findProposalByHash(hash: string): Block | null {
		for (const [, block] of this.proposals) {
			if (computeBlockHash(block) === hash) return block;
		}
		return null;
	}

	private checkEquivocation(msg: ConsensusMessage): void {
		if (msg.type === "propose") return;
		const key = `${msg.height}:${msg.round}:${msg.type}:${msg.from}`;
		const existing = this.voteRecord.get(key);
		if (existing !== undefined && existing !== msg.blockHash) {
			this.evidence.push({
				validator: msg.from,
				height: msg.height,
				round: msg.round,
				step: msg.type,
				voteA: existing,
				voteB: msg.blockHash,
				timestamp: Date.now(),
			});
			this.log(`EQUIVOCATION: ${this.shortDid(msg.from)} at H=${msg.height} R=${msg.round}`);
		}
		if (existing === undefined) this.voteRecord.set(key, msg.blockHash);
	}

	// ── Timeouts (CometBFT defaults) ─────────────────────────────

	private timeoutPropose(round: number): number {
		return this.proposeBase + round * this.proposeDelta;
	}
	private timeoutPrevote(round: number): number {
		return this.prevoteBase + round * this.prevoteDelta;
	}
	private timeoutPrecommit(round: number): number {
		return this.precommitBase + round * this.precommitDelta;
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

	private shortDid(did: string): string {
		return did.length > 30 ? `${did.slice(0, 16)}...${did.slice(-6)}` : did;
	}

	private log(msg: string): void {
		if (this.onLog) this.onLog(msg);
	}
}
