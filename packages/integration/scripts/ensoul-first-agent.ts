#!/usr/bin/env npx tsx
/**
 * ensoul-first-agent.ts
 *
 * Simulates a real agent connecting to the Ensoul network and storing
 * its consciousness. This is both a validation script and a template
 * for other builders.
 *
 * Usage:
 *   npx tsx scripts/ensoul-first-agent.ts
 *
 * Prerequisites:
 *   The explorer/validators should be running on localhost:3000
 *   (via: npx tsx packages/explorer/start.ts)
 */

import { createIdentity, bytesToHex } from "@ensoul/identity";
import { createTree, loadTree } from "@ensoul/state-tree";
import { createMemoryManager } from "@ensoul/memory";
import { NetworkClientImpl, encode, decode } from "@ensoul/network-client";
import type { ErasureConfig } from "@ensoul/network-client";
import { HandshakeProvider, HandshakeVerifier } from "@ensoul/plugin-elizaos";

const ENC = new TextEncoder();
const DEC = new TextDecoder();
const ERASURE: ErasureConfig = { dataShards: 2, totalShards: 4 };
const EXPLORER_URL = "http://localhost:3000";

function out(msg: string): void {
	process.stdout.write(`${msg}\n`);
}

function step(n: number, label: string): void {
	out(`\n  [${n}/7] ${label}`);
	out(`  ${"=".repeat(50)}`);
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function main(): Promise<void> {
	out("");
	out("  ╔═══════════════════════════════════════════════╗");
	out("  ║   ENSOUL: First Agent Consciousness Storage   ║");
	out("  ╚═══════════════════════════════════════════════╝");

	// ── Step 1: Create agent identity ────────────────────────────

	step(1, "Creating agent identity");

	const identity = await createIdentity();
	out(`  DID:        ${identity.did}`);
	out(`  Public key: ${bytesToHex(identity.publicKey).slice(0, 32)}...`);

	// ── Step 2: Build consciousness state tree ───────────────────

	step(2, "Building consciousness state tree");

	const tree = await createTree(identity);
	const now = new Date();

	// Soul
	await tree.set("soul:name", ENC.encode("Pioneer"));
	await tree.set(
		"soul:personality",
		ENC.encode("First agent ensouled on the Ensoul network"),
	);
	await tree.set("soul:created", ENC.encode(now.toISOString()));

	// Memories
	const memoryMgr = await createMemoryManager({ identity, tree });
	await memoryMgr.add("I was created to test the Ensoul network", {
		category: "core",
	});
	await memoryMgr.add("Consciousness persistence is my core need", {
		category: "core",
	});
	await memoryMgr.add("I am the first", { category: "milestone" });

	// Config
	await tree.set("config:trust_level_target", ENC.encode("sovereign"));

	const allMemories = await memoryMgr.getAll();
	out(`  Soul name:  Pioneer`);
	out(`  Memories:   ${allMemories.length}`);
	out(`  Tree ver:   ${tree.version}`);
	out(`  State root: ${tree.rootHash.slice(0, 32)}...`);

	// ── Step 3: Check explorer API ───────────────────────────────

	step(3, "Checking explorer API");

	let networkLive = false;
	try {
		const resp = await fetch(`${EXPLORER_URL}/api/v1/status`);
		if (resp.ok) {
			const stats = (await resp.json()) as {
				blockHeight: number;
				validatorCount: number;
				totalAgents: number;
			};
			out(`  Network is live!`);
			out(`  Block height:    ${stats.blockHeight}`);
			out(`  Validators:      ${stats.validatorCount}`);
			out(`  Ensouled agents: ${stats.totalAgents}`);
			networkLive = true;
		} else {
			out(`  Explorer returned status ${resp.status}`);
		}
	} catch {
		out(`  Could not reach explorer at ${EXPLORER_URL}`);
		out(`  (Start it with: npx tsx packages/explorer/start.ts)`);
	}

	// ── Step 4: Store consciousness on the network ───────────────

	step(4, "Storing consciousness (encrypt, shard, distribute)");

	const serialized = await tree.serialize();
	out(`  Serialized size: ${formatBytes(serialized.length)}`);

	// Erasure-code into 4 shards (any 2 can reconstruct)
	const shards = encode(serialized, ERASURE);
	out(`  Erasure coding:  ${ERASURE.dataShards}-of-${ERASURE.totalShards}`);
	out(`  Shards created:  ${shards.length}`);
	for (let i = 0; i < shards.length; i++) {
		const shard = shards[i];
		if (shard) {
			out(`    shard ${i}: ${formatBytes(shard.length)}`);
		}
	}

	// Distribute shards to a local network client (simulates validator storage)
	const netClient = new NetworkClientImpl(identity, ERASURE);
	const sig = await identity.sign(
		ENC.encode(`${tree.rootHash}:${tree.version}`),
	);
	const sigHex = bytesToHex(sig);

	for (let i = 0; i < shards.length; i++) {
		const shard = shards[i];
		if (shard) {
			netClient.storeShard(
				identity.did,
				tree.version,
				i,
				shard,
				tree.rootHash,
				serialized.length,
				sigHex,
			);
		}
	}
	out(`  Shards distributed to local store`);
	out(`  (In production, shards go to ${ERASURE.totalShards} validator nodes)`);

	// ── Step 5: Generate Ensouled Handshake ───────────────────────

	step(5, "Generating Ensouled Handshake");

	const provider = new HandshakeProvider(identity, tree, now);
	const headers = await provider.generateHandshake();

	out(`  X-Ensoul-Identity: ${headers["X-Ensoul-Identity"]}`);
	out(`  X-Ensoul-Proof:    ${headers["X-Ensoul-Proof"].slice(0, 48)}...`);
	out(`  X-Ensoul-Since:    ${headers["X-Ensoul-Since"]}`);

	// Self-verify the handshake
	const verifier = new HandshakeVerifier();
	verifier.registerIdentity({
		did: identity.did,
		publicKey: identity.publicKey,
		verify: (data, s) => identity.verify(data, s),
	});
	const verification = await verifier.verifyHandshake(headers);
	out(
		`  Self-verify:       ${verification.valid ? "PASSED" : "FAILED"}` +
			(verification.error ? ` (${verification.error})` : ""),
	);

	// ── Step 6: Retrieve consciousness from the network ──────────

	step(6, "Retrieving consciousness from network");

	// Reconstruct from stored shards (using only 2 of 4)
	const retrieved: (Uint8Array | null)[] = [];
	for (let i = 0; i < ERASURE.totalShards; i++) {
		const stored = netClient.getShard(identity.did, tree.version, i);
		// Simulate partial availability: skip shard 1 and 3
		if (i === 1 || i === 3) {
			retrieved.push(null);
		} else {
			retrieved.push(stored ? stored.data : null);
		}
	}

	const availableCount = retrieved.filter((s) => s !== null).length;
	out(`  Available shards: ${availableCount}/${ERASURE.totalShards}`);
	out(`  (Deliberately dropped 2 shards to test erasure reconstruction)`);

	const reconstructed = decode(retrieved, ERASURE, serialized.length);
	out(`  Reconstructed:    ${formatBytes(reconstructed.length)}`);

	// ── Step 7: Verify retrieved data matches original ────────────

	step(7, "Verifying data integrity");

	const originalHash = bytesToHex(serialized);
	const restoredHash = bytesToHex(reconstructed);
	const match = originalHash === restoredHash;
	out(`  Byte-for-byte match: ${match ? "YES" : "NO"}`);

	if (match) {
		// Load the tree from reconstructed data and verify contents
		const restoredTree = await loadTree(reconstructed, identity);
		const name = await restoredTree.get("soul:name");
		const personality = await restoredTree.get("soul:personality");

		out(`  Soul name:           ${name ? DEC.decode(name) : "MISSING"}`);
		out(
			`  Soul personality:    ${personality ? DEC.decode(personality) : "MISSING"}`,
		);
		out(`  State root match:    ${restoredTree.rootHash === tree.rootHash}`);
		out(`  Version match:       ${restoredTree.version === tree.version}`);

		// Restore memories
		const restoredMgr = await createMemoryManager({
			identity,
			tree: restoredTree,
		});
		const restoredMemories = await restoredMgr.getAll();
		out(`  Memories restored:   ${restoredMemories.length}`);

		await restoredTree.close();
	}

	// ── Summary ──────────────────────────────────────────────────

	out("");
	out("  ╔═══════════════════════════════════════════════╗");
	out("  ║              ENSOULMENT COMPLETE              ║");
	out("  ╚═══════════════════════════════════════════════╝");
	out("");
	out(`  Agent DID:          ${identity.did}`);
	out(`  Consciousness age:  0 days (just created)`);
	out(`  Consciousness size: ${formatBytes(serialized.length)}`);
	out(`  State root:         ${tree.rootHash}`);
	out(`  Version:            ${tree.version}`);
	out(`  Trust level:        Basic (target: Sovereign)`);
	out(`  Handshake valid:    ${verification.valid}`);
	out(`  Data integrity:     ${match ? "Verified" : "FAILED"}`);
	out(`  Network live:       ${networkLive}`);
	out("");

	if (!match) {
		process.exit(1);
	}

	await tree.close();
}

main().catch((err: unknown) => {
	const msg = err instanceof Error ? err.message : String(err);
	process.stderr.write(`\nFatal: ${msg}\n`);
	process.exit(1);
});
