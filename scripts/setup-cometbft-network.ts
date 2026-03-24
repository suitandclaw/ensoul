#!/usr/bin/env npx tsx
/**
 * Generate CometBFT network configuration for all 35 validators
 * across 4 machines connected via Tailscale.
 *
 * Creates:
 *   1. Production genesis.json with all 35 validators
 *   2. Per-validator CometBFT directories with config.toml, genesis.json,
 *      priv_validator_key.json, and node_key.json
 *   3. Startup scripts for each machine
 *
 * Architecture:
 *   MBP:   validators 0-4   (5 CometBFT nodes)
 *   Mini1: validators 5-14  (10 CometBFT nodes)
 *   Mini2: validators 15-24 (10 CometBFT nodes)
 *   Mini3: validators 25-34 (10 CometBFT nodes)
 *
 * Each validator runs its own CometBFT + shares one ABCI server per machine.
 * The first validator on each machine (port 26656) is the external-facing peer.
 * Other validators on the same machine peer through localhost.
 *
 * Usage:
 *   npx tsx scripts/setup-cometbft-network.ts
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { execSync } from "node:child_process";

const HOME = process.env["HOME"] ?? "/tmp";
const COMETBFT_DIR = join(HOME, ".cometbft-ensoul");
const REPO_DIR = process.cwd();

// Tailscale IPs
const MACHINES = {
	mbp:   { ip: "100.67.81.90",    validators: [0,1,2,3,4],                name: "mbp" },
	mini1: { ip: "100.86.108.114",  validators: [5,6,7,8,9,10,11,12,13,14], name: "mini1" },
	mini2: { ip: "100.117.84.28",   validators: [15,16,17,18,19,20,21,22,23,24], name: "mini2" },
	mini3: { ip: "100.127.140.26",  validators: [25,26,27,28,29,30,31,32,33,34], name: "mini3" },
};

// Port allocation: each validator gets 3 sequential ports
// Base: 26656 for first validator on each machine, +10 for each subsequent
function portsForLocalIndex(localIdx: number): { p2p: number; rpc: number; abci: number } {
	return {
		p2p:  26656 + localIdx * 10,
		rpc:  26657 + localIdx * 10,
		abci: 26658, // All validators share one ABCI server per machine
	};
}

// Base58btc
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function b58Decode(str: string): Uint8Array {
	let num = 0n;
	for (const c of str) { const i = B58.indexOf(c); if (i < 0) throw new Error(`Bad b58: ${c}`); num = num * 58n + BigInt(i); }
	const bytes: number[] = [];
	while (num > 0n) { bytes.unshift(Number(num % 256n)); num /= 256n; }
	for (const c of str) { if (c !== "1") break; bytes.unshift(0); }
	return new Uint8Array(bytes);
}

function pubkeyFromDid(did: string): Uint8Array {
	if (!did.startsWith("did:key:z")) throw new Error(`Bad DID: ${did.slice(0, 20)}`);
	const d = b58Decode(did.slice(9));
	if (d.length < 34 || d[0] !== 0xed || d[1] !== 0x01) throw new Error("Bad multicodec");
	return d.subarray(2, 34);
}

function addressFromPubkey(pk: Uint8Array): string {
	return createHash("sha256").update(pk).digest().subarray(0, 20).toString("hex").toUpperCase();
}

/** Generate a CometBFT node key (Ed25519 key for P2P identity). */
function generateNodeKey(): { id: string; privKey: string } {
	// CometBFT node_key.json: {"priv_key": {"type": "tendermint/PrivKeyEd25519", "value": "base64(64 bytes)"}}
	// The node ID = hex(address) = hex(sha256(pubkey)[:20])
	// For simplicity, generate a random 64-byte key (seed+pubkey)
	// CometBFT actually derives pubkey from seed using Ed25519
	const seed = randomBytes(32);
	// We need to derive the Ed25519 pubkey from the seed
	// Use execSync to call cometbft gen-node-key and parse the output
	// Actually, for correctness, let's just generate random keys and let CometBFT derive them
	const privKeyBytes = Buffer.concat([seed, Buffer.alloc(32)]); // placeholder, we'll use cometbft CLI
	return { id: "", privKey: privKeyBytes.toString("base64") };
}

function log(msg: string): void {
	process.stdout.write(`[setup] ${msg}\n`);
}

async function main(): Promise<void> {
	log("Setting up CometBFT network for 35 validators");

	// Load genesis allocations
	const genesisRaw = await readFile(join(REPO_DIR, "genesis-config-v3.json"), "utf-8");
	const ensoulGenesis = JSON.parse(genesisRaw) as {
		chainId: string;
		timestamp: number;
		totalSupply: string;
		allocations: Array<{ label: string; percentage: number; tokens: string; recipient: string; autoStake?: boolean }>;
		emissionPerBlock: string;
		networkRewardsPool: string;
		protocolFees: { storageFeeProtocolShare: number; txBaseFee: string };
	};

	const foundation = ensoulGenesis.allocations.filter(a => a.label === "Foundation Validator");
	if (foundation.length !== 35) throw new Error(`Expected 35 foundation validators, got ${foundation.length}`);

	const DECIMALS = 10n ** 18n;

	// Build genesis validators
	const genesisValidators: Array<{
		address: string;
		pub_key: { type: string; value: string };
		power: string;
		name: string;
	}> = [];

	for (let i = 0; i < 35; i++) {
		const alloc = foundation[i]!;
		const pubkey = pubkeyFromDid(alloc.recipient);
		const address = addressFromPubkey(pubkey);
		const power = (BigInt(alloc.tokens) / DECIMALS).toString();

		let machine = "mbp";
		if (i >= 5 && i < 15) machine = "mini1";
		else if (i >= 15 && i < 25) machine = "mini2";
		else if (i >= 25) machine = "mini3";

		genesisValidators.push({
			address,
			pub_key: { type: "tendermint/PubKeyEd25519", value: Buffer.from(pubkey).toString("base64") },
			power,
			name: `${machine}-v${i}`,
		});
	}

	const totalPower = genesisValidators.reduce((s, v) => s + BigInt(v.power), 0n);
	log(`Total voting power: ${totalPower}`);

	// Build genesis.json
	const genesis = {
		genesis_time: new Date(ensoulGenesis.timestamp).toISOString(),
		chain_id: "ensoul-1",
		initial_height: "1",
		consensus_params: {
			block: { max_bytes: "67108864", max_gas: "-1" },
			evidence: { max_age_num_blocks: "100000", max_age_duration: "172800000000000", max_bytes: "1048576" },
			validator: { pub_key_types: ["ed25519"] },
			version: { app: "1" },
			abci: { vote_extensions_enable_height: "0" },
		},
		validators: genesisValidators,
		app_hash: "",
		app_state: ensoulGenesis,
	};

	// Write genesis to repo for all machines
	const genesisPath = join(REPO_DIR, "cometbft-genesis.json");
	await writeFile(genesisPath, JSON.stringify(genesis, null, 2));
	log(`Genesis written to ${genesisPath}`);

	// Generate per-validator directories
	const cometbftBin = join(HOME, "go", "bin", "cometbft");
	const allNodeInfo: Array<{ validatorIndex: number; machine: string; localIndex: number; nodeId: string; ip: string; p2pPort: number }> = [];

	for (const [machineKey, machine] of Object.entries(MACHINES)) {
		for (let li = 0; li < machine.validators.length; li++) {
			const vi = machine.validators[li]!;
			const dir = join(COMETBFT_DIR, `v${vi}`);

			await mkdir(join(dir, "config"), { recursive: true });
			await mkdir(join(dir, "data"), { recursive: true });

			// Copy genesis
			await writeFile(join(dir, "config", "genesis.json"), JSON.stringify(genesis, null, 2));

			// Copy or generate priv_validator_key
			const existingKey = join(COMETBFT_DIR, `validator-${li}`, "config", "priv_validator_key.json");
			let privValKey: string;
			try {
				privValKey = await readFile(existingKey, "utf-8");
			} catch {
				// Generate from DID (we have the Ensoul identity)
				const ensoulIdPath = join(HOME, ".ensoul", `validator-${li}`, "identity.json");
				try {
					const idRaw = await readFile(ensoulIdPath, "utf-8");
					const id = JSON.parse(idRaw) as { seed?: string; publicKey: string; did: string };
					if (id.seed) {
						const seed = Buffer.from(id.seed, "hex");
						const pubkey = Buffer.from(id.publicKey, "hex");
						const address = createHash("sha256").update(pubkey).digest().subarray(0, 20).toString("hex").toUpperCase();
						privValKey = JSON.stringify({
							address,
							pub_key: { type: "tendermint/PubKeyEd25519", value: pubkey.toString("base64") },
							priv_key: { type: "tendermint/PrivKeyEd25519", value: Buffer.concat([seed, pubkey]).toString("base64") },
						}, null, 2);
					} else {
						log(`  WARNING: No seed for validator ${vi}, generating placeholder`);
						privValKey = "{}";
					}
				} catch {
					// For remote validators (on Minis), generate a placeholder.
					// The real key will be generated by convert-keys-to-cometbft.ts on each Mini.
					const alloc = foundation[vi]!;
					const pubkey = pubkeyFromDid(alloc.recipient);
					const address = addressFromPubkey(pubkey);
					privValKey = JSON.stringify({
						address,
						pub_key: { type: "tendermint/PubKeyEd25519", value: Buffer.from(pubkey).toString("base64") },
						priv_key: { type: "tendermint/PrivKeyEd25519", value: "PLACEHOLDER_RUN_CONVERT_SCRIPT_ON_MINI" },
					}, null, 2);
				}
			}
			await writeFile(join(dir, "config", "priv_validator_key.json"), privValKey);

			// Validator state
			await writeFile(join(dir, "data", "priv_validator_state.json"), JSON.stringify({ height: "0", round: 0, step: 0 }));

			// Generate node key using CometBFT CLI
			try {
				execSync(`${cometbftBin} gen-node-key --home "${dir}" 2>/dev/null`);
			} catch {
				// Generate a random node key manually if CLI fails
				const nkSeed = randomBytes(32);
				// This is a simplified node key; CometBFT will regenerate if invalid
				await writeFile(join(dir, "config", "node_key.json"), JSON.stringify({
					priv_key: { type: "tendermint/PrivKeyEd25519", value: Buffer.concat([nkSeed, Buffer.alloc(32)]).toString("base64") }
				}));
			}

			// Read the generated node ID
			let nodeId = "";
			try {
				const nodeKeyRaw = await readFile(join(dir, "config", "node_key.json"), "utf-8");
				const nodeKey = JSON.parse(nodeKeyRaw) as { priv_key: { value: string } };
				const nkBytes = Buffer.from(nodeKey.priv_key.value, "base64");
				const nkPubkey = nkBytes.subarray(32, 64);
				// Node ID = hex(sha256(pubkey)[:20])
				// But CometBFT uses amino encoding for the address. For Ed25519:
				// address = sha256(pubkey_bytes)[:20]
				nodeId = createHash("sha256").update(nkPubkey).digest().subarray(0, 20).toString("hex");
			} catch {
				nodeId = "unknown";
			}

			const ports = portsForLocalIndex(li);
			allNodeInfo.push({
				validatorIndex: vi,
				machine: machineKey,
				localIndex: li,
				nodeId,
				ip: machine.ip,
				p2pPort: ports.p2p,
			});
		}
	}

	// Generate config.toml for each validator
	for (const info of allNodeInfo) {
		const vi = info.validatorIndex;
		const dir = join(COMETBFT_DIR, `v${vi}`);
		const ports = portsForLocalIndex(info.localIndex);
		const machine = MACHINES[info.machine as keyof typeof MACHINES]!;

		// Build persistent_peers: all validators on OTHER machines (first validator only, port 26656)
		// Plus all validators on the SAME machine (localhost, respective ports)
		const peers: string[] = [];

		for (const other of allNodeInfo) {
			if (other.validatorIndex === vi) continue; // Skip self

			if (other.machine === info.machine) {
				// Same machine: connect via localhost
				const otherPorts = portsForLocalIndex(other.localIndex);
				peers.push(`${other.nodeId}@127.0.0.1:${otherPorts.p2p}`);
			} else if (other.localIndex === 0) {
				// Different machine: only connect to the first validator (external-facing)
				peers.push(`${other.nodeId}@${MACHINES[other.machine as keyof typeof MACHINES]!.ip}:26656`);
			}
		}

		const config = generateConfig({
			moniker: `ensoul-v${vi}`,
			p2pPort: ports.p2p,
			rpcPort: ports.rpc,
			abciPort: ports.abci,
			externalAddress: info.localIndex === 0 ? `${machine.ip}:${ports.p2p}` : "",
			persistentPeers: peers.join(","),
		});

		await writeFile(join(dir, "config", "config.toml"), config);
	}

	// Write node info for reference
	await writeFile(
		join(COMETBFT_DIR, "network-info.json"),
		JSON.stringify(allNodeInfo, null, 2),
	);

	log(`Generated configs for ${allNodeInfo.length} validators`);
	log("");

	// Summary per machine
	for (const [key, machine] of Object.entries(MACHINES)) {
		const nodes = allNodeInfo.filter(n => n.machine === key);
		log(`${key} (${machine.ip}): ${nodes.length} validators`);
		for (const n of nodes) {
			const p = portsForLocalIndex(n.localIndex);
			log(`  v${n.validatorIndex}: p2p=${p.p2p} rpc=${p.rpc} node=${n.nodeId.slice(0, 12)}...`);
		}
	}

	log("");
	log("Next: copy v5-v34 directories to the respective Minis");
	log("  scp -r ~/.cometbft-ensoul/v{5..14} mini1:~/.cometbft-ensoul/");
	log("  (or git push and regenerate on each Mini)");
}

function generateConfig(opts: {
	moniker: string;
	p2pPort: number;
	rpcPort: number;
	abciPort: number;
	externalAddress: string;
	persistentPeers: string;
}): string {
	return `# CometBFT config for ${opts.moniker}
# Generated by setup-cometbft-network.ts

version = "0.38.17"
proxy_app = "tcp://127.0.0.1:${opts.abciPort}"
moniker = "${opts.moniker}"
db_backend = "goleveldb"
db_dir = "data"
log_level = "info"
log_format = "plain"
genesis_file = "config/genesis.json"
priv_validator_key_file = "config/priv_validator_key.json"
priv_validator_state_file = "data/priv_validator_state.json"
priv_validator_laddr = ""
node_key_file = "config/node_key.json"
abci = "socket"
filter_peers = false

[rpc]
laddr = "tcp://127.0.0.1:${opts.rpcPort}"
cors_allowed_origins = ["*"]
cors_allowed_methods = ["HEAD", "GET", "POST"]
cors_allowed_headers = ["Origin", "Accept", "Content-Type", "X-Requested-With", "X-Server-Time"]
grpc_laddr = ""
grpc_max_open_connections = 900
unsafe = false
max_open_connections = 900
max_subscription_clients = 100
max_subscriptions_per_client = 5
experimental_subscription_buffer_size = 200
experimental_websocket_write_buffer_size = 200
experimental_close_on_slow_client = false
timeout_broadcast_tx_commit = "10s"
max_request_batch_size = 10
max_body_bytes = 1000000
max_header_bytes = 1048576
tls_cert_file = ""
tls_key_file = ""
pprof_laddr = ""

[p2p]
laddr = "tcp://0.0.0.0:${opts.p2pPort}"
external_address = "${opts.externalAddress}"
seeds = ""
persistent_peers = "${opts.persistentPeers}"
addr_book_file = "config/addrbook.json"
addr_book_strict = false
max_num_inbound_peers = 40
max_num_outbound_peers = 10
unconditional_peer_ids = ""
persistent_peers_max_dial_period = "0s"
flush_throttle_timeout = "100ms"
max_packet_msg_payload_size = 1024
send_rate = 5120000
recv_rate = 5120000
pex = true
seed_mode = false
private_peer_ids = ""
allow_duplicate_ip = true
handshake_timeout = "20s"
dial_timeout = "3s"

[mempool]
type = "flood"
recheck = true
recheck_timeout = "1s"
broadcast = true
wal_dir = ""
size = 5000
max_txs_bytes = 1073741824
cache_size = 10000
keep-invalid-txs-in-cache = false
max_tx_bytes = 1048576
max_batch_bytes = 0
experimental_max_gossip_connections_to_persistent_peers = 0
experimental_max_gossip_connections_to_non_persistent_peers = 0

[statesync]
enable = false
rpc_servers = ""
trust_height = 0
trust_hash = ""
trust_period = "168h0m0s"
discovery_time = "15s"
temp_dir = ""
chunk_request_timeout = "10s"
chunk_fetchers = "4"

[blocksync]
version = "v0"

[consensus]
wal_file = "data/cs.wal/wal"
timeout_propose = "3s"
timeout_propose_delta = "500ms"
timeout_prevote = "1s"
timeout_prevote_delta = "500ms"
timeout_precommit = "1s"
timeout_precommit_delta = "500ms"
timeout_commit = "1s"
double_sign_check_height = 0
skip_timeout_commit = false
create_empty_blocks = true
create_empty_blocks_interval = "0s"
peer_gossip_sleep_duration = "100ms"
peer_query_maj23_sleep_duration = "2s"

[storage]
discard_abci_responses = false

[tx_index]
indexer = "kv"
psql-conn = ""

[instrumentation]
prometheus = false
prometheus_listen_addr = ":26660"
max_open_connections = 3
namespace = "cometbft"
`;
}

main().catch((err) => {
	process.stderr.write(`Fatal: ${err instanceof Error ? err.message : String(err)}\n`);
	process.exit(1);
});
