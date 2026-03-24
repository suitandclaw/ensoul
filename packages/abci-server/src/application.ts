/**
 * ABCI 2.0 Application -- stub implementation.
 *
 * This is the application-level handler for CometBFT's ABCI protocol.
 * Each method corresponds to a CometBFT ABCI call. The stubs log
 * and return OK so CometBFT can produce blocks.
 *
 * Methods will be filled in with real Ensoul logic:
 * - InitChain: genesis allocations, validator set
 * - CheckTx: transaction validation
 * - FinalizeBlock: transaction execution, emission
 * - Commit: state persistence
 * - Query: balance/agent queries
 */

import type protobuf from "protobufjs";

function log(msg: string): void {
	const ts = new Date().toISOString().slice(11, 19);
	process.stdout.write(`[${ts}] [abci] ${msg}\n`);
}

/** Application state tracking. */
interface AppState {
	height: number;
	appHash: Buffer;
}

/**
 * Create an ABCI request handler that dispatches to application methods.
 */
export function createApplication(): {
	handler: (request: protobuf.Message, field: string) => Promise<Record<string, unknown>>;
	state: AppState;
} {
	const state: AppState = {
		height: 0,
		appHash: Buffer.alloc(32),
	};

	async function handler(
		_request: protobuf.Message,
		field: string,
	): Promise<Record<string, unknown>> {
		switch (field) {
			case "echo":
				return handleEcho(_request);
			case "flush":
				return handleFlush();
			case "info":
				return handleInfo(state);
			case "initChain":
				return handleInitChain(_request, state);
			case "checkTx":
				return handleCheckTx(_request);
			case "query":
				return handleQuery(_request);
			case "commit":
				return handleCommit(state);
			case "listSnapshots":
				return { listSnapshots: {} };
			case "offerSnapshot":
				return { offerSnapshot: { result: 0 } };
			case "loadSnapshotChunk":
				return { loadSnapshotChunk: { chunk: Buffer.alloc(0) } };
			case "applySnapshotChunk":
				return { applySnapshotChunk: { result: 0 } };
			case "prepareProposal":
				return handlePrepareProposal(_request);
			case "processProposal":
				return handleProcessProposal();
			case "finalizeBlock":
				return handleFinalizeBlock(_request, state);
			case "extendVote":
				return { extendVote: { voteExtension: Buffer.alloc(0) } };
			case "verifyVoteExtension":
				return { verifyVoteExtension: { status: 1 } }; // ACCEPT
			default:
				log(`Unknown ABCI method: ${field}`);
				return { exception: { error: `Unknown method: ${field}` } };
		}
	}

	return { handler, state };
}

// -- Individual ABCI method handlers --

function handleEcho(request: protobuf.Message): Record<string, unknown> {
	const req = request as unknown as { echo?: { message?: string } };
	return { echo: { message: req.echo?.message ?? "" } };
}

function handleFlush(): Record<string, unknown> {
	return { flush: {} };
}

function handleInfo(state: AppState): Record<string, unknown> {
	log(`Info: height=${state.height}`);
	return {
		info: {
			data: "ensoul",
			version: "0.1.0",
			appVersion: 1,
			lastBlockHeight: state.height,
			lastBlockAppHash: state.appHash,
		},
	};
}

function handleInitChain(
	request: protobuf.Message,
	state: AppState,
): Record<string, unknown> {
	const req = request as unknown as {
		initChain?: {
			chainId?: string;
			validators?: Array<{ pubKey?: { ed25519?: Buffer }; power?: number }>;
			appStateBytes?: Buffer;
		};
	};
	const chainId = req.initChain?.chainId ?? "unknown";
	const validatorCount = req.initChain?.validators?.length ?? 0;
	const appStateBytes = req.initChain?.appStateBytes;

	log(`InitChain: chainId=${chainId} validators=${validatorCount}`);

	if (appStateBytes && appStateBytes.length > 0) {
		try {
			const appState = JSON.parse(appStateBytes.toString("utf-8")) as Record<string, unknown>;
			log(`  app_state keys: ${Object.keys(appState).join(", ")}`);
		} catch {
			log(`  app_state: ${appStateBytes.length} bytes (not JSON)`);
		}
	}

	// TODO: Process genesis allocations from app_state
	// TODO: Return initial validator set

	state.height = 0;
	state.appHash = Buffer.alloc(32); // Will be real state root

	return {
		initChain: {
			appHash: state.appHash,
		},
	};
}

function handleCheckTx(request: protobuf.Message): Record<string, unknown> {
	const req = request as unknown as {
		checkTx?: { tx?: Buffer; type?: number };
	};
	const txBytes = req.checkTx?.tx;
	const txType = req.checkTx?.type ?? 0; // 0 = NEW, 1 = RECHECK

	if (txBytes) {
		log(`CheckTx: ${txBytes.length} bytes (type=${txType === 0 ? "NEW" : "RECHECK"})`);
	}

	// TODO: Decode and validate transaction against current state
	// For now, accept all transactions
	return {
		checkTx: {
			code: 0,
			log: "ok",
			gasWanted: 1,
			gasUsed: 1,
		},
	};
}

function handleQuery(request: protobuf.Message): Record<string, unknown> {
	const req = request as unknown as {
		query?: { path?: string; data?: Buffer; height?: number };
	};
	const path = req.query?.path ?? "";

	log(`Query: path=${path}`);

	// TODO: Handle query paths (balance, agent, validator info)
	return {
		query: {
			code: 0,
			log: "ok",
			key: Buffer.alloc(0),
			value: Buffer.from(JSON.stringify({ status: "ok" })),
		},
	};
}

function handlePrepareProposal(request: protobuf.Message): Record<string, unknown> {
	const req = request as unknown as {
		prepareProposal?: { txs?: Buffer[]; maxTxBytes?: number };
	};
	const txs = req.prepareProposal?.txs ?? [];

	log(`PrepareProposal: ${txs.length} candidate txs`);

	// TODO: Order transactions, add block_reward tx, enforce limits
	// For now, pass through all transactions
	return {
		prepareProposal: {
			txs,
		},
	};
}

function handleProcessProposal(): Record<string, unknown> {
	// TODO: Validate the proposed block (tx validity, reward correctness)
	// For now, accept all proposals
	return {
		processProposal: {
			status: 1, // ACCEPT
		},
	};
}

function handleFinalizeBlock(
	request: protobuf.Message,
	state: AppState,
): Record<string, unknown> {
	const req = request as unknown as {
		finalizeBlock?: {
			txs?: Buffer[];
			height?: number;
			time?: { seconds?: number; nanos?: number };
			proposerAddress?: Buffer;
		};
	};
	const txs = req.finalizeBlock?.txs ?? [];
	const height = Number(req.finalizeBlock?.height ?? state.height + 1);

	log(`FinalizeBlock: height=${height} txs=${txs.length}`);

	// TODO: Execute all transactions
	// TODO: Compute block reward and emission
	// TODO: Update account state
	// TODO: Return validator updates for consensus_join/leave

	state.height = height;
	// TODO: Compute real app_hash from account state root
	state.appHash = Buffer.alloc(32);

	// Build per-tx results (all OK for now)
	const txResults = txs.map(() => ({
		code: 0,
		log: "ok",
	}));

	return {
		finalizeBlock: {
			txResults,
			appHash: state.appHash,
		},
	};
}

function handleCommit(state: AppState): Record<string, unknown> {
	log(`Commit: height=${state.height}`);

	// TODO: Persist state to disk
	// TODO: Update CheckTx state copy

	return {
		commit: {
			retainHeight: 0,
		},
	};
}
