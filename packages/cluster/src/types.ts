import type { GenesisAllocation, GenesisConfig } from "@ensoul/ledger";

// ── JSON-serializable genesis types ──────────────────────────────────

/** JSON-serializable genesis allocation (bigints as strings). */
export interface SerializedGenesisAllocation {
	label: string;
	percentage: number;
	tokens: string;
	recipient: string;
}

/** JSON-serializable genesis config (bigints as strings). */
export interface SerializedGenesisConfig {
	chainId: string;
	timestamp: number;
	totalSupply: string;
	allocations: SerializedGenesisAllocation[];
	emissionPerBlock: string;
	networkRewardsPool: string;
	protocolFees: {
		storageFeeProtocolShare: number;
		txBaseFee: string;
	};
}

// ── Cluster configuration types ──────────────────────────────────────

/** Configuration for a single validator in the cluster. */
export interface ValidatorConfig {
	index: number;
	did: string;
	peerId: string;
	publicKey: string;
	dataDir: string;
	port: number;
	apiPort: number;
}

/** Full cluster configuration, written as cluster.json. */
export interface ClusterConfig {
	version: 1;
	createdAt: number;
	advertiseHost: string;
	validators: ValidatorConfig[];
	bootstrapPeer: string;
	genesis: SerializedGenesisConfig;
	stakePerValidator: string;
}

/** DID export file for cross-machine genesis coordination. */
export interface DIDExport {
	advertiseHost: string;
	validators: Array<{
		index: number;
		did: string;
		peerId: string;
		publicKey: string;
		port: number;
		apiPort: number;
	}>;
}

// ── Command options ──────────────────────────────────────────────────

/** Options for cluster init command. */
export interface ClusterInitOptions {
	validators: number;
	basePort: number;
	dataDir: string;
	advertiseHost: string;
	exportDids: string | null;
	stakePerValidator: bigint;
}

/** Options for genesis merge command. */
export interface GenesisMergeOptions {
	importFiles: string[];
	outputFile: string;
	stakePerValidator: bigint;
}

// ── Process management types ─────────────────────────────────────────

/** PID tracking for a running validator process. */
export interface ProcessEntry {
	index: number;
	did: string;
	pid: number;
	startedAt: number;
}

/** Cluster PID file for tracking running processes. */
export interface ClusterPidFile {
	processes: ProcessEntry[];
	startedAt: number;
}

/** Status of a single validator. */
export interface ValidatorStatus {
	index: number;
	did: string;
	didShort: string;
	port: number;
	apiPort: number;
	status: "running" | "stopped";
	pid: number | null;
	blocksProduced: number;
	uptime: string;
}

// ── Worker IPC messages ──────────────────────────────────────────────

/** Message sent from parent to validator worker. */
export interface WorkerStartMessage {
	type: "start";
	seed: string;
	port: number;
	apiPort: number;
	bootstrapPeer: string;
	dataDir: string;
	genesis: SerializedGenesisConfig;
	validatorDids: string[];
}

/** Ready message from validator worker to parent. */
export interface WorkerReadyMessage {
	type: "ready";
	did: string;
}

/** Status update from validator worker to parent. */
export interface WorkerStatusMessage {
	type: "status";
	chainHeight: number;
	blocksProduced: number;
}

/** Union of all worker-to-parent messages. */
export type WorkerMessage = WorkerReadyMessage | WorkerStatusMessage;

// ── CLI command ──────────────────────────────────────────────────────

/** Parsed CLI command. */
export interface ClusterCommand {
	command: "init" | "start" | "stop" | "status" | "genesis" | "help";
	validators: number;
	basePort: number;
	dataDir: string;
	advertiseHost: string;
	exportDids: string | null;
	importFiles: string[];
	genesisFile: string | null;
	outputFile: string | null;
	stakePerValidator: bigint;
}

// ── Serialization helpers ────────────────────────────────────────────

/**
 * Serialize a GenesisConfig to a JSON-safe representation.
 * Converts all bigint values to strings.
 */
export function serializeGenesis(
	config: GenesisConfig,
): SerializedGenesisConfig {
	return {
		chainId: config.chainId,
		timestamp: config.timestamp,
		totalSupply: config.totalSupply.toString(),
		allocations: config.allocations.map(
			(a): SerializedGenesisAllocation => ({
				label: a.label,
				percentage: a.percentage,
				tokens: a.tokens.toString(),
				recipient: a.recipient,
			}),
		),
		emissionPerBlock: config.emissionPerBlock.toString(),
		networkRewardsPool: config.networkRewardsPool.toString(),
		protocolFees: {
			storageFeeProtocolShare:
				config.protocolFees.storageFeeProtocolShare,
			txBaseFee: config.protocolFees.txBaseFee.toString(),
		},
	};
}

/**
 * Deserialize a JSON-safe genesis config back to GenesisConfig.
 * Restores string values to bigints.
 */
export function deserializeGenesis(
	s: SerializedGenesisConfig,
): GenesisConfig {
	return {
		chainId: s.chainId,
		timestamp: s.timestamp,
		totalSupply: BigInt(s.totalSupply),
		allocations: s.allocations.map(
			(a): GenesisAllocation => ({
				label: a.label,
				percentage: a.percentage,
				tokens: BigInt(a.tokens),
				recipient: a.recipient,
			}),
		),
		emissionPerBlock: BigInt(s.emissionPerBlock),
		networkRewardsPool: BigInt(s.networkRewardsPool),
		protocolFees: {
			storageFeeProtocolShare: s.protocolFees.storageFeeProtocolShare,
			txBaseFee: BigInt(s.protocolFees.txBaseFee),
		},
	};
}
