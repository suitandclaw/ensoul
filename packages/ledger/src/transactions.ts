import { blake3 } from "@noble/hashes/blake3.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { Transaction } from "./types.js";
import type { AccountState } from "./accounts.js";

/**
 * Compute the hash of a transaction (excludes signature from the hash).
 */
export function computeTxHash(tx: Transaction): string {
	const data = new TextEncoder().encode(
		JSON.stringify({
			type: tx.type,
			from: tx.from,
			to: tx.to,
			amount: tx.amount.toString(),
			nonce: tx.nonce,
			timestamp: tx.timestamp,
		}),
	);
	return bytesToHex(blake3(data));
}

/**
 * Encode a transaction's signable payload.
 * Includes chainId to prevent cross-chain replay attacks.
 */
export function encodeTxPayload(
	tx: Transaction,
	chainId = "ensoul-1",
): Uint8Array {
	return new TextEncoder().encode(
		JSON.stringify({
			chainId,
			type: tx.type,
			from: tx.from,
			to: tx.to,
			amount: tx.amount.toString(),
			nonce: tx.nonce,
			timestamp: tx.timestamp,
		}),
	);
}

/**
 * Verify a transaction's Ed25519 signature against the sender's public key.
 */
export async function verifyTxSignature(
	tx: Transaction,
	publicKey: Uint8Array,
): Promise<boolean> {
	const { verify } = await import("@noble/ed25519");
	const { sha512 } = await import("@noble/hashes/sha2.js");
	const { hashes } = await import("@noble/ed25519");
	if (!hashes.sha512) {
		hashes.sha512 = (msg: Uint8Array) => sha512(msg);
	}
	try {
		return verify(tx.signature, encodeTxPayload(tx), publicKey);
	} catch {
		return false;
	}
}

/** Transaction types that are protocol-generated and skip signature checks. */
const PROTOCOL_TX_TYPES: Set<string> = new Set([
	"block_reward",
	"genesis_allocation",
]);

/**
 * Validate a transaction with full Ed25519 signature verification.
 * Use this at mempool entry and peer tx submission.
 * Returns { valid, error } asynchronously.
 */
export async function validateTransactionWithSignature(
	tx: Transaction,
	state: AccountState,
	publicKey?: Uint8Array,
): Promise<{ valid: boolean; error?: string }> {
	// Protocol-generated txs skip signature verification
	if (PROTOCOL_TX_TYPES.has(tx.type)) {
		return validateTransaction(tx, state);
	}

	// Run structural validation first
	const structural = validateTransaction(tx, state);
	if (!structural.valid) return structural;

	// Verify Ed25519 signature
	if (!publicKey) {
		return { valid: false, error: "Public key required for signature verification" };
	}

	const sigValid = await verifyTxSignature(tx, publicKey);
	if (!sigValid) {
		return { valid: false, error: "Invalid signature" };
	}

	return { valid: true };
}

/** Protocol treasury DID for fee collection. */
export const PROTOCOL_TREASURY = "did:ensoul:protocol:treasury";
/** Burn address DID. */
export const BURN_ADDRESS = "did:ensoul:protocol:burn";
/** Network rewards pool DID. */
export const REWARDS_POOL = "did:ensoul:protocol:rewards";

/**
 * Validate a transaction against the current account state.
 * Checks balance, nonce, and basic structure.
 */
export function validateTransaction(
	tx: Transaction,
	state: AccountState,
	nowSec?: number,
): { valid: boolean; error?: string } {
	if (tx.amount < 0n) {
		return { valid: false, error: "Negative amount" };
	}

	// Protocol-generated txs skip nonce/signature checks
	if (tx.type === "block_reward") {
		if (tx.from !== REWARDS_POOL) {
			return { valid: false, error: "Block reward must come from rewards pool" };
		}
		return { valid: true };
	}

	if (tx.type === "genesis_allocation") {
		return { valid: true };
	}

	if (tx.type === "consensus_join") {
		const joiner = state.getAccount(tx.from);
		if (joiner.stakedBalance <= 0n) {
			return { valid: false, error: "Must have stake to join consensus" };
		}
		if (state.isInConsensusSet(tx.from)) {
			return { valid: false, error: "Already in consensus set" };
		}
		return { valid: true };
	}

	if (tx.type === "consensus_leave") {
		if (!state.isInConsensusSet(tx.from)) {
			return { valid: false, error: "Not in consensus set" };
		}
		return { valid: true };
	}

	// consensus_force_remove: privileged governance action. All validation
	// handled by the ABCI layer (PIONEER_KEY check, pub_key_b64 format,
	// height gate). The ledger is a no-op.
	if (tx.type === "consensus_force_remove" as string) {
		return { valid: true };
	}

	const sender = state.getAccount(tx.from);

	// Nonce check
	if (tx.nonce !== sender.nonce) {
		return {
			valid: false,
			error: `Invalid nonce: expected ${sender.nonce}, got ${tx.nonce}`,
		};
	}

	// Signature length check
	if (tx.signature.length !== 64) {
		return { valid: false, error: "Invalid signature length" };
	}

	switch (tx.type) {
		case "send":
		case "transfer": {
			if (sender.balance < tx.amount) {
				return { valid: false, error: "Insufficient balance" };
			}
			if (tx.from === tx.to) {
				return { valid: false, error: "Cannot transfer to self" };
			}
			break;
		}
		case "stake": {
			if (sender.balance < tx.amount) {
				return {
					valid: false,
					error: "Insufficient balance to stake",
				};
			}
			break;
		}
		case "unstake": {
			if (sender.stakedBalance < tx.amount) {
				return {
					valid: false,
					error: "Insufficient staked balance",
				};
			}
			// Check lockup period using provided timestamp for determinism
			const lockupNow = nowSec ?? Math.floor(Date.now() / 1000);
			if (sender.stakeLockedUntil > lockupNow) {
				const remaining = sender.stakeLockedUntil - lockupNow;
				const days = Math.ceil(remaining / 86400);
				return {
					valid: false,
					error: `Cannot unstake: lockup period has ${days} days remaining`,
				};
			}
			break;
		}
		case "storage_payment": {
			if (sender.balance < tx.amount) {
				return {
					valid: false,
					error: "Insufficient balance for storage payment",
				};
			}
			break;
		}
		case "reward_claim": {
			// Rewards are credited by the protocol; the claim tx
			// just triggers the distribution. Amount should be 0.
			break;
		}
		case "delegate": {
			if (sender.balance < tx.amount) {
				return {
					valid: false,
					error: "Insufficient balance to delegate",
				};
			}
			if (tx.from === tx.to) {
				return { valid: false, error: "Cannot delegate to self" };
			}
			break;
		}
		case "undelegate": {
			if (sender.delegatedBalance < tx.amount) {
				return {
					valid: false,
					error: "Insufficient delegated balance",
				};
			}
			break;
		}
		case "redelegate": {
			if (sender.delegatedBalance < tx.amount) {
				return {
					valid: false,
					error: "Insufficient delegated balance to redelegate",
				};
			}
			if (tx.from === tx.to) {
				return { valid: false, error: "Cannot redelegate to same validator" };
			}
			break;
		}
		case "pioneer_delegate": {
			// Privileged: handled entirely by the ABCI layer (like software_upgrade).
			break;
		}
		case "governance_propose":
		case "governance_sign":
		case "governance_execute":
		case "governance_cancel": {
			// Governance multisig: all validation and state handled by ABCI.
			break;
		}
		case "slash": {
			// Only protocol can slash -- from must be protocol treasury
			if (tx.from !== PROTOCOL_TREASURY) {
				return {
					valid: false,
					error: "Only protocol can slash",
				};
			}
			break;
		}
		case "burn": {
			if (sender.balance < tx.amount) {
				return {
					valid: false,
					error: "Insufficient balance to burn",
				};
			}
			if (tx.to !== BURN_ADDRESS) {
				return {
					valid: false,
					error: "Burn must target burn address",
				};
			}
			break;
		}
		default:
			return {
				valid: false,
				error: `Unrecognized transaction type: ${tx.type}`,
			};
	}

	return { valid: true };
}

/**
 * Apply a validated transaction to the account state.
 * Mutates the state in place.
 */
export function applyTransaction(
	tx: Transaction,
	state: AccountState,
	protocolFeeShare: number,
): void {
	switch (tx.type) {
		case "send":
		case "transfer": {
			state.debit(tx.from, tx.amount);
			state.credit(tx.to, tx.amount);
			break;
		}
		case "stake": {
			state.stake(tx.from, tx.amount);
			break;
		}
		case "unstake": {
			state.unstake(tx.from, tx.amount); // Enters cooldown, not immediately available
			break;
		}
		case "storage_payment": {
			state.debit(tx.from, tx.amount);
			// Split: protocolFeeShare% to treasury, rest to node operators
			const protocolCut =
				(tx.amount * BigInt(protocolFeeShare)) / 100n;
			const operatorCut = tx.amount - protocolCut;
			state.credit(PROTOCOL_TREASURY, protocolCut);
			state.credit(tx.to, operatorCut);
			// Give storage credits to the payer
			state.addStorageCredits(tx.from, tx.amount);
			break;
		}
		case "reward_claim": {
			// Rewards are pre-computed; this tx triggers transfer from pool
			if (tx.amount > 0n) {
				state.debit(REWARDS_POOL, tx.amount);
				state.credit(tx.from, tx.amount);
			}
			break;
		}
		case "block_reward": {
			// Protocol-generated: debit pool, credit proposer
			if (tx.amount > 0n) {
				state.debit(REWARDS_POOL, tx.amount);
				state.credit(tx.to, tx.amount);
			}
			break;
		}
		case "genesis_allocation": {
			// Protocol-generated: credit recipient (and optionally auto-stake)
			state.credit(tx.to, tx.amount);
			// If data field contains "stake", auto-stake the tokens.
			// tx.data may be a Uint8Array (in-memory) or a plain number array (from JSON).
			if (tx.data) {
				const dataBytes = tx.data instanceof Uint8Array ? tx.data : new Uint8Array(tx.data);
				if (dataBytes.length > 0 && new TextDecoder().decode(dataBytes) === "stake") {
					state.stake(tx.to, tx.amount);
				}
			}
			break;
		}
		case "delegate": {
			state.delegateTokens(tx.from, tx.amount);
			break;
		}
		case "undelegate": {
			state.undelegateTokens(tx.from, tx.amount);
			break;
		}
		case "redelegate": {
			// Account balances unchanged; delegatedBalance stays the same.
			// The DelegationRegistry update is handled by the ABCI layer.
			break;
		}
		case "pioneer_delegate": {
			// Privileged governance action. All state changes handled by ABCI.
			break;
		}
		case "consensus_force_remove" as string: {
			// Privileged governance action. ABCI handles the ValidatorUpdate.
			break;
		}
		case "governance_propose":
		case "governance_sign":
		case "governance_execute":
		case "governance_cancel": {
			// Governance multisig: all state handled by ABCI.
			break;
		}
		case "slash": {
			state.slash(tx.to, tx.amount);
			break;
		}
		case "burn": {
			state.debit(tx.from, tx.amount);
			break;
		}
		case "consensus_join": {
			// Validator joins the active consensus set.
			// Must have stakedBalance > 0 to participate.
			state.joinConsensus(tx.from);
			break;
		}
		case "consensus_leave": {
			// Validator leaves the active consensus set.
			state.leaveConsensus(tx.from);
			break;
		}
		default:
			throw new Error(`Unrecognized transaction type: ${tx.type}`);
	}

	// Protocol-generated txs do not track nonces
	if (tx.type !== "block_reward" && tx.type !== "genesis_allocation") {
		state.incrementNonce(tx.from);
	}
}
