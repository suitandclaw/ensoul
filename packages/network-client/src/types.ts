/**
 * An attestation from a validator confirming storage.
 */
export interface Attestation {
	validatorDid: string;
	signature: Uint8Array;
	timestamp: number;
}

/**
 * Receipt returned after successfully storing state on the network.
 */
export interface StoreReceipt {
	stateRoot: string;
	version: number;
	shardIds: string[];
	attestations: Attestation[];
	timestamp: number;
}

/**
 * Configuration for running as a storage node.
 */
export interface NodeConfig {
	maxStorageGB: number;
	port: number;
	announceAddress?: string;
}

/**
 * Statistics about node operation.
 */
export interface NodeStats {
	shardsStored: number;
	totalBytesStored: number;
	peersConnected: number;
	uptime: number;
}

/**
 * Configuration for erasure coding.
 */
export interface ErasureConfig {
	/** Number of data shards (K). Any K shards can reconstruct. */
	dataShards: number;
	/** Total number of shards (N). */
	totalShards: number;
}

/**
 * Full network client interface.
 */
export interface NetworkClient {
	connect(bootstrapPeers: string[]): Promise<void>;
	disconnect(): Promise<void>;
	isConnected(): boolean;
	getPeerCount(): number;

	storeState(
		stateBlob: Uint8Array,
		stateRoot: string,
		version: number,
		signature: Uint8Array,
	): Promise<StoreReceipt>;

	retrieveState(
		agentDid: string,
		version?: number,
	): Promise<{ blob: Uint8Array; root: string; version: number }>;

	retrieveDelta(
		agentDid: string,
		fromVersion: number,
	): Promise<{ delta: Uint8Array; toVersion: number }>;

	getBalance(): Promise<number>;
	estimateCost(blobSize: number, redundancy: number): Promise<number>;

	startNode(config: NodeConfig): Promise<void>;
	stopNode(): Promise<void>;
	getNodeStats(): Promise<NodeStats>;
}
