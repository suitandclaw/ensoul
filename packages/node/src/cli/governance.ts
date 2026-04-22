// CLI subcommand: ensoul-node governance {propose, sign, execute, cancel, list, show}

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

export interface GovernanceCommand {
	subcommand: "propose" | "sign" | "execute" | "cancel" | "list" | "show";
	payloadFile: string | undefined;
	proposalId: string | undefined;
	statusFilter: string | undefined;
	dataDir: string;
}

export function isGovernanceCommand(argv: string[]): boolean {
	return argv.includes("governance");
}

export function parseGovernanceArgs(argv: string[]): GovernanceCommand {
	let dataDir = "~/.ensoul";
	let found = false;
	let subcommand = "";
	let payloadFile = "";
	let proposalId = "";
	let statusFilter = "";

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]!;
		if (arg === "--data-dir" && argv[i + 1]) { dataDir = argv[++i]!; continue; }
		if (arg === "--status" && argv[i + 1]) { statusFilter = argv[++i]!; continue; }
		if (arg === "governance") { found = true; continue; }
		if (!found) continue;
		if (!subcommand) { subcommand = arg; continue; }
		// First positional after subcommand
		if (subcommand === "propose" && !payloadFile) { payloadFile = arg; continue; }
		if ((subcommand === "sign" || subcommand === "execute" || subcommand === "cancel" || subcommand === "show") && !proposalId) {
			proposalId = arg; continue;
		}
	}

	if (!subcommand) throw new Error("Usage: ensoul-node governance {propose|sign|execute|cancel|list|show}");

	return {
		subcommand: subcommand as GovernanceCommand["subcommand"],
		payloadFile: payloadFile || undefined,
		proposalId: proposalId || undefined,
		statusFilter: statusFilter || undefined,
		dataDir,
	};
}

function expandHome(p: string): string {
	if (p.startsWith("~/")) return join(process.env["HOME"] ?? "/root", p.slice(2));
	return p;
}

function loadIdentity(dataDir: string): { did: string; seed: string } {
	const dir = expandHome(dataDir);
	for (const sub of ["identity.json", "validator-0/identity.json"]) {
		try {
			const raw = readFileSync(join(dir, sub), "utf-8");
			const id = JSON.parse(raw) as { did: string; seed: string };
			if (id.did && id.seed) return id;
		} catch { /* try next */ }
	}
	throw new Error("No identity.json found in " + dir);
}

function canonicalJSON(obj: unknown): string {
	if (obj === null || obj === undefined) return "null";
	if (typeof obj === "string") return JSON.stringify(obj);
	if (typeof obj === "number" || typeof obj === "boolean") return String(obj);
	if (Array.isArray(obj)) return "[" + obj.map(canonicalJSON).join(",") + "]";
	if (typeof obj === "object") {
		const keys = Object.keys(obj as Record<string, unknown>).sort();
		const pairs = keys.map(k => JSON.stringify(k) + ":" + canonicalJSON((obj as Record<string, unknown>)[k]));
		return "{" + pairs.join(",") + "}";
	}
	return String(obj);
}

async function signGovernanceMessage(payload: unknown, nonce: string, seedHex: string): Promise<string> {
	const ed = await import("@noble/ed25519");
	const { sha512 } = await import("@noble/hashes/sha2.js");
	(ed as unknown as { hashes: { sha512: ((m: Uint8Array) => Uint8Array) | undefined } }).hashes.sha512 = (m: Uint8Array) => sha512(m);

	const canonical = canonicalJSON(payload);
	const message = createHash("sha256").update(canonical + nonce).digest();
	const seed = Buffer.from(seedHex, "hex");
	const sig = await ed.signAsync(message, seed);
	return Buffer.from(sig).toString("hex");
}

async function broadcastTx(tx: Record<string, unknown>): Promise<Record<string, unknown>> {
	const txBase64 = Buffer.from(JSON.stringify(tx)).toString("base64");
	const resp = await fetch("http://localhost:26657", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ jsonrpc: "2.0", id: "gov", method: "broadcast_tx_commit", params: { tx: txBase64 } }),
		signal: AbortSignal.timeout(30000),
	});
	const result = (await resp.json()) as { result?: Record<string, unknown> };
	return result.result ?? {};
}

async function queryGovernance(path: string): Promise<unknown> {
	const API = process.env["ENSOUL_API"] ?? "https://api.ensoul.dev";
	try {
		const resp = await fetch(`${API}/v1/governance/${path}`, { signal: AbortSignal.timeout(10000) });
		return await resp.json();
	} catch {
		return null;
	}
}

export async function runGovernanceCommand(cmd: GovernanceCommand): Promise<void> {
	if (cmd.subcommand === "list") {
		const path = cmd.statusFilter ? `proposals?status=${cmd.statusFilter}` : "proposals";
		const data = await queryGovernance(path) as { proposals?: Array<Record<string, unknown>> } | null;
		if (!data || !data.proposals) {
			console.log("No proposals found (governance may not be active yet).");
			return;
		}
		console.log(`${data.proposals.length} proposal(s):`);
		for (const p of data.proposals) {
			const sigs = typeof p["signatures"] === "object" ? Object.keys(p["signatures"] as Record<string, unknown>).length : 0;
			console.log(`  ${p["id"]}  status=${p["status"]}  type=${(p["payload"] as Record<string, unknown>)?.["type"] ?? "?"}  sigs=${sigs}`);
		}
		return;
	}

	if (cmd.subcommand === "show") {
		if (!cmd.proposalId) throw new Error("Usage: ensoul-node governance show <proposalId>");
		const data = await queryGovernance(`proposal/${cmd.proposalId}`);
		console.log(JSON.stringify(data, null, 2));
		return;
	}

	// Commands that require identity
	const identity = loadIdentity(cmd.dataDir);

	if (cmd.subcommand === "propose") {
		if (!cmd.payloadFile) throw new Error("Usage: ensoul-node governance propose <payload-file.json>");
		const payloadRaw = readFileSync(cmd.payloadFile, "utf-8");
		const payload = JSON.parse(payloadRaw) as Record<string, unknown>;
		const nonce = `${identity.did}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const signature = await signGovernanceMessage(payload, nonce, identity.seed);
		const tx = {
			type: "governance_propose",
			from: identity.did,
			to: identity.did,
			amount: "0",
			nonce: 0,
			timestamp: Date.now(),
			data: JSON.stringify({ payload, nonce, signature }),
			signature: "", // tx-level sig added by broadcast
		};

		// Sign the tx itself
		const ed = await import("@noble/ed25519");
		const { sha512 } = await import("@noble/hashes/sha2.js");
		(ed as unknown as { hashes: { sha512: ((m: Uint8Array) => Uint8Array) | undefined } }).hashes.sha512 = (m: Uint8Array) => sha512(m);
		const txPayload = JSON.stringify({ type: tx.type, from: tx.from, to: tx.to, amount: tx.amount, nonce: tx.nonce, timestamp: tx.timestamp });
		const txSig = await ed.signAsync(new TextEncoder().encode(txPayload), Buffer.from(identity.seed, "hex"));
		tx.signature = Buffer.from(txSig).toString("hex");

		console.log(`Proposing: type=${payload["type"]} nonce=${nonce.slice(0, 20)}...`);
		const result = await broadcastTx(tx);
		const code = (result["tx_result"] as Record<string, unknown>)?.["code"] ?? "?";
		console.log(`Broadcast result: code=${code} height=${result["height"] ?? "?"}`);
		if (code === 0) console.log("Proposal submitted. Use 'governance list' to find the ID.");
		return;
	}

	if (cmd.subcommand === "sign") {
		if (!cmd.proposalId) throw new Error("Usage: ensoul-node governance sign <proposalId>");
		// Fetch proposal to get payload + nonce
		const proposal = await queryGovernance(`proposal/${cmd.proposalId}`) as Record<string, unknown> | null;
		if (!proposal || proposal["error"]) {
			console.error("Proposal not found:", cmd.proposalId);
			return;
		}
		const payload = proposal["payload"] as Record<string, unknown>;
		const nonce = proposal["nonce"] as string;
		const signature = await signGovernanceMessage(payload, nonce, identity.seed);

		const tx = {
			type: "governance_sign",
			from: identity.did,
			to: identity.did,
			amount: "0",
			nonce: 0,
			timestamp: Date.now(),
			data: JSON.stringify({ proposalId: cmd.proposalId, signature }),
			signature: "",
		};

		const ed = await import("@noble/ed25519");
		const { sha512 } = await import("@noble/hashes/sha2.js");
		(ed as unknown as { hashes: { sha512: ((m: Uint8Array) => Uint8Array) | undefined } }).hashes.sha512 = (m: Uint8Array) => sha512(m);
		const txPayload = JSON.stringify({ type: tx.type, from: tx.from, to: tx.to, amount: tx.amount, nonce: tx.nonce, timestamp: tx.timestamp });
		const txSig = await ed.signAsync(new TextEncoder().encode(txPayload), Buffer.from(identity.seed, "hex"));
		tx.signature = Buffer.from(txSig).toString("hex");

		console.log(`Signing proposal ${cmd.proposalId}...`);
		const result = await broadcastTx(tx);
		const code = (result["tx_result"] as Record<string, unknown>)?.["code"] ?? "?";
		console.log(`Broadcast result: code=${code} height=${result["height"] ?? "?"}`);
		return;
	}

	if (cmd.subcommand === "execute") {
		if (!cmd.proposalId) throw new Error("Usage: ensoul-node governance execute <proposalId>");
		const tx = {
			type: "governance_execute",
			from: identity.did,
			to: identity.did,
			amount: "0",
			nonce: 0,
			timestamp: Date.now(),
			data: JSON.stringify({ proposalId: cmd.proposalId }),
			signature: "",
		};

		const ed = await import("@noble/ed25519");
		const { sha512 } = await import("@noble/hashes/sha2.js");
		(ed as unknown as { hashes: { sha512: ((m: Uint8Array) => Uint8Array) | undefined } }).hashes.sha512 = (m: Uint8Array) => sha512(m);
		const txPayload = JSON.stringify({ type: tx.type, from: tx.from, to: tx.to, amount: tx.amount, nonce: tx.nonce, timestamp: tx.timestamp });
		const txSig = await ed.signAsync(new TextEncoder().encode(txPayload), Buffer.from(identity.seed, "hex"));
		tx.signature = Buffer.from(txSig).toString("hex");

		console.log(`Executing proposal ${cmd.proposalId}...`);
		const result = await broadcastTx(tx);
		const code = (result["tx_result"] as Record<string, unknown>)?.["code"] ?? "?";
		console.log(`Broadcast result: code=${code} height=${result["height"] ?? "?"}`);
		return;
	}

	if (cmd.subcommand === "cancel") {
		if (!cmd.proposalId) throw new Error("Usage: ensoul-node governance cancel <proposalId>");
		const tx = {
			type: "governance_cancel",
			from: identity.did,
			to: identity.did,
			amount: "0",
			nonce: 0,
			timestamp: Date.now(),
			data: JSON.stringify({ proposalId: cmd.proposalId }),
			signature: "",
		};

		const ed = await import("@noble/ed25519");
		const { sha512 } = await import("@noble/hashes/sha2.js");
		(ed as unknown as { hashes: { sha512: ((m: Uint8Array) => Uint8Array) | undefined } }).hashes.sha512 = (m: Uint8Array) => sha512(m);
		const txPayload = JSON.stringify({ type: tx.type, from: tx.from, to: tx.to, amount: tx.amount, nonce: tx.nonce, timestamp: tx.timestamp });
		const txSig = await ed.signAsync(new TextEncoder().encode(txPayload), Buffer.from(identity.seed, "hex"));
		tx.signature = Buffer.from(txSig).toString("hex");

		console.log(`Cancelling proposal ${cmd.proposalId}...`);
		const result = await broadcastTx(tx);
		const code = (result["tx_result"] as Record<string, unknown>)?.["code"] ?? "?";
		console.log(`Broadcast result: code=${code} height=${result["height"] ?? "?"}`);
		return;
	}

	throw new Error(`Unknown governance subcommand: ${cmd.subcommand}`);
}
