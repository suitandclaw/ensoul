import { describe, it, expect, beforeEach } from "vitest";
import { createIdentity } from "@ensoul/identity";
import type { AgentIdentity } from "@ensoul/identity";
import {
	AccountState,
	encodeTxPayload,
	computeTxHash,
	REWARDS_POOL,
	PROTOCOL_TREASURY,
} from "@ensoul/ledger";
import type { Block, Transaction, GenesisConfig } from "@ensoul/ledger";
import {
	WalletManager,
	parseWalletArgs,
	isWalletCommand,
	validateDid,
	shortenDid,
	formatEnsl,
} from "../src/cli/wallet.js";
import { NodeBlockProducer } from "../src/chain/producer.js";

const DECIMALS = 10n ** 18n;

let alice: AgentIdentity;
let bob: AgentIdentity;
let state: AccountState;

beforeEach(async () => {
	alice = await createIdentity({ seed: new Uint8Array(32).fill(10) });
	bob = await createIdentity({ seed: new Uint8Array(32).fill(11) });
	state = new AccountState();
	state.credit(alice.did, 1000n * DECIMALS);
	state.credit(bob.did, 500n * DECIMALS);
});

// ── parseWalletArgs ──────────────────────────────────────────────────

describe("parseWalletArgs", () => {
	it("parses wallet balance", () => {
		const cmd = parseWalletArgs(["wallet", "balance"]);
		expect(cmd.subcommand).toBe("balance");
	});

	it("parses wallet send with recipient and amount", () => {
		const cmd = parseWalletArgs(["wallet", "send", "did:key:z6MkTest", "500"]);
		expect(cmd.subcommand).toBe("send");
		expect(cmd.recipientDid).toBe("did:key:z6MkTest");
		expect(cmd.amount).toBe(500n * DECIMALS);
	});

	it("parses wallet receive", () => {
		const cmd = parseWalletArgs(["wallet", "receive"]);
		expect(cmd.subcommand).toBe("receive");
	});

	it("parses wallet history", () => {
		const cmd = parseWalletArgs(["wallet", "history"]);
		expect(cmd.subcommand).toBe("history");
	});

	it("parses wallet stake with amount", () => {
		const cmd = parseWalletArgs(["wallet", "stake", "200"]);
		expect(cmd.subcommand).toBe("stake");
		expect(cmd.amount).toBe(200n * DECIMALS);
	});

	it("parses wallet unstake with amount", () => {
		const cmd = parseWalletArgs(["wallet", "unstake", "100"]);
		expect(cmd.subcommand).toBe("unstake");
		expect(cmd.amount).toBe(100n * DECIMALS);
	});

	it("parses --data-dir before wallet subcommand", () => {
		const cmd = parseWalletArgs(["--data-dir", "/data/ensoul", "wallet", "balance"]);
		expect(cmd.subcommand).toBe("balance");
		expect(cmd.dataDir).toBe("/data/ensoul");
	});

	it("returns none for empty argv", () => {
		expect(parseWalletArgs([]).subcommand).toBe("none");
	});

	it("returns none when wallet keyword is missing", () => {
		expect(parseWalletArgs(["balance"]).subcommand).toBe("none");
	});
});

describe("isWalletCommand", () => {
	it("returns true when argv contains wallet", () => {
		expect(isWalletCommand(["wallet", "balance"])).toBe(true);
	});

	it("returns false when argv does not contain wallet", () => {
		expect(isWalletCommand(["--validate"])).toBe(false);
	});
});

// ── Formatting helpers ───────────────────────────────────────────────

describe("formatEnsl", () => {
	it("formats zero", () => {
		expect(formatEnsl(0n)).toBe("0.00 ENSL");
	});

	it("formats whole amounts", () => {
		expect(formatEnsl(500n * DECIMALS)).toBe("500.00 ENSL");
	});

	it("formats amounts with commas", () => {
		expect(formatEnsl(1_000_000n * DECIMALS)).toBe("1,000,000.00 ENSL");
	});

	it("formats amounts with fractional ENSL", () => {
		const half = DECIMALS / 2n; // 0.5 ENSL
		expect(formatEnsl(half)).toBe("0.50 ENSL");
	});

	it("formats amounts with small fractions (truncates to 2 decimals)", () => {
		const amount = 100n * DECIMALS + DECIMALS / 100n; // 100.01
		expect(formatEnsl(amount)).toBe("100.01 ENSL");
	});
});

describe("shortenDid", () => {
	it("shortens long DIDs", () => {
		const did = "did:key:z6MkhaXgBZDvotDkL5257faWxcsSqBrdR7g5gqjvroHyMjZ";
		const short = shortenDid(did);
		expect(short).toBe("did:key:z6MkhaXg...MjZ");
	});

	it("keeps short DIDs unchanged", () => {
		const did = "did:key:z6MkShort";
		expect(shortenDid(did)).toBe(did);
	});

	it("handles did:ensoul format", () => {
		const did = "did:ensoul:z6MkhaXgBZDvotDkL5257faWxcsSqBrdR7g5gqjvroHyMjZ";
		const short = shortenDid(did);
		expect(short).toContain("did:ensoul:");
		expect(short).toContain("...");
	});
});

describe("validateDid", () => {
	it("accepts valid DIDs", () => {
		expect(validateDid("did:key:z6MkhaXgBZDvotDkL5257")).toBe(true);
		expect(validateDid("did:ensoul:abcdefghijk")).toBe(true);
	});

	it("rejects invalid DIDs", () => {
		expect(validateDid("not-a-did")).toBe(false);
		expect(validateDid("did:x:y")).toBe(false);
		expect(validateDid("")).toBe(false);
	});
});

// ── WalletManager balance ────────────────────────────────────────────

describe("WalletManager balance", () => {
	it("returns correct available balance", () => {
		const wallet = new WalletManager(alice, state);
		const balance = wallet.getBalance();
		expect(balance.available).toBe(1000n * DECIMALS);
		expect(balance.staked).toBe(0n);
		expect(balance.total).toBe(1000n * DECIMALS);
	});

	it("reflects staked balance separately", () => {
		state.stake(alice.did, 300n * DECIMALS);
		const wallet = new WalletManager(alice, state);
		const balance = wallet.getBalance();
		expect(balance.available).toBe(700n * DECIMALS);
		expect(balance.staked).toBe(300n * DECIMALS);
		expect(balance.total).toBe(1000n * DECIMALS);
	});

	it("formatBalance produces readable output", () => {
		state.stake(alice.did, 200n * DECIMALS);
		const wallet = new WalletManager(alice, state);
		const output = wallet.formatBalance();
		expect(output).toContain("Available:");
		expect(output).toContain("800.00 ENSL");
		expect(output).toContain("Staked:");
		expect(output).toContain("200.00 ENSL");
		expect(output).toContain("Total:");
		expect(output).toContain("1,000.00 ENSL");
	});

	it("returns zero for unknown DID", async () => {
		const unknown = await createIdentity({ seed: new Uint8Array(32).fill(99) });
		const wallet = new WalletManager(unknown, state);
		const balance = wallet.getBalance();
		expect(balance.available).toBe(0n);
		expect(balance.total).toBe(0n);
	});
});

// ── WalletManager send ───────────────────────────────────────────────

describe("WalletManager send", () => {
	it("builds a valid signed transfer transaction", async () => {
		const wallet = new WalletManager(alice, state);
		const tx = await wallet.buildTransaction("transfer", bob.did, 100n * DECIMALS);

		expect(tx.type).toBe("transfer");
		expect(tx.from).toBe(alice.did);
		expect(tx.to).toBe(bob.did);
		expect(tx.amount).toBe(100n * DECIMALS);
		expect(tx.nonce).toBe(0);
		expect(tx.signature.length).toBe(64);
	});

	it("transaction signature is verifiable", async () => {
		const wallet = new WalletManager(alice, state);
		const tx = await wallet.buildTransaction("transfer", bob.did, 50n * DECIMALS);

		const payload = encodeTxPayload(tx);
		const valid = await alice.verify(payload, tx.signature);
		expect(valid).toBe(true);
	});

	it("formatSendConfirmation produces correct prompt", () => {
		const wallet = new WalletManager(alice, state);
		const prompt = wallet.formatSendConfirmation(bob.did, 500n * DECIMALS);
		expect(prompt).toContain("500.00 ENSL");
		expect(prompt).toContain("(y/n)");
		// Bob's DID should be shortened
		expect(prompt).toContain("...");
	});

	it("uses correct nonce from account state", async () => {
		state.incrementNonce(alice.did);
		state.incrementNonce(alice.did);
		const wallet = new WalletManager(alice, state);
		const tx = await wallet.buildTransaction("transfer", bob.did, 10n * DECIMALS);
		expect(tx.nonce).toBe(2);
	});

	it("computeTxHash produces a hash for the built transaction", async () => {
		const wallet = new WalletManager(alice, state);
		const tx = await wallet.buildTransaction("transfer", bob.did, 10n * DECIMALS);
		const hash = computeTxHash(tx);
		expect(hash.length).toBe(64);
	});
});

// ── WalletManager receive ────────────────────────────────────────────

describe("WalletManager receive", () => {
	it("formatReceive shows the full DID", () => {
		const wallet = new WalletManager(alice, state);
		const output = wallet.formatReceive();
		expect(output).toContain(alice.did);
		expect(output).toContain("Send $ENSL to:");
	});

	it("getDid returns the identity DID", () => {
		const wallet = new WalletManager(alice, state);
		expect(wallet.getDid()).toBe(alice.did);
	});
});

// ── WalletManager history ────────────────────────────────────────────

describe("WalletManager history", () => {
	function makeBlock(
		height: number,
		transactions: Transaction[],
	): Block {
		return {
			height,
			previousHash: "0".repeat(64),
			stateRoot: "0".repeat(64),
			transactionsRoot: "0".repeat(64),
			timestamp: 1700000000000 + height * 6000,
			proposer: "did:test:validator",
			transactions,
			attestations: [],
		};
	}

	async function makeTx(
		from: AgentIdentity,
		to: string,
		amount: bigint,
		type: Transaction["type"] = "transfer",
		nonce = 0,
	): Promise<Transaction> {
		const partial = {
			type, from: from.did, to, amount, nonce,
			timestamp: Date.now(),
		};
		const payload = encodeTxPayload(partial as Transaction);
		const signature = await from.sign(payload);
		return { ...partial, signature } as Transaction;
	}

	it("returns transactions involving the wallet identity", async () => {
		const tx1 = await makeTx(alice, bob.did, 50n * DECIMALS);
		const tx2 = await makeTx(bob, alice.did, 20n * DECIMALS, "transfer", 0);
		const blocks = [
			makeBlock(1, [tx1]),
			makeBlock(2, [tx2]),
		];

		const wallet = new WalletManager(alice, state, blocks);
		const history = wallet.getHistory();

		expect(history.length).toBe(2);
		// Most recent first (block 2 before block 1)
		expect(history[0]?.type).toBe("received");
		expect(history[1]?.type).toBe("sent");
	});

	it("classifies stake and unstake transactions", async () => {
		const stakeTx = await makeTx(alice, alice.did, 100n * DECIMALS, "stake");
		const unstakeTx = await makeTx(alice, alice.did, 50n * DECIMALS, "unstake", 1);
		const blocks = [
			makeBlock(1, [stakeTx]),
			makeBlock(2, [unstakeTx]),
		];

		const wallet = new WalletManager(alice, state, blocks);
		const history = wallet.getHistory();

		expect(history[0]?.type).toBe("unstaked");
		expect(history[1]?.type).toBe("staked");
	});

	it("limits history to N entries", async () => {
		const txs: Transaction[] = [];
		for (let i = 0; i < 30; i++) {
			txs.push(await makeTx(alice, bob.did, 1n * DECIMALS, "transfer", i));
		}
		const blocks = [makeBlock(1, txs)];

		const wallet = new WalletManager(alice, state, blocks);
		expect(wallet.getHistory(5).length).toBe(5);
		expect(wallet.getHistory(20).length).toBe(20);
	});

	it("returns empty history when no transactions", () => {
		const wallet = new WalletManager(alice, state, []);
		expect(wallet.getHistory().length).toBe(0);
	});

	it("formatHistory produces readable table", async () => {
		const tx = await makeTx(alice, bob.did, 100n * DECIMALS);
		const blocks = [makeBlock(42, [tx])];

		const wallet = new WalletManager(alice, state, blocks);
		const output = wallet.formatHistory();
		expect(output).toContain("42");
		expect(output).toContain("sent");
		expect(output).toContain("100.00 ENSL");
		expect(output).toContain("Block");
		expect(output).toContain("Type");
	});

	it("formatHistory shows message when no transactions", () => {
		const wallet = new WalletManager(alice, state, []);
		expect(wallet.formatHistory()).toContain("No transactions found");
	});

	it("ignores transactions not involving this identity", async () => {
		const charlie = await createIdentity({ seed: new Uint8Array(32).fill(12) });
		const tx = await makeTx(bob, charlie.did, 10n * DECIMALS, "transfer", 0);
		const blocks = [makeBlock(1, [tx])];

		const wallet = new WalletManager(alice, state, blocks);
		expect(wallet.getHistory().length).toBe(0);
	});
});

// ── WalletManager stake/unstake ──────────────────────────────────────

describe("WalletManager stake/unstake", () => {
	it("builds a signed stake transaction", async () => {
		const wallet = new WalletManager(alice, state);
		const tx = await wallet.buildTransaction("stake", alice.did, 200n * DECIMALS);

		expect(tx.type).toBe("stake");
		expect(tx.from).toBe(alice.did);
		expect(tx.to).toBe(alice.did);
		expect(tx.amount).toBe(200n * DECIMALS);
		expect(tx.signature.length).toBe(64);
	});

	it("builds a signed unstake transaction", async () => {
		state.stake(alice.did, 300n * DECIMALS);
		const wallet = new WalletManager(alice, state);
		const tx = await wallet.buildTransaction("unstake", alice.did, 100n * DECIMALS);

		expect(tx.type).toBe("unstake");
		expect(tx.amount).toBe(100n * DECIMALS);
	});

	it("stake transaction integrates with NodeBlockProducer", async () => {
		const genesis: GenesisConfig = {
			chainId: "ensoul-test",
			timestamp: 1700000000000,
			totalSupply: 1000n * DECIMALS,
			allocations: [
				{ label: "Foundation", percentage: 15, tokens: 150n * DECIMALS, recipient: "did:test:foundation" },
				{ label: "Rewards", percentage: 50, tokens: 500n * DECIMALS, recipient: REWARDS_POOL },
				{ label: "Treasury", percentage: 10, tokens: 100n * DECIMALS, recipient: PROTOCOL_TREASURY },
				{ label: "Onboarding", percentage: 10, tokens: 100n * DECIMALS, recipient: "did:test:onboarding" },
				{ label: "Liquidity", percentage: 5, tokens: 50n * DECIMALS, recipient: "did:test:liquidity" },
				{ label: "Contributors", percentage: 5, tokens: 50n * DECIMALS, recipient: "did:test:contributors" },
				{ label: "Insurance", percentage: 5, tokens: 50n * DECIMALS, recipient: "did:test:insurance" },
			],
			emissionPerBlock: 1n * DECIMALS,
			networkRewardsPool: 500n * DECIMALS,
			protocolFees: { storageFeeProtocolShare: 10, txBaseFee: 1000n },
		};

		const producer = new NodeBlockProducer(genesis);
		producer.initGenesis([alice.did, bob.did]);
		producer.getState().credit(alice.did, 500n * DECIMALS);

		// Build stake tx using wallet
		const wallet = new WalletManager(alice, producer.getState());
		const stakeTx = await wallet.buildTransaction("stake", alice.did, 200n * DECIMALS);

		producer.submitTransaction(stakeTx);
		const block = producer.produceBlock(bob.did);
		expect(block).not.toBeNull();
		expect(block!.transactions.length).toBe(1);

		const account = producer.getState().getAccount(alice.did);
		expect(account.balance).toBe(300n * DECIMALS);
		expect(account.stakedBalance).toBe(200n * DECIMALS);
	});
});
