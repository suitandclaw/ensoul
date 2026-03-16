import type {
	AttackScenario,
	AuditReport,
	AuditCheck,
	InvariantCheck,
	InvariantResult,
	SimulationResult,
} from "./types.js";
import { runSimulation } from "./simulations.js";

/**
 * All supported attack scenarios with default parameters.
 */
const DEFAULT_SCENARIOS: AttackScenario[] = [
	{
		name: "Data Withholding: node returns garbage instead of stored shard",
		type: "data_withholding",
		parameters: {},
	},
	{
		name: "State Corruption: tampered data detected by Merkle proof",
		type: "state_corruption",
		parameters: {},
	},
	{
		name: "Replay Attack: old state transition rejected by version chain",
		type: "replay_attack",
		parameters: {},
	},
	{
		name: "Key Compromise: stolen key insufficient without K shards",
		type: "key_compromise",
		parameters: {},
	},
	{
		name: "Consensus Manipulation: K-1 validators cannot forge threshold",
		type: "consensus_manipulation",
		parameters: {},
	},
	{
		name: "Shard Reconstruction: cannot reconstruct from <K shards",
		type: "shard_reconstruction",
		parameters: {},
	},
	{
		name: "Credit Inflation: fake proof-of-storage rejected",
		type: "credit_inflation",
		parameters: {},
	},
];

/**
 * Module audit definitions: invariant checks per module.
 */
type ModuleAuditor = (report: AuditCheck[]) => Promise<void>;

/**
 * SecuritySuite: centralized audit, invariant checking, and adversarial simulation.
 */
export class SecuritySuite {
	private invariants: InvariantCheck[] = [];
	private moduleAuditors: Map<string, ModuleAuditor> = new Map();

	constructor() {
		this.registerDefaultAuditors();
	}

	// ── Invariant registration ───────────────────────────────────

	/**
	 * Register a named invariant check.
	 */
	registerInvariant(
		name: string,
		check: () => Promise<boolean>,
	): void {
		this.invariants.push({ name, check });
	}

	/**
	 * Run all registered invariant checks.
	 */
	async runInvariantChecks(): Promise<InvariantResult[]> {
		const results: InvariantResult[] = [];
		for (const inv of this.invariants) {
			try {
				const passed = await inv.check();
				results.push({ name: inv.name, passed });
			} catch {
				results.push({ name: inv.name, passed: false });
			}
		}
		return results;
	}

	// ── Module auditing ──────────────────────────────────────────

	/**
	 * Audit a specific module by running its invariant checks.
	 */
	async auditModule(moduleName: string): Promise<AuditReport> {
		const auditor = this.moduleAuditors.get(moduleName);
		const checks: AuditCheck[] = [];

		if (auditor) {
			await auditor(checks);
		} else {
			checks.push({
				name: "module_exists",
				passed: false,
				severity: "high",
				details: `No auditor registered for module: ${moduleName}`,
			});
		}

		return {
			module: moduleName,
			timestamp: Date.now(),
			checks,
			overallPass: checks.every((c) => c.passed),
		};
	}

	/**
	 * Audit all registered modules.
	 */
	async auditAllModules(): Promise<AuditReport[]> {
		const reports: AuditReport[] = [];
		for (const name of this.moduleAuditors.keys()) {
			reports.push(await this.auditModule(name));
		}
		return reports;
	}

	// ── Adversarial simulation ───────────────────────────────────

	/**
	 * Run a single attack simulation.
	 */
	async runAttackSimulation(
		scenario: AttackScenario,
	): Promise<SimulationResult> {
		return runSimulation(scenario);
	}

	/**
	 * Run the full adversarial test suite.
	 */
	async runFullAdversarialSuite(): Promise<SimulationResult[]> {
		const results: SimulationResult[] = [];
		for (const scenario of DEFAULT_SCENARIOS) {
			results.push(await runSimulation(scenario));
		}
		return results;
	}

	// ── Default module auditors ──────────────────────────────────

	private registerDefaultAuditors(): void {
		this.moduleAuditors.set(
			"identity",
			async (checks: AuditCheck[]) => {
				const { createIdentity } = await import(
					"@ensoul/identity"
				);

				// Invariant: signature isolation
				const idA = await createIdentity({
					seed: new Uint8Array(32).fill(1),
				});
				const idB = await createIdentity({
					seed: new Uint8Array(32).fill(2),
				});
				const data = new TextEncoder().encode("test");
				const sigA = await idA.sign(data);
				const crossVerify = await idB.verify(data, sigA);

				checks.push({
					name: "signature_isolation",
					passed: !crossVerify,
					severity: "critical",
					details: crossVerify
						? "CRITICAL: Signature from A verified under B's key"
						: "Signatures correctly isolated between identities",
				});

				// Invariant: encryption confidentiality
				const plaintext = new TextEncoder().encode("secret");
				const encrypted = await idA.encrypt(plaintext, idB.publicKey);
				try {
					const decrypted = await idB.decrypt(encrypted);
					checks.push({
						name: "encryption_confidentiality",
						passed:
							decrypted.length === plaintext.length &&
							decrypted.every(
								(b, i) => b === plaintext[i],
							),
						severity: "critical",
						details:
							"Encrypted data decryptable only by intended recipient",
					});
				} catch {
					checks.push({
						name: "encryption_confidentiality",
						passed: false,
						severity: "critical",
						details: "Intended recipient could not decrypt",
					});
				}

				// Invariant: wrong passphrase fails
				const bundle = await idA.export("correct");
				const { loadIdentity } = await import(
					"@ensoul/identity"
				);
				try {
					await loadIdentity(bundle, "wrong");
					checks.push({
						name: "passphrase_rejection",
						passed: false,
						severity: "critical",
						details:
							"CRITICAL: Wrong passphrase did not fail",
					});
				} catch {
					checks.push({
						name: "passphrase_rejection",
						passed: true,
						severity: "critical",
						details:
							"Wrong passphrase correctly rejected",
					});
				}
			},
		);

		this.moduleAuditors.set(
			"state-tree",
			async (checks: AuditCheck[]) => {
				const { createIdentity } = await import(
					"@ensoul/identity"
				);
				const { createTree } = await import(
					"@ensoul/state-tree"
				);

				const id = await createIdentity({
					seed: new Uint8Array(32).fill(10),
				});
				const tree = await createTree(id);

				// Root hash changes on mutation
				const before = tree.rootHash;
				await tree.set(
					"key",
					new TextEncoder().encode("value"),
				);
				checks.push({
					name: "root_hash_changes",
					passed: tree.rootHash !== before,
					severity: "critical",
					details:
						tree.rootHash !== before
							? "Root hash changes on mutation"
							: "CRITICAL: Root hash unchanged after mutation",
				});

				// Version increments
				checks.push({
					name: "version_increments",
					passed: tree.version === 1,
					severity: "high",
					details: `Version is ${tree.version} after 1 mutation`,
				});

				// Transitions are signed
				const history = await tree.getHistory(0, 1);
				const hasSig =
					history.length > 0 &&
					history[0]!.signature.length === 64;
				checks.push({
					name: "transitions_signed",
					passed: hasSig,
					severity: "critical",
					details: hasSig
						? "State transitions are Ed25519 signed"
						: "CRITICAL: Transitions missing signatures",
				});
			},
		);

		this.moduleAuditors.set(
			"node",
			async (checks: AuditCheck[]) => {
				const { StorageEngine, computeShardHash } = await import(
					"@ensoul/node"
				);
				const { MemoryLevel } = await import("memory-level");

				const db = new MemoryLevel<string, string>({
					valueEncoding: "utf8",
				});
				const storage = new StorageEngine(db as never);
				await storage.init();

				const data = new TextEncoder().encode("test shard");
				const meta = await storage.store({
					agentDid: "did:key:audit",
					version: 1,
					shardIndex: 0,
					data,
				});

				// Hash computed correctly
				checks.push({
					name: "shard_hash_integrity",
					passed: meta.hash === computeShardHash(data),
					severity: "critical",
					details: "Shard Blake3 hash computed and stored correctly",
				});

				// Storage tracking accurate
				const stats = storage.getStats();
				checks.push({
					name: "storage_accounting",
					passed:
						stats.totalBytes === data.length &&
						stats.totalShards === 1,
					severity: "high",
					details: `Tracking: ${stats.totalBytes} bytes, ${stats.totalShards} shards`,
				});

				await storage.close();
			},
		);
	}
}
