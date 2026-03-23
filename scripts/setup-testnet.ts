/**
 * Generate validator identities and genesis config for local testnet.
 * Usage: npx tsx scripts/setup-testnet.ts <output-dir>
 */

import { createIdentity, bytesToHex } from "../packages/identity/src/index.js";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const testDir = process.argv[2] ?? `${process.env["HOME"]}/.ensoul-testnet`;
const dids: string[] = [];

for (let i = 0; i < 4; i++) {
	const dir = join(testDir, `validator-${i}`);
	await mkdir(dir, { recursive: true });
	const seed = new Uint8Array(randomBytes(32));
	const id = await createIdentity({ seed });
	const persisted = {
		seed: bytesToHex(seed),
		publicKey: id.toJSON().publicKey,
		did: id.did,
	};
	await writeFile(
		join(dir, "identity.json"),
		JSON.stringify(persisted, null, 2),
	);
	dids.push(id.did);
	process.stdout.write(`Validator ${i}: ${id.did.slice(0, 30)}...\n`);
}

const config = {
	chainId: "ensoul-test",
	timestamp: Date.now(),
	totalSupply: "1000000000000000000000000000",
	allocations: dids.map((did) => ({
		label: "Test Validator",
		percentage: 0,
		tokens: "10000000000000000000000",
		recipient: did,
		autoStake: true,
	})),
	emissionPerBlock: "1000000000000000000",
	networkRewardsPool: "100000000000000000000000000",
	protocolFees: {
		storageFeeProtocolShare: 20,
		txBaseFee: "1000000000000000",
	},
};

await writeFile(
	join(testDir, "genesis-config.json"),
	JSON.stringify(config, null, 2),
);
process.stdout.write(`Genesis config written to ${testDir}/genesis-config.json\n`);
