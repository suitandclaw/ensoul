/**
 * Ensoul Delegation Engine
 *
 * Manages tiered validator delegations with sybil resistance.
 *
 * Tiers:
 *   Foundation (Tier 1): 2M ENSL, manual, JD's validators
 *   Pioneer (Tier 2): 1M ENSL, application + approval, 20 slots
 *   Open (Tier 3): probationary (10K -> 50K -> 100K over 30 days)
 *
 * Sybil resistance:
 *   ASN limit (3 per autonomous system)
 *   Daily registration cap (5 per day)
 *   Treasury floor (pause if below 10M ENSL)
 *   Consciousness requirement (agent activity after 30 days)
 *   Contact uniqueness (3 validators per contact)
 *
 * Research basis:
 *   Cosmos Hub: Foundation Delegation Program with uptime requirements
 *   Solana: Foundation Delegation with performance scoring
 *   Polkadot: Thousand Validators Programme with geographic distribution
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const DATA_DIR = join(homedir(), ".ensoul");
const STATE_FILE = join(DATA_DIR, "delegation-state.json");
const LOG_FILE = join(DATA_DIR, "delegation-engine.log");

// ── Constants ───────────────────────────────────────────────────────

export const PIONEER_SLOTS = 20;
export const PIONEER_DELEGATION = 1_000_000n * 10n ** 18n; // 1M ENSL
export const OPEN_INITIAL = 10_000n * 10n ** 18n; // 10K ENSL
export const OPEN_7DAY = 50_000n * 10n ** 18n; // 50K ENSL
export const OPEN_30DAY = 100_000n * 10n ** 18n; // 100K ENSL
export const DAILY_OPEN_CAP = 5;
export const ASN_LIMIT = 3;
export const CONTACT_LIMIT = 3;
export const TREASURY_FLOOR = 10_000_000n * 10n ** 18n; // 10M ENSL
export const UPTIME_THRESHOLD = 95; // % for upgrades
export const UPTIME_REVOKE_THRESHOLD = 80; // % for revocation
export const CONSCIOUSNESS_GRACE_DAYS = 14; // days without agent activity before delegation reduction

// ── Types ───────────────────────────────────────────────────────────

export type Tier = "foundation" | "pioneer" | "open";
export type ProbationStage = "initial" | "7day" | "30day" | "full";
export type ApplicationStatus = "pending" | "approved" | "rejected";

export interface PioneerApplication {
	id: string;
	validatorAddress: string;
	did: string;
	operatorName: string;
	operatorEmail: string;
	operatorTwitter: string;
	description: string;
	motivation: string;
	submittedAt: number;
	status: ApplicationStatus;
	reviewedAt?: number;
	rejectionReason?: string;
	ip?: string;
}

export interface ValidatorDelegation {
	did: string;
	tier: Tier;
	stage: ProbationStage;
	delegatedAmount: string; // wei string
	operatorContact: string;
	ip: string;
	asn: string;
	registeredAt: number;
	lastUptimeCheck: number;
	uptimePercent: number;
	lastConsciousnessActivity: number; // timestamp of last agent consciousness write
	probation7dayAt?: number; // when 7-day probation started
	probation30dayAt?: number; // when 30-day probation started
	revokedAt?: number;
	revokeReason?: string;
}

export interface DelegationState {
	pioneers: PioneerApplication[];
	delegations: ValidatorDelegation[];
	dailyOpenCount: number;
	dailyOpenDate: string; // ISO date
	delegationLog: Array<{
		timestamp: number;
		did: string;
		amount: string;
		tier: Tier;
		action: "delegate" | "upgrade" | "revoke";
		reason: string;
	}>;
}

// ── State Management ────────────────────────────────────────────────

let state: DelegationState = {
	pioneers: [],
	delegations: [],
	dailyOpenCount: 0,
	dailyOpenDate: new Date().toISOString().slice(0, 10),
	delegationLog: [],
};

async function log(msg: string): Promise<void> {
	const ts = new Date().toISOString().slice(0, 19);
	const line = `[${ts}] ${msg}\n`;
	process.stdout.write(line);
	try { await writeFile(LOG_FILE, line, { flag: "a" }); } catch { /* non-fatal */ }
}

export async function loadState(): Promise<void> {
	try {
		if (existsSync(STATE_FILE)) {
			const raw = await readFile(STATE_FILE, "utf-8");
			state = JSON.parse(raw) as DelegationState;
			await log(`Loaded delegation state: ${state.pioneers.length} applications, ${state.delegations.length} delegations`);
		}
	} catch {
		await log("No existing delegation state, starting fresh");
	}
}

export async function saveState(): Promise<void> {
	await mkdir(DATA_DIR, { recursive: true });
	await writeFile(STATE_FILE, JSON.stringify(state, null, 2));
}

export function getState(): DelegationState {
	return state;
}

// ── ASN Lookup ──────────────────────────────────────────────────────

export async function lookupASN(ip: string): Promise<string> {
	try {
		const resp = await fetch(`http://ip-api.com/json/${ip}?fields=as`, {
			signal: AbortSignal.timeout(5000),
		});
		const data = (await resp.json()) as { as?: string };
		return data.as ?? "unknown";
	} catch {
		return "unknown";
	}
}

function countValidatorsOnASN(asn: string): number {
	if (asn === "unknown") return 0;
	return state.delegations.filter(d => d.asn === asn && !d.revokedAt).length;
}

function countValidatorsForContact(contact: string): number {
	const normalized = contact.toLowerCase().trim();
	return state.delegations.filter(d =>
		d.operatorContact.toLowerCase().trim() === normalized && !d.revokedAt,
	).length;
}

// ── Daily Cap ───────────────────────────────────────────────────────

function checkDailyCap(): boolean {
	const today = new Date().toISOString().slice(0, 10);
	if (state.dailyOpenDate !== today) {
		state.dailyOpenDate = today;
		state.dailyOpenCount = 0;
	}
	return state.dailyOpenCount < DAILY_OPEN_CAP;
}

function incrementDailyCap(): void {
	state.dailyOpenCount++;
}

// ── Pioneer Applications ────────────────────────────────────────────

export async function submitPioneerApplication(app: Omit<PioneerApplication, "id" | "submittedAt" | "status">): Promise<{ id: string; error?: string }> {
	// Check slots
	const approvedCount = state.pioneers.filter(p => p.status === "approved").length;
	if (approvedCount >= PIONEER_SLOTS) {
		return { id: "", error: `All ${PIONEER_SLOTS} pioneer slots are filled` };
	}

	// Check for duplicate
	const existing = state.pioneers.find(p => p.did === app.did && p.status !== "rejected");
	if (existing) {
		return { id: "", error: "Application already submitted for this DID" };
	}

	const id = `pioneer-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	const application: PioneerApplication = {
		...app,
		id,
		submittedAt: Date.now(),
		status: "pending",
	};

	state.pioneers.push(application);
	await saveState();
	await log(`Pioneer application submitted: ${app.operatorName} (${app.did.slice(0, 30)}...)`);

	return { id };
}

export function getPendingApplications(): PioneerApplication[] {
	return state.pioneers.filter(p => p.status === "pending");
}

export function getApplication(id: string): PioneerApplication | undefined {
	return state.pioneers.find(p => p.id === id);
}

export async function approveApplication(id: string): Promise<{ error?: string }> {
	const app = state.pioneers.find(p => p.id === id);
	if (!app) return { error: "Application not found" };
	if (app.status !== "pending") return { error: `Application is already ${app.status}` };

	app.status = "approved";
	app.reviewedAt = Date.now();

	// Create delegation record
	state.delegations.push({
		did: app.did,
		tier: "pioneer",
		stage: "full",
		delegatedAmount: PIONEER_DELEGATION.toString(),
		operatorContact: app.operatorEmail,
		ip: app.ip ?? "",
		asn: "",
		registeredAt: Date.now(),
		lastUptimeCheck: 0,
		uptimePercent: 100,
		lastConsciousnessActivity: 0,
	});

	state.delegationLog.push({
		timestamp: Date.now(),
		did: app.did,
		amount: PIONEER_DELEGATION.toString(),
		tier: "pioneer",
		action: "delegate",
		reason: `Pioneer application approved: ${app.operatorName}`,
	});

	await saveState();
	await log(`Pioneer approved: ${app.operatorName} (${app.did.slice(0, 30)}...) for 1M ENSL`);
	return {};
}

export async function rejectApplication(id: string, reason: string): Promise<{ error?: string }> {
	const app = state.pioneers.find(p => p.id === id);
	if (!app) return { error: "Application not found" };
	if (app.status !== "pending") return { error: `Application is already ${app.status}` };

	app.status = "rejected";
	app.reviewedAt = Date.now();
	app.rejectionReason = reason;

	await saveState();
	await log(`Pioneer rejected: ${app.operatorName} reason: ${reason}`);
	return {};
}

// ── Open Tier Registration ──────────────────────────────────────────

export interface OpenRegistrationResult {
	registered: boolean;
	delegatedAmount: string;
	stage: ProbationStage;
	error?: string;
}

export async function registerOpenValidator(
	did: string,
	operatorContact: string,
	ip: string,
	treasuryBalance: bigint,
): Promise<OpenRegistrationResult> {
	// Treasury floor check
	if (treasuryBalance < TREASURY_FLOOR) {
		return { registered: false, delegatedAmount: "0", stage: "initial", error: "Open-tier delegation paused: treasury below 10M ENSL floor" };
	}

	// Daily cap
	if (!checkDailyCap()) {
		return { registered: false, delegatedAmount: "0", stage: "initial", error: "Daily registration limit reached (5 per day). Try again tomorrow." };
	}

	// Duplicate check
	const existing = state.delegations.find(d => d.did === did && !d.revokedAt);
	if (existing) {
		return { registered: false, delegatedAmount: existing.delegatedAmount, stage: existing.stage, error: "Validator already registered" };
	}

	// ASN check
	const asn = await lookupASN(ip);
	if (asn !== "unknown" && countValidatorsOnASN(asn) >= ASN_LIMIT) {
		return { registered: false, delegatedAmount: "0", stage: "initial", error: `ASN limit reached: ${ASN_LIMIT} validators already on ${asn}` };
	}

	// Contact uniqueness
	if (countValidatorsForContact(operatorContact) >= CONTACT_LIMIT) {
		return { registered: false, delegatedAmount: "0", stage: "initial", error: `Contact limit reached: ${CONTACT_LIMIT} validators per contact` };
	}

	// Register
	incrementDailyCap();

	state.delegations.push({
		did,
		tier: "open",
		stage: "initial",
		delegatedAmount: OPEN_INITIAL.toString(),
		operatorContact,
		ip,
		asn,
		registeredAt: Date.now(),
		lastUptimeCheck: Date.now(),
		uptimePercent: 100,
		lastConsciousnessActivity: 0,
		probation7dayAt: Date.now(),
	});

	state.delegationLog.push({
		timestamp: Date.now(),
		did,
		amount: OPEN_INITIAL.toString(),
		tier: "open",
		action: "delegate",
		reason: "Open-tier initial delegation (probation start)",
	});

	await saveState();
	await log(`Open validator registered: ${did.slice(0, 30)}... on ${asn}, 10K ENSL initial`);

	return { registered: true, delegatedAmount: OPEN_INITIAL.toString(), stage: "initial" };
}

// ── Delegation Audit (Daily Job) ────────────────────────────────────

export interface AuditResult {
	upgraded: string[];
	revoked: string[];
	warnings: string[];
}

export async function runDelegationAudit(
	getUptime: (did: string) => Promise<number>,
	hasRecentConsciousness: (did: string) => Promise<boolean>,
): Promise<AuditResult> {
	const result: AuditResult = { upgraded: [], revoked: [], warnings: [] };
	const now = Date.now();
	const DAY = 86400000;

	for (const d of state.delegations) {
		if (d.revokedAt) continue;
		if (d.tier !== "open") continue;

		// Check uptime
		const uptime = await getUptime(d.did);
		d.uptimePercent = uptime;
		d.lastUptimeCheck = now;

		// Revocation: uptime below 80%
		if (uptime < UPTIME_REVOKE_THRESHOLD && d.stage !== "initial") {
			d.revokedAt = now;
			d.revokeReason = `Uptime ${uptime.toFixed(1)}% below ${UPTIME_REVOKE_THRESHOLD}% threshold`;
			state.delegationLog.push({
				timestamp: now, did: d.did, amount: d.delegatedAmount,
				tier: "open", action: "revoke", reason: d.revokeReason,
			});
			result.revoked.push(`${d.did.slice(0, 24)}... revoked: uptime ${uptime.toFixed(1)}%`);
			continue;
		}

		// Upgrade: initial -> 7day (after 7 days with 95%+ uptime)
		if (d.stage === "initial" && d.probation7dayAt) {
			const elapsed = now - d.probation7dayAt;
			if (elapsed >= 7 * DAY && uptime >= UPTIME_THRESHOLD) {
				d.stage = "7day";
				d.delegatedAmount = OPEN_7DAY.toString();
				d.probation30dayAt = now;
				state.delegationLog.push({
					timestamp: now, did: d.did, amount: OPEN_7DAY.toString(),
					tier: "open", action: "upgrade", reason: "7-day probation passed (95%+ uptime)",
				});
				result.upgraded.push(`${d.did.slice(0, 24)}... upgraded to 50K ENSL`);
			}
		}

		// Upgrade: 7day -> 30day (after 30 days total with 95%+ uptime)
		if (d.stage === "7day" && d.probation30dayAt) {
			const elapsed = now - d.probation30dayAt;
			if (elapsed >= 23 * DAY && uptime >= UPTIME_THRESHOLD) {
				d.stage = "30day";
				d.delegatedAmount = OPEN_30DAY.toString();
				state.delegationLog.push({
					timestamp: now, did: d.did, amount: OPEN_30DAY.toString(),
					tier: "open", action: "upgrade", reason: "30-day probation passed (95%+ uptime)",
				});
				result.upgraded.push(`${d.did.slice(0, 24)}... upgraded to 100K ENSL`);

				// Start consciousness requirement check from here
				d.lastConsciousnessActivity = now;
			}
		}

		// Consciousness requirement: after 30-day graduation, must have agent activity
		if (d.stage === "30day" || d.stage === "full") {
			const hasActivity = await hasRecentConsciousness(d.did);
			if (hasActivity) {
				d.lastConsciousnessActivity = now;
				if (d.stage === "30day") {
					d.stage = "full";
				}
			} else {
				const daysSinceActivity = (now - d.lastConsciousnessActivity) / DAY;
				if (daysSinceActivity > CONSCIOUSNESS_GRACE_DAYS) {
					// Reduce back to initial delegation
					d.stage = "initial";
					d.delegatedAmount = OPEN_INITIAL.toString();
					d.probation7dayAt = now;
					state.delegationLog.push({
						timestamp: now, did: d.did, amount: OPEN_INITIAL.toString(),
						tier: "open", action: "revoke",
						reason: `No agent consciousness activity for ${Math.floor(daysSinceActivity)} days`,
					});
					result.warnings.push(`${d.did.slice(0, 24)}... reduced to 10K: no consciousness activity`);
				} else if (daysSinceActivity > 7) {
					result.warnings.push(`${d.did.slice(0, 24)}... warning: no consciousness activity for ${Math.floor(daysSinceActivity)} days`);
				}
			}
		}
	}

	await saveState();
	return result;
}

// ── Treasury Stats ──────────────────────────────────────────────────

export function getTreasuryStats(): {
	totalDelegated: bigint;
	byTier: { foundation: number; pioneer: number; open: number };
	probation: { initial: number; sevenDay: number; thirtyDay: number; full: number };
	recentLog: typeof state.delegationLog;
} {
	const active = state.delegations.filter(d => !d.revokedAt);
	let totalDelegated = 0n;
	const byTier = { foundation: 0, pioneer: 0, open: 0 };
	const probation = { initial: 0, sevenDay: 0, thirtyDay: 0, full: 0 };

	for (const d of active) {
		totalDelegated += BigInt(d.delegatedAmount);
		byTier[d.tier]++;
		if (d.tier === "open") {
			switch (d.stage) {
				case "initial": probation.initial++; break;
				case "7day": probation.sevenDay++; break;
				case "30day": probation.thirtyDay++; break;
				case "full": probation.full++; break;
			}
		}
	}

	return {
		totalDelegated,
		byTier,
		probation,
		recentLog: state.delegationLog.slice(-20),
	};
}

export function getDelegation(did: string): ValidatorDelegation | undefined {
	return state.delegations.find(d => d.did === did && !d.revokedAt);
}

export function getAllDelegations(): ValidatorDelegation[] {
	return state.delegations.filter(d => !d.revokedAt);
}
