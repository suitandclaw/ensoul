import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import {
	AccountState,
	Mempool,
	BlockProducer,
} from "@ensoul/ledger";
import type { GenesisConfig, GenesisAllocation, Block } from "@ensoul/ledger";

const DECIMALS = 10n ** 18n;

/** JSON shape of genesis-config.json (bigints as strings). */
interface GenesisConfigJson {
	chainId: string;
	timestamp: number;
	totalSupply: string;
	allocations: Array<{
		label: string;
		percentage: number;
		tokens: string;
		recipient: string;
		autoStake?: boolean;
	}>;
	emissionPerBlock: string;
	networkRewardsPool: string;
	protocolFees: {
		storageFeeProtocolShare: number;
		txBaseFee: string;
	};
}

/**
 * Load a GenesisConfig from a JSON file (bigints stored as strings).
 */
export async function loadGenesisConfig(
	path: string,
): Promise<GenesisConfig> {
	const raw = await readFile(path, "utf-8");
	const json = JSON.parse(raw) as GenesisConfigJson;

	return {
		chainId: json.chainId,
		timestamp: json.timestamp,
		totalSupply: BigInt(json.totalSupply),
		allocations: json.allocations.map((a): GenesisAllocation => {
			const alloc: GenesisAllocation = {
				label: a.label,
				percentage: a.percentage,
				tokens: BigInt(a.tokens),
				recipient: a.recipient,
			};
			if (a.autoStake) alloc.autoStake = true;
			return alloc;
		}),
		emissionPerBlock: BigInt(json.emissionPerBlock),
		networkRewardsPool: BigInt(json.networkRewardsPool),
		protocolFees: {
			storageFeeProtocolShare: json.protocolFees.storageFeeProtocolShare,
			txBaseFee: BigInt(json.protocolFees.txBaseFee),
		},
	};
}

/** Serialized genesis block for JSON storage. */
interface SerializedGenesisBlock {
	height: number;
	previousHash: string;
	stateRoot: string;
	transactionsRoot: string;
	timestamp: number;
	proposer: string;
	transactions: Array<{
		type: string;
		from: string;
		to: string;
		amount: string;
		nonce: number;
		timestamp: number;
		signature: number[];
		data?: number[];
	}>;
	attestations: Array<{
		validatorDid: string;
		signature: number[];
		timestamp: number;
	}>;
	genesisConfig: GenesisConfigJson;
}

/**
 * Save a genesis block (plus the config that created it) to a JSON file.
 */
export async function saveGenesisBlock(
	block: Block,
	config: GenesisConfig,
	outputPath: string,
): Promise<void> {
	await mkdir(dirname(outputPath), { recursive: true });

	const serialized: SerializedGenesisBlock = {
		height: block.height,
		previousHash: block.previousHash,
		stateRoot: block.stateRoot,
		transactionsRoot: block.transactionsRoot,
		timestamp: block.timestamp,
		proposer: block.proposer,
		transactions: block.transactions.map((tx) => {
			const base: SerializedGenesisBlock["transactions"][0] = {
				type: tx.type,
				from: tx.from,
				to: tx.to,
				amount: tx.amount.toString(),
				nonce: tx.nonce,
				timestamp: tx.timestamp,
				signature: Array.from(tx.signature),
			};
			if (tx.data) {
				base.data = Array.from(tx.data);
			}
			return base;
		}),
		attestations: block.attestations.map((a) => ({
			validatorDid: a.validatorDid,
			signature: Array.from(a.signature),
			timestamp: a.timestamp,
		})),
		genesisConfig: {
			chainId: config.chainId,
			timestamp: config.timestamp,
			totalSupply: config.totalSupply.toString(),
			allocations: config.allocations.map((a) => {
				const entry: { label: string; percentage: number; tokens: string; recipient: string; autoStake?: boolean } = {
					label: a.label,
					percentage: a.percentage,
					tokens: a.tokens.toString(),
					recipient: a.recipient,
				};
				if (a.autoStake) entry.autoStake = true;
				return entry;
			}),
			emissionPerBlock: config.emissionPerBlock.toString(),
			networkRewardsPool: config.networkRewardsPool.toString(),
			protocolFees: {
				storageFeeProtocolShare:
					config.protocolFees.storageFeeProtocolShare,
				txBaseFee: config.protocolFees.txBaseFee.toString(),
			},
		},
	};

	await writeFile(outputPath, JSON.stringify(serialized, null, 2));
}

/**
 * Load a previously saved genesis block and its config from a JSON file.
 */
export async function loadGenesisBlock(
	path: string,
): Promise<{ block: Block; config: GenesisConfig }> {
	const raw = await readFile(path, "utf-8");
	const data = JSON.parse(raw) as SerializedGenesisBlock;

	const block: Block = {
		height: data.height,
		previousHash: data.previousHash,
		stateRoot: data.stateRoot,
		transactionsRoot: data.transactionsRoot,
		timestamp: data.timestamp,
		proposer: data.proposer,
		transactions: data.transactions.map((tx) => {
			const base = {
				type: tx.type as Block["transactions"][0]["type"],
				from: tx.from,
				to: tx.to,
				amount: BigInt(tx.amount),
				nonce: tx.nonce,
				timestamp: tx.timestamp,
				signature: new Uint8Array(tx.signature),
			};
			if (tx.data) {
				return { ...base, data: new Uint8Array(tx.data) };
			}
			return base;
		}),
		attestations: data.attestations.map((a) => ({
			validatorDid: a.validatorDid,
			signature: new Uint8Array(a.signature),
			timestamp: a.timestamp,
		})),
	};

	const cfg = data.genesisConfig;
	const config: GenesisConfig = {
		chainId: cfg.chainId,
		timestamp: cfg.timestamp,
		totalSupply: BigInt(cfg.totalSupply),
		allocations: cfg.allocations.map((a): GenesisAllocation => {
			const alloc: GenesisAllocation = {
				label: a.label,
				percentage: a.percentage,
				tokens: BigInt(a.tokens),
				recipient: a.recipient,
			};
			if (a.autoStake) alloc.autoStake = true;
			return alloc;
		}),
		emissionPerBlock: BigInt(cfg.emissionPerBlock),
		networkRewardsPool: BigInt(cfg.networkRewardsPool),
		protocolFees: {
			storageFeeProtocolShare: cfg.protocolFees.storageFeeProtocolShare,
			txBaseFee: BigInt(cfg.protocolFees.txBaseFee),
		},
	};

	return { block, config };
}

/**
 * Run the genesis subcommand: read config, create genesis block, save.
 */
export async function runGenesisCommand(
	configPath: string,
	outputPath: string,
): Promise<void> {
	const config = await loadGenesisConfig(configPath);

	// Create the genesis block using the ledger
	const state = new AccountState();
	const pool = new Mempool();
	const producer = new BlockProducer(state, pool, config);
	const block = producer.initGenesis();

	await saveGenesisBlock(block, config, outputPath);

	// Print summary
	const out = (msg: string): void => {
		process.stdout.write(`${msg}\n`);
	};

	out("");
	out("Genesis block created successfully.");
	out(`  Output: ${outputPath}`);
	out(`  Chain:  ${config.chainId}`);
	out(`  Height: ${block.height}`);
	out(`  Txs:    ${block.transactions.length}`);
	out(`  Root:   ${block.stateRoot}`);
	out("");

	// Summarize allocations
	const validators = config.allocations.filter(
		(a) => a.autoStake === true,
	);
	const protocol = config.allocations.filter(
		(a) => a.autoStake !== true,
	);

	out(`  Foundation validators: ${validators.length}`);
	if (validators.length > 0) {
		const perV = validators[0]!.tokens / DECIMALS;
		out(`    Per validator: ${perV.toLocaleString()} ENSL (auto-staked)`);
	}

	out("");
	for (const a of protocol) {
		const amount = a.tokens / DECIMALS;
		out(
			`  ${a.label}: ${amount.toLocaleString()} ENSL -> ${a.recipient.slice(0, 30)}...`,
		);
	}

	const total = config.allocations.reduce((s, a) => s + a.tokens, 0n);
	out("");
	out(`  Total allocated: ${(total / DECIMALS).toLocaleString()} ENSL`);
}
