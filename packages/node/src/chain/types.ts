import type { Block, Transaction } from "@ensoul/ledger";

/**
 * Configuration for the chain node.
 */
export interface ChainNodeConfig {
	/** Expected block time in ms. */
	blockTimeMs: number;
	/** Maximum transactions per block. */
	maxTxPerBlock: number;
	/** Maximum per-identity transactions per block. */
	maxTxPerIdentity: number;
	/** Nonce gap timeout in ms. */
	nonceGapTimeoutMs: number;
	/** Minimum staked balance required to produce blocks (in wei). */
	minimumStake: bigint;
}

/**
 * Message types for the block/tx gossip protocol.
 */
export interface BlockMessage {
	type: "block";
	block: SerializedBlock;
}

export interface TxMessage {
	type: "tx";
	tx: SerializedTx;
}

export interface SyncRequestMessage {
	type: "sync_request";
	fromHeight: number;
}

export interface SyncResponseMessage {
	type: "sync_response";
	blocks: SerializedBlock[];
}

export type ChainMessage =
	| BlockMessage
	| TxMessage
	| SyncRequestMessage
	| SyncResponseMessage;

/**
 * Serialized block (all Uint8Arrays hex-encoded for JSON transport).
 */
export interface SerializedBlock {
	height: number;
	previousHash: string;
	stateRoot: string;
	transactionsRoot: string;
	timestamp: number;
	proposer: string;
	transactions: SerializedTx[];
	attestations: Array<{
		validatorDid: string;
		signature: string;
		timestamp: number;
	}>;
}

/**
 * Serialized transaction (signature hex-encoded for JSON transport).
 */
export interface SerializedTx {
	type: string;
	from: string;
	to: string;
	amount: string;
	nonce: number;
	timestamp: number;
	signature: string;
	data?: string;
}

/**
 * Serialize a Block to JSON-safe form.
 */
export function serializeBlock(block: Block): SerializedBlock {
	return {
		height: block.height,
		previousHash: block.previousHash,
		stateRoot: block.stateRoot,
		transactionsRoot: block.transactionsRoot,
		timestamp: block.timestamp,
		proposer: block.proposer,
		transactions: block.transactions.map(serializeTx),
		attestations: block.attestations.map((a) => ({
			validatorDid: a.validatorDid,
			signature: hexFromBytes(a.signature),
			timestamp: a.timestamp,
		})),
	};
}

/**
 * Deserialize a Block from JSON-safe form.
 */
export function deserializeBlock(sb: SerializedBlock): Block {
	return {
		height: sb.height,
		previousHash: sb.previousHash,
		stateRoot: sb.stateRoot,
		transactionsRoot: sb.transactionsRoot,
		timestamp: sb.timestamp,
		proposer: sb.proposer,
		transactions: sb.transactions.map(deserializeTx),
		attestations: sb.attestations.map((a) => ({
			validatorDid: a.validatorDid,
			signature: hexToBytes(a.signature),
			timestamp: a.timestamp,
		})),
	};
}

/**
 * Serialize a Transaction.
 */
export function serializeTx(tx: Transaction): SerializedTx {
	const result: SerializedTx = {
		type: tx.type,
		from: tx.from,
		to: tx.to,
		amount: tx.amount.toString(),
		nonce: tx.nonce,
		timestamp: tx.timestamp,
		signature: hexFromBytes(tx.signature),
	};
	if (tx.data) {
		result.data = hexFromBytes(tx.data);
	}
	return result;
}

/**
 * Deserialize a Transaction.
 */
export function deserializeTx(st: SerializedTx): Transaction {
	const tx: Transaction = {
		type: st.type as Transaction["type"],
		from: st.from,
		to: st.to,
		amount: BigInt(st.amount),
		nonce: st.nonce,
		timestamp: st.timestamp,
		signature: hexToBytes(st.signature),
	};
	if (st.data) {
		(tx as { data: Uint8Array }).data = hexToBytes(st.data);
	}
	return tx;
}

function hexFromBytes(bytes: Uint8Array): string {
	return Array.from(bytes)
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

function hexToBytes(hex: string): Uint8Array {
	const bytes = new Uint8Array(hex.length / 2);
	for (let i = 0; i < hex.length; i += 2) {
		bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
	}
	return bytes;
}
