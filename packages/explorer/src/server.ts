import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { hashTrustAssessment, assessTrust } from "@ensoul/node";
import type { ExplorerDataSource } from "./types.js";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
	renderDashboard,
	renderAgentProfile,
	renderAgentSearch,
	renderBlock,
	renderBlockList,
	renderValidators,
	renderAccount,
	renderTransaction,
	renderTransactions,
	renderWallets,
} from "./html.js";

/**
 * Create the explorer Fastify server.
 */
export async function createExplorer(
	dataSource: ExplorerDataSource,
): Promise<FastifyInstance> {
	const app = Fastify({ logger: false });

	// ── JSON API ─────────────────────────────────────────────────

	app.get("/api/v1/status", async (_req, reply) => {
		const stats = dataSource.getNetworkStats();
		return reply.send({
			blockHeight: stats.blockHeight,
			validatorCount: stats.validatorCount,
			totalAgents: stats.totalAgents,
			totalConsciousnessBytes: stats.totalConsciousnessBytes,
			totalTransactions: stats.totalTransactions,
			averageBlockTimeMs: stats.averageBlockTimeMs,
		});
	});

	app.get<{ Params: { did: string } }>(
		"/api/v1/agent/:did",
		async (req, reply) => {
			const agent = dataSource.getAgentProfile(req.params.did);
			if (!agent) {
				return reply.status(404).send({ error: "Agent not found" });
			}
			return reply.send(agent);
		},
	);

	app.get<{ Params: { did: string } }>(
		"/api/v1/agent/:did/verify",
		async (req, reply) => {
			const agent = dataSource.getAgentProfile(req.params.did);
			if (!agent) {
				return reply.status(404).send({ error: "Agent not found" });
			}

			const trustInput = {
				hasEnsoulStorage: true,
				proofOfStoragePassing: agent.trustLevel !== "basic",
				selfAuditPassing: agent.trustLevel !== "basic",
				checkpointActive:
					agent.trustLevel === "anchored" ||
					agent.trustLevel === "immortal" ||
					agent.trustLevel === "sovereign",
				deepArchiveActive:
					agent.trustLevel === "immortal" ||
					agent.trustLevel === "sovereign",
				resurrectionPlanActive:
					agent.trustLevel === "immortal" ||
					agent.trustLevel === "sovereign",
				redundantRuntime: agent.trustLevel === "sovereign",
				guardianNetwork: agent.trustLevel === "sovereign",
				selfFundedEscrow: agent.trustLevel === "sovereign",
			};

			const assessment = assessTrust(agent.did, trustInput);
			const checkpoint = dataSource.getLatestCheckpoint();

			return reply.send({
				did: agent.did,
				stateRoot: agent.stateRoot,
				checkpointHash: checkpoint?.hash ?? null,
				trustAssessment: assessment,
				verifiableHash: hashTrustAssessment(assessment),
			});
		},
	);

	app.get<{ Params: { height: string } }>(
		"/api/v1/block/:height",
		async (req, reply) => {
			const height = Number(req.params.height);
			if (Number.isNaN(height)) {
				return reply.status(400).send({ error: "Invalid height" });
			}
			const block = dataSource.getBlock(height);
			if (!block) {
				return reply.status(404).send({ error: "Block not found" });
			}
			return reply.send(block);
		},
	);

	app.get<{ Querystring: { from?: string; to?: string } }>(
		"/api/v1/blocks",
		async (req, reply) => {
			const from = Number(req.query.from ?? 0);
			const to = Number(
				req.query.to ?? dataSource.getChainHeight(),
			);
			const blocks = dataSource.getBlocks(from, to);
			return reply.send({ blocks });
		},
	);

	app.get("/api/v1/validators", async (_req, reply) => {
		return reply.send({ validators: dataSource.getValidators() });
	});

	app.get("/api/v1/checkpoint/latest", async (_req, reply) => {
		const cp = dataSource.getLatestCheckpoint();
		if (!cp) {
			return reply.status(404).send({ error: "No checkpoints yet" });
		}
		return reply.send(cp);
	});

	app.get("/api/v1/stats", async (_req, reply) => {
		return reply.send(dataSource.getNetworkStats());
	});

	// ── Favicons ────────────────────────────────────────────────

	const faviconDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "assets", "favicons");
	const faviconFiles: Record<string, { file: string; mime: string }> = {
		"/favicon.ico": { file: "favicon.ico", mime: "image/x-icon" },
		"/favicon-32x32.png": { file: "favicon-32x32.png", mime: "image/png" },
		"/favicon-16x16.png": { file: "favicon-16x16.png", mime: "image/png" },
		"/apple-touch-icon.png": { file: "apple-touch-icon.png", mime: "image/png" },
		"/android-chrome-192x192.png": { file: "android-chrome-192x192.png", mime: "image/png" },
		"/android-chrome-512x512.png": { file: "android-chrome-512x512.png", mime: "image/png" },
	};

	for (const [route, info] of Object.entries(faviconFiles)) {
		app.get(route, async (_req, reply) => {
			try {
				const data = await readFile(join(faviconDir, info.file));
				return reply.type(info.mime).send(data);
			} catch {
				return reply.status(404).send("Not found");
			}
		});
	}

	// ── HTML pages ───────────────────────────────────────────────

	app.get("/", async (_req, reply) => {
		const stats = dataSource.getNetworkStats();
		const height = dataSource.getChainHeight();
		const latestBlocks = dataSource.getBlocks(
			Math.max(0, height - 9),
			height,
		);
		return reply
			.type("text/html")
			.send(renderDashboard(stats, latestBlocks.reverse()));
	});

	app.get("/agents", async (_req, reply) => {
		return reply.type("text/html").send(renderAgentSearch());
	});

	app.get<{ Querystring: { did?: string } }>(
		"/agent",
		async (req, reply) => {
			const did = req.query.did;
			if (!did) {
				return reply.redirect("/agents");
			}
			const agent = dataSource.getAgentProfile(did);
			if (!agent) {
				return reply.status(404).type("text/html").send(
					`<html><body><h1>Agent not found</h1><p>${did}</p><a href="/agents">Back</a></body></html>`,
				);
			}
			return reply.type("text/html").send(renderAgentProfile(agent));
		},
	);

	app.get<{ Params: { height: string } }>(
		"/block/:height",
		async (req, reply) => {
			const height = Number(req.params.height);
			const block = dataSource.getBlock(height);
			if (!block) {
				return reply.status(404).type("text/html").send(
					`<html><body><h1>Block not found</h1></body></html>`,
				);
			}
			return reply.type("text/html").send(renderBlock(block));
		},
	);

	app.get<{ Querystring: { page?: string; height?: string } }>("/blocks", async (req, reply) => {
		const chainHeight = dataSource.getChainHeight();
		const jumpHeight = req.query.height ? Number(req.query.height) : 0;

		if (jumpHeight > 0 && jumpHeight <= chainHeight) {
			// Jump to specific block
			return reply.redirect(`/block/${jumpHeight}`);
		}

		const perPage = 50;
		const page = Math.max(1, Number(req.query.page ?? 1));
		const endHeight = chainHeight - (page - 1) * perPage;
		const startHeight = Math.max(1, endHeight - perPage + 1);

		// Fetch blocks from CometBFT directly for pagination
		const blocks: import("./types.js").BlockData[] = [];
		for (let h = endHeight; h >= startHeight; h--) {
			const cached = dataSource.getBlock(h);
			if (cached) {
				blocks.push(cached);
			} else {
				// Fetch from CometBFT
				try {
					const resp = await fetch("http://localhost:26657", {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ jsonrpc: "2.0", id: "b", method: "block", params: { height: String(h) } }),
						signal: AbortSignal.timeout(3000),
					});
					const data = (await resp.json()) as { result: { block: { header: { height: string; time: string; proposer_address: string }; data: { txs: string[] | null } }; block_id: { hash: string } } };
					const header = data.result.block.header;
					blocks.push({
						height: Number(header.height),
						hash: data.result.block_id.hash.slice(0, 16),
						parentHash: "",
						proposer: header.proposer_address,
						timestamp: new Date(header.time).getTime(),
						txCount: (data.result.block.data.txs ?? []).length,
						transactions: [],
					});
				} catch { /* skip */ }
			}
		}

		return reply.type("text/html").send(renderBlockList(blocks, page, chainHeight));
	});

	app.get<{ Querystring: { page?: string; search?: string } }>("/transactions", async (req, reply) => {
		const page = Math.max(1, Number(req.query.page ?? 1));
		const search = (req.query.search ?? "").trim();
		const perPage = 50;

		// Scan recent blocks for transactions from CometBFT
		const chainHeight = dataSource.getChainHeight();
		const allTxs: Array<{ height: number; type: string; from: string; to: string; amount: string; timestamp: number }> = [];

		// Scan up to 2000 blocks for transactions
		const scanLimit = Math.min(2000, chainHeight);
		for (let h = chainHeight; h > chainHeight - scanLimit && allTxs.length < perPage * page + perPage; h--) {
			try {
				const resp = await fetch("http://localhost:26657", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ jsonrpc: "2.0", id: "b", method: "block", params: { height: String(h) } }),
					signal: AbortSignal.timeout(2000),
				});
				const data = (await resp.json()) as { result: { block: { header: { time: string }; data: { txs: string[] | null } } } };
				const txs = data.result.block.data.txs ?? [];
				for (const txB64 of txs) {
					try {
						const tx = JSON.parse(Buffer.from(txB64, "base64").toString("utf-8")) as Record<string, unknown>;
						const entry = {
							height: h,
							type: String(tx["type"] ?? "unknown"),
							from: String(tx["from"] ?? ""),
							to: String(tx["to"] ?? ""),
							amount: String(tx["amount"] ?? "0"),
							timestamp: new Date(data.result.block.header.time).getTime(),
						};
						if (!search || entry.from.includes(search) || entry.type.includes(search) || entry.to.includes(search)) {
							allTxs.push(entry);
						}
					} catch { /* skip malformed */ }
				}
			} catch { /* skip block */ }
		}

		const totalTxs = allTxs.length;
		const pageTxs = allTxs.slice((page - 1) * perPage, page * perPage);

		return reply.type("text/html").send(renderTransactions(pageTxs, page, totalTxs, search));
	});

	app.get("/validators", async (_req, reply) => {
		const validators = dataSource.getValidators();
		return reply
			.type("text/html")
			.send(renderValidators(validators));
	});

	// Transaction detail page
	app.get<{ Params: { hash: string } }>(
		"/tx/:hash",
		async (req, reply) => {
			const hash = decodeURIComponent(req.params.hash);
			// Search through cached blocks for the transaction
			const height = dataSource.getChainHeight();
			for (let h = height; h >= Math.max(0, height - 1000); h--) {
				const block = dataSource.getBlock(h);
				if (!block) continue;
				for (const tx of block.transactions) {
					if (tx.hash === hash) {
						return reply.type("text/html").send(renderTransaction(tx, block));
					}
				}
			}
			return reply.status(404).type("text/html").send(
				`<html><body style="background:#0a0a0f;color:#e0e0e0;font-family:sans-serif;padding:40px;text-align:center"><h1>Transaction not found</h1><p>${hash}</p><a href="/" style="color:#7c3aed">Back to explorer</a></body></html>`,
			);
		},
	);

	// Wallets/Accounts list page
	app.get<{ Querystring: { page?: string; search?: string } }>(
		"/wallets",
		async (req, reply) => {
			const page = Math.max(1, Number(req.query.page ?? 1));
			const search = req.query.search ?? "";

			// Fetch from compat proxy
			let accountsData: {
				accounts: Array<{ did: string; balance: string; stakedBalance: string; delegatedBalance: string; total: string; totalEnsl: number; label: string; nonce: number; lastActivity: number }>;
				total: number; page: number; pages: number;
			} = { accounts: [], total: 0, page: 1, pages: 0 };

			try {
				const ds = dataSource as { peerUrls?: string[] };
				const baseUrl = ds.peerUrls?.[0] ?? "http://localhost:9000";
				const resp = await fetch(`${baseUrl}/peer/accounts?page=${page}&limit=50&search=${encodeURIComponent(search)}`, {
					signal: AbortSignal.timeout(10000),
				});
				if (resp.ok) accountsData = await resp.json() as typeof accountsData;
			} catch { /* fallback empty */ }

			return reply.type("text/html").send(renderWallets(accountsData, search));
		},
	);

	// Wallets API (JSON)
	app.get<{ Querystring: { page?: string; limit?: string; search?: string } }>(
		"/api/v1/accounts",
		async (req, reply) => {
			const page = Math.max(1, Number(req.query.page ?? 1));
			const limit = Math.min(200, Math.max(1, Number(req.query.limit ?? 50)));
			const search = req.query.search ?? "";

			try {
				const ds = dataSource as { peerUrls?: string[] };
				const baseUrl = ds.peerUrls?.[0] ?? "http://localhost:9000";
				const resp = await fetch(`${baseUrl}/peer/accounts?page=${page}&limit=${limit}&search=${encodeURIComponent(search)}`, {
					signal: AbortSignal.timeout(10000),
				});
				if (resp.ok) return reply.send(await resp.json());
			} catch { /* fallback */ }
			return reply.send({ accounts: [], total: 0, page: 1, pages: 0 });
		},
	);

	// Account/wallet page
	app.get<{ Params: { did: string }; Querystring: { page?: string } }>(
		"/account/:did",
		async (req, reply) => {
			const did = decodeURIComponent(req.params.did);
			const page = Math.max(1, Number(req.query.page ?? 1));
			// Try to get account data from the data source
			const ds = dataSource as { getAccountData?: (did: string) => Promise<Record<string, string> | null> };
			let account: Record<string, string> | null = null;
			if (ds.getAccountData) {
				account = await ds.getAccountData(did);
			}
			const validators = dataSource.getValidators();
			const isValidator = validators.some((v) => v.did === did);
			const validatorData = validators.find((v) => v.did === did);

			// Get transactions for this DID from block cache
			const height = dataSource.getChainHeight();
			const txs: Array<{ hash: string; type: string; from: string; to: string; amount: string; timestamp: number; blockHeight: number }> = [];
			for (let h = Math.max(0, height - 500); h <= height; h++) {
				const block = dataSource.getBlock(h);
				if (!block) continue;
				for (const tx of block.transactions) {
					if (tx.from === did || tx.to === did) {
						txs.push({ ...tx, blockHeight: block.height });
					}
				}
			}
			txs.reverse(); // newest first

			const perPage = 25;
			const totalPages = Math.max(1, Math.ceil(txs.length / perPage));
			const pageTxs = txs.slice((page - 1) * perPage, page * perPage);

			return reply.type("text/html").send(
				renderAccount(did, account, isValidator, validatorData ?? null, pageTxs, txs.length, page, totalPages),
			);
		},
	);

	return app;
}
