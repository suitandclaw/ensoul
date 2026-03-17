import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { bytesToHex, createIdentity } from "@ensoul/identity";
import { validateGenesis } from "@ensoul/ledger";
import { createClusterGenesis } from "./genesis.js";
import type {
	ClusterConfig,
	ClusterInitOptions,
	DIDExport,
	ValidatorConfig,
} from "./types.js";
import { serializeGenesis } from "./types.js";

/** Port offset between P2P ports and API ports. */
const API_PORT_OFFSET = 1000;

/** Result of cluster initialization. */
export interface InitResult {
	config: ClusterConfig;
	didExport: DIDExport | null;
}

/**
 * Initialize a validator cluster.
 * Creates directories, generates identities, builds genesis config,
 * and writes cluster.json to the data directory.
 */
export async function initCluster(
	opts: ClusterInitOptions,
	log: (msg: string) => void = () => undefined,
): Promise<InitResult> {
	log(`Initializing cluster with ${opts.validators} validators`);

	await mkdir(opts.dataDir, { recursive: true });

	const validators: ValidatorConfig[] = [];

	for (let i = 0; i < opts.validators; i++) {
		const validatorDir = join(opts.dataDir, `validator-${i}`);
		await mkdir(validatorDir, { recursive: true });

		const seed = new Uint8Array(randomBytes(32));
		const identity = await createIdentity({ seed });
		const serialized = identity.toJSON();

		// Save seed (hex) and public identity to validator directory
		await writeFile(join(validatorDir, "seed.hex"), bytesToHex(seed));
		await writeFile(
			join(validatorDir, "identity.json"),
			JSON.stringify(serialized, null, 2),
		);

		const port = opts.basePort + i;
		const apiPort = opts.basePort + API_PORT_OFFSET + i;

		validators.push({
			index: i,
			did: identity.did,
			peerId: serialized.peerId,
			publicKey: serialized.publicKey,
			dataDir: validatorDir,
			port,
			apiPort,
		});

		log(
			`  validator-${i}: ${identity.did} (port ${port}, api ${apiPort})`,
		);
	}

	// Validator-0 is always the bootstrap peer
	const bootstrap = validators[0];
	if (!bootstrap) {
		throw new Error("No validators created");
	}

	const bootstrapPeer = `/ip4/${opts.advertiseHost}/tcp/${bootstrap.port}`;

	// Create genesis with all validator DIDs
	const validatorDids = validators.map((v) => v.did);
	const genesis = createClusterGenesis(
		validatorDids,
		opts.stakePerValidator,
	);

	const validation = validateGenesis(genesis);
	if (!validation.valid) {
		throw new Error(`Invalid genesis: ${validation.error ?? "unknown"}`);
	}

	const config: ClusterConfig = {
		version: 1,
		createdAt: Date.now(),
		advertiseHost: opts.advertiseHost,
		validators,
		bootstrapPeer,
		genesis: serializeGenesis(genesis),
		stakePerValidator: opts.stakePerValidator.toString(),
	};

	// Write cluster.json
	await writeFile(
		join(opts.dataDir, "cluster.json"),
		JSON.stringify(config, null, 2),
	);

	log(`Cluster config written to ${join(opts.dataDir, "cluster.json")}`);
	log(`Bootstrap peer: ${bootstrapPeer}`);

	// Export DIDs if requested (for cross-machine genesis coordination)
	let didExport: DIDExport | null = null;
	if (opts.exportDids) {
		didExport = {
			advertiseHost: opts.advertiseHost,
			validators: validators.map((v) => ({
				index: v.index,
				did: v.did,
				peerId: v.peerId,
				publicKey: v.publicKey,
				port: v.port,
				apiPort: v.apiPort,
			})),
		};
		await writeFile(opts.exportDids, JSON.stringify(didExport, null, 2));
		log(`DIDs exported to ${opts.exportDids}`);
	}

	return { config, didExport };
}
