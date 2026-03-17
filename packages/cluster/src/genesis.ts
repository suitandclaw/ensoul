import { readFile, writeFile } from "node:fs/promises";
import { validateGenesis } from "@ensoul/ledger";
import type { GenesisAllocation, GenesisConfig } from "@ensoul/ledger";
import type {
	DIDExport,
	GenesisMergeOptions,
	SerializedGenesisConfig,
} from "./types.js";
import { serializeGenesis } from "./types.js";

const DECIMALS = 10n ** 18n;

/**
 * Create a genesis config with per-validator stake allocations.
 * Validator stakes are drawn from the 15% Foundation Validators pool.
 * Each validator gets an allocation entry with percentage=0 and the
 * specified stake amount. The Foundation remainder is reduced accordingly.
 */
export function createClusterGenesis(
	validatorDids: string[],
	stakePerValidator: bigint,
): GenesisConfig {
	const totalSupply = 1_000_000_000n * DECIMALS;
	const foundationTotal = 150_000_000n * DECIMALS;
	const totalStaked = stakePerValidator * BigInt(validatorDids.length);

	if (totalStaked > foundationTotal) {
		throw new Error(
			`Total validator stake exceeds Foundation allocation: ` +
				`${validatorDids.length} validators * ${stakePerValidator / DECIMALS} ENSL = ` +
				`${totalStaked / DECIMALS} ENSL > ${foundationTotal / DECIMALS} ENSL`,
		);
	}

	const foundationRemaining = foundationTotal - totalStaked;
	const blocksPerYear = BigInt(Math.floor((365 * 24 * 60 * 60) / 6));
	const year1Emission = 100_000_000n * DECIMALS;
	const emissionPerBlock = year1Emission / blocksPerYear;

	const allocations: GenesisAllocation[] = [
		{
			label: "Foundation Validators",
			percentage: 15,
			tokens: foundationRemaining,
			recipient: "did:ensoul:foundation",
		},
		{
			label: "Network Rewards",
			percentage: 50,
			tokens: 500_000_000n * DECIMALS,
			recipient: "did:ensoul:protocol:rewards",
		},
		{
			label: "Protocol Treasury",
			percentage: 10,
			tokens: 100_000_000n * DECIMALS,
			recipient: "did:ensoul:protocol:treasury",
		},
		{
			label: "Agent Onboarding",
			percentage: 10,
			tokens: 100_000_000n * DECIMALS,
			recipient: "did:ensoul:protocol:onboarding",
		},
		{
			label: "Initial Liquidity",
			percentage: 5,
			tokens: 50_000_000n * DECIMALS,
			recipient: "did:ensoul:protocol:liquidity",
		},
		{
			label: "Early Contributors",
			percentage: 5,
			tokens: 50_000_000n * DECIMALS,
			recipient: "did:ensoul:protocol:contributors",
		},
		{
			label: "Insurance Reserve",
			percentage: 5,
			tokens: 50_000_000n * DECIMALS,
			recipient: "did:ensoul:protocol:insurance",
		},
		...validatorDids.map(
			(did): GenesisAllocation => ({
				label: "Validator Stake",
				percentage: 0,
				tokens: stakePerValidator,
				recipient: did,
			}),
		),
	];

	return {
		chainId: "ensoul-cluster",
		timestamp: Date.now(),
		totalSupply,
		allocations,
		emissionPerBlock,
		networkRewardsPool: 500_000_000n * DECIMALS,
		protocolFees: {
			storageFeeProtocolShare: 10,
			txBaseFee: 1000n,
		},
	};
}

/**
 * Merge multiple DID export files into a unified genesis config.
 * Used for cross-machine genesis coordination: each machine exports
 * its validator DIDs, then the coordinator merges them into one genesis.
 */
export async function mergeGenesisDids(
	opts: GenesisMergeOptions,
	log: (msg: string) => void = () => undefined,
): Promise<GenesisConfig> {
	const allDids: string[] = [];

	for (const filePath of opts.importFiles) {
		const content = await readFile(filePath, "utf-8");
		const didExport = JSON.parse(content) as DIDExport;

		for (const v of didExport.validators) {
			allDids.push(v.did);
		}

		log(
			`Imported ${didExport.validators.length} validators from ${filePath}`,
		);
	}

	log(`Total validators: ${allDids.length}`);

	const genesis = createClusterGenesis(allDids, opts.stakePerValidator);

	const validation = validateGenesis(genesis);
	if (!validation.valid) {
		throw new Error(
			`Invalid merged genesis: ${validation.error ?? "unknown"}`,
		);
	}

	await writeFile(
		opts.outputFile,
		JSON.stringify(serializeGenesis(genesis), null, 2),
	);

	log(`Genesis written to ${opts.outputFile}`);
	return genesis;
}

/**
 * Load a serialized genesis config from a JSON file.
 */
export async function loadGenesisFile(
	filePath: string,
): Promise<SerializedGenesisConfig> {
	const content = await readFile(filePath, "utf-8");
	return JSON.parse(content) as SerializedGenesisConfig;
}
