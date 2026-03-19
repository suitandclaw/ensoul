import type { GenesisConfig, GenesisAllocation, Transaction } from "./types.js";
import { REWARDS_POOL } from "./transactions.js";

const DECIMALS = 10n ** 18n;
const ENC = new TextEncoder();

/**
 * Create the default genesis configuration for the Ensoul chain.
 * Foundation allocation is split equally among all validator DIDs
 * and auto-staked so they can immediately participate in consensus.
 *
 * Token allocations:
 * - 15% Foundation Validators (150M) -- split among validators, auto-staked
 * - 50% Network Rewards (500M) -- emitted per block over 10 years
 * - 10% Protocol Treasury (100M)
 * - 10% Agent Onboarding (100M)
 * - 5% Initial Liquidity (50M)
 * - 5% Early Contributors (50M)
 * - 5% Insurance Reserve (50M)
 */
export function createDefaultGenesis(
	foundationValidatorDids: string[] = ["did:ensoul:foundation"],
): GenesisConfig {
	const totalSupply = 1_000_000_000n * DECIMALS;
	const foundationTotal = 150_000_000n * DECIMALS;

	// ~19 ENSL per block at 6s blocks in year 1 (100M / 5,256,000 blocks)
	const blocksPerYear = (365 * 24 * 60 * 60) / 6;
	const year1Emission = 100_000_000n * DECIMALS;
	const emissionPerBlock = year1Emission / BigInt(blocksPerYear);

	// Split foundation allocation equally among validators
	const validatorCount = BigInt(foundationValidatorDids.length);
	const perValidator = validatorCount > 0n ? foundationTotal / validatorCount : foundationTotal;
	const remainder = validatorCount > 0n ? foundationTotal - perValidator * validatorCount : 0n;

	const allocations: GenesisAllocation[] = [];

	// Each validator gets an equal share, auto-staked
	for (let i = 0; i < foundationValidatorDids.length; i++) {
		const did = foundationValidatorDids[i]!;
		// First validator gets the remainder from integer division
		const amount = i === 0 ? perValidator + remainder : perValidator;
		allocations.push({
			label: "Foundation Validator",
			percentage: 0,
			tokens: amount,
			recipient: did,
			autoStake: true,
		});
	}

	// Protocol allocations
	allocations.push(
		{
			label: "Network Rewards",
			percentage: 50,
			tokens: 500_000_000n * DECIMALS,
			recipient: REWARDS_POOL,
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
	);

	// Fix percentages: foundation validators share 15%, rest as labeled
	// Set first foundation validator to carry the 15% label
	if (allocations.length > 0 && allocations[0]!.label === "Foundation Validator") {
		allocations[0]!.percentage = 15;
	}

	return {
		chainId: "ensoul-1",
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
 * Build genesis allocation transactions from a GenesisConfig.
 * These are included in the genesis block as visible records.
 */
export function buildGenesisTransactions(
	config: GenesisConfig,
): Transaction[] {
	const txs: Transaction[] = [];

	for (const alloc of config.allocations) {
		// Network rewards pool is funded but not a "transfer" -- it's the emission reserve
		const tx: Transaction = {
			type: "genesis_allocation",
			from: "genesis",
			to: alloc.recipient,
			amount: alloc.tokens,
			nonce: 0,
			timestamp: config.timestamp,
			signature: new Uint8Array(64),
		};

		// Signal auto-stake via the data field
		if (alloc.autoStake) {
			(tx as { data: Uint8Array }).data = ENC.encode("stake");
		}

		txs.push(tx);
	}

	return txs;
}

/**
 * Validate that genesis allocations sum to 100% and tokens sum to total supply.
 */
export function validateGenesis(config: GenesisConfig): {
	valid: boolean;
	error?: string;
} {
	const totalPct = config.allocations.reduce(
		(sum, a) => sum + a.percentage,
		0,
	);
	if (totalPct !== 100) {
		return {
			valid: false,
			error: `Allocations sum to ${totalPct}%, expected 100%`,
		};
	}

	const totalTokens = config.allocations.reduce(
		(sum, a) => sum + a.tokens,
		0n,
	);
	if (totalTokens !== config.totalSupply) {
		return {
			valid: false,
			error: `Token allocations ${totalTokens} != total supply ${config.totalSupply}`,
		};
	}

	return { valid: true };
}
