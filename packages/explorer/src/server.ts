import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { hashTrustAssessment, assessTrust } from "@ensoul/node";
import type { ExplorerDataSource } from "./types.js";
import {
	renderDashboard,
	renderAgentProfile,
	renderAgentSearch,
	renderBlock,
	renderBlockList,
	renderValidators,
	renderAccount,
	renderTransaction,
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

	app.get("/blocks", async (_req, reply) => {
		const height = dataSource.getChainHeight();
		const blocks = dataSource.getBlocks(
			Math.max(0, height - 19),
			height,
		);
		return reply
			.type("text/html")
			.send(renderBlockList(blocks.reverse()));
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
