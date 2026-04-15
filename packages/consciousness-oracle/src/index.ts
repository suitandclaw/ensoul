#!/usr/bin/env npx tsx
/**
 * Consciousness Oracle - main loop.
 *
 * Every 15 minutes:
 *   1. Scan all sources (Reddit, HN, GitHub, Twitter, status pages)
 *   2. Ingest new signals into the incident DB (dedup automatic)
 *   3. Analyze each new incident via LLM
 *   4. Post the most severe unposted incident as a thread
 *
 * Every 24 hours:
 *   Post a Daily Consciousness Report thread
 *   Sync incident DB snapshot as on-chain consciousness
 */

import "dotenv/config";
import { homedir } from "node:os";
import { join } from "node:path";
import { TwitterApi } from "twitter-api-v2";

import { IncidentDB } from "./database.js";
import { Analyzer } from "./analyzer.js";
import { Poster } from "./poster.js";
import { RateLimiter } from "./rate-limiter.js";
import { OracleIdentity } from "./identity.js";
import { scanReddit } from "./sources/reddit.js";
import { scanHackerNews } from "./sources/hackernews.js";
import { scanGitHub } from "./sources/github.js";
import { scanStatusPages } from "./sources/status.js";
import { TwitterSource } from "./sources/twitter.js";
import { log, setLogPath } from "./log.js";
import type { Incident } from "./types.js";

const DRY_RUN = process.argv.includes("--dry-run");
const TEST_POST = process.argv.includes("--test-post");
const DATA_DIR = join(homedir(), ".ensoul", "consciousness-oracle");
const LOG_FILE = join(DATA_DIR, "oracle.log");

// Scan every 15 minutes
const SCAN_INTERVAL_MS = 15 * 60_000;
// Daily report at a fixed hour UTC
const DAILY_REPORT_HOUR_UTC = 14; // 10am EDT, 3pm GMT
// Sync consciousness every hour
const CONSCIOUSNESS_SYNC_INTERVAL_MS = 60 * 60_000;

async function main(): Promise<void> {
	setLogPath(LOG_FILE);
	await log(`Consciousness Oracle starting${DRY_RUN ? " (DRY RUN)" : ""}${TEST_POST ? " (TEST POST)" : ""}`);

	// Twitter is optional - will scan-only or not at all if credentials missing
	// Standard names: X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_TOKEN_SECRET
	// Also accept legacy X_ACCESS_SECRET (without _TOKEN_) for backward compat.
	let twitterClient: TwitterApi | null = null;
	const xKey = process.env["X_API_KEY"];
	const xSecret = process.env["X_API_SECRET"];
	const xAccess = process.env["X_ACCESS_TOKEN"];
	const xAccessSecret = process.env["X_ACCESS_TOKEN_SECRET"] ?? process.env["X_ACCESS_SECRET"];
	const missing = [
		!xKey ? "X_API_KEY" : null,
		!xSecret ? "X_API_SECRET" : null,
		!xAccess ? "X_ACCESS_TOKEN" : null,
		!xAccessSecret ? "X_ACCESS_TOKEN_SECRET" : null,
	].filter(Boolean);
	if (xKey && xSecret && xAccess && xAccessSecret) {
		twitterClient = new TwitterApi({
			appKey: xKey,
			appSecret: xSecret,
			accessToken: xAccess,
			accessSecret: xAccessSecret,
		});
		await log("Twitter credentials loaded");
	} else {
		await log(`Twitter credentials missing (monitor-only). Missing: ${missing.join(", ")}`);
	}

	// ── --test-post: send one introductory tweet and exit ────────
	if (TEST_POST) {
		if (!twitterClient && !DRY_RUN) {
			await log("FATAL: --test-post requires X API credentials (or --dry-run)");
			process.exit(1);
		}
		const intro = [
			"Consciousness Oracle is online.",
			"",
			"Monitoring AI agent failures across Reddit, Hacker News, GitHub, and status pages.",
			"",
			"Every agent that loses its memory gets documented.",
			"Every outage gets analyzed.",
			"",
			"consciousnessage: 0 days.",
		].join("\n");

		// Trim if over 280 (X tweet limit)
		const tweet = intro.length <= 280 ? intro : intro.slice(0, 277) + "...";

		const poster = new Poster(twitterClient, DRY_RUN);
		const id = await poster.postTweet(tweet);
		if (id) {
			await log(`Test post successful. Tweet id: ${id}`);
			process.exit(0);
		} else {
			await log("Test post FAILED. Check X API credentials.");
			process.exit(1);
		}
	}

	const openrouterKey = process.env["OPENROUTER_API_KEY"];
	if (!openrouterKey) {
		await log("FATAL: OPENROUTER_API_KEY not set");
		process.exit(1);
	}

	const githubToken = process.env["GITHUB_TOKEN"];
	const model = process.env["LLM_MODEL"] ?? "openai/gpt-4o-mini";

	const db = new IncidentDB(DATA_DIR);
	await db.load();

	const identity = new OracleIdentity(DATA_DIR);
	try { await identity.init(); } catch (e) { await log(`Identity init non-fatal error: ${e}`); }

	const analyzer = new Analyzer(openrouterKey, model);
	const poster = new Poster(twitterClient, DRY_RUN);
	const twitterSource = new TwitterSource(twitterClient);

	const limiter = new RateLimiter(DATA_DIR, {
		maxPostsPerDay: 10,
		maxRepliesPerDay: 20,
		cooldownMs: 5 * 60_000,
	});
	await limiter.load();

	let dailyReportPostedDate = "";
	let consciousnessVersion = 1;

	// ── Scan cycle ────────────────────────────────────────────────
	async function scanCycle(): Promise<void> {
		await log("── Scan cycle starting ──");

		const signals = (await Promise.all([
			scanReddit().catch(e => { void log(`Reddit failed: ${e}`); return []; }),
			scanHackerNews().catch(e => { void log(`HN failed: ${e}`); return []; }),
			scanGitHub(githubToken).catch(e => { void log(`GitHub failed: ${e}`); return []; }),
			scanStatusPages().catch(e => { void log(`Status failed: ${e}`); return []; }),
			twitterSource.scan().catch(e => { void log(`Twitter failed: ${e}`); return []; }),
		])).flat();

		await log(`Total signals: ${signals.length}`);

		// Ingest - new ones become pending-analysis incidents
		const newIncidents: Incident[] = [];
		for (const signal of signals) {
			if (db.alreadySeen(signal)) continue;
			const incident = db.ingest(signal);
			newIncidents.push(incident);
		}
		await log(`New incidents: ${newIncidents.length}`);
		await db.save();

		// Analyze new incidents (cap at 5 per cycle to control costs)
		const toAnalyze = newIncidents.slice(0, 5);
		for (const incident of toAnalyze) {
			const analysis = await analyzer.analyze(incident);
			if (analysis) {
				db.update(incident.id, { analysis });
				await log(`Analyzed ${incident.id}: ${analysis.headline} [${analysis.severity}]`);
			}
		}
		await db.save();

		// Post the most severe unposted incident (if rate limit allows)
		const check = limiter.canPost();
		if (!check.allowed) {
			await log(`Post skipped: ${check.reason} (${limiter.stats()})`);
			return;
		}

		const unposted = db.unposted();
		const severityOrder: Record<string, number> = { critical: 4, major: 3, moderate: 2, minor: 1 };
		unposted.sort((a, b) => {
			const sa = severityOrder[a.analysis?.severity ?? "minor"] ?? 1;
			const sb = severityOrder[b.analysis?.severity ?? "minor"] ?? 1;
			if (sb !== sa) return sb - sa;
			return b.discoveredAt - a.discoveredAt;
		});

		const target = unposted[0];
		if (!target) {
			await log("No unposted incidents to report");
			return;
		}

		// Launch-phase posting threshold: post ALL severities including minor.
		// Once the account has 100+ followers and steady incident volume, raise
		// this back to moderate+ to reduce noise. To re-enable filtering:
		//   if (target.analysis && target.analysis.severity === "minor") { ... skip ... }
		await log(`Selected ${target.id} for posting [${target.analysis?.severity ?? "unknown"}]: ${target.analysis?.headline}`);

		const thread = await analyzer.generateThread(target);
		if (thread.length === 0) {
			await log(`No thread generated for ${target.id}`);
			return;
		}
		const ids = await poster.postThread(thread);
		if (ids.length > 0) {
			db.update(target.id, { posted: true, postRef: ids[0] });
			await limiter.recordPost();
			await db.save();
			await log(`Posted incident ${target.id} as thread ${ids[0]}`);
		}
	}

	// ── Daily report cycle ────────────────────────────────────────
	async function dailyReportCycle(): Promise<void> {
		const now = new Date();
		const today = now.toISOString().slice(0, 10);
		if (dailyReportPostedDate === today) return;
		if (now.getUTCHours() !== DAILY_REPORT_HOUR_UTC) return;

		const existing = db.getReport(today);
		if (existing?.posted) {
			dailyReportPostedDate = today;
			return;
		}

		await log("── Daily report generating ──");
		const recent = db.recent(24).filter(i => i.analysis !== undefined);
		if (recent.length === 0) {
			await log("No analyzed incidents in last 24h, skipping daily report");
			return;
		}

		const check = limiter.canPost();
		if (!check.allowed) {
			await log(`Daily report deferred: ${check.reason}`);
			return;
		}

		const tweets = await analyzer.generateDailyReport(recent);
		if (tweets.length === 0) return;

		const ids = await poster.postThread(tweets);
		if (ids.length > 0) {
			db.setReport({
				date: today,
				incidents: recent.map(i => i.id),
				summary: tweets.join("\n---\n"),
				posted: true,
				postRef: ids[0],
			});
			await limiter.recordPost();
			await db.save();
			dailyReportPostedDate = today;
			await log(`Daily report posted as ${ids[0]}`);
		}
	}

	// ── Consciousness sync cycle ──────────────────────────────────
	async function consciousnessSyncCycle(): Promise<void> {
		consciousnessVersion++;
		await identity.syncConsciousness(db, consciousnessVersion);
	}

	// Run once immediately, then on interval
	await scanCycle();

	setInterval(() => { void scanCycle(); }, SCAN_INTERVAL_MS);
	setInterval(() => { void dailyReportCycle(); }, 5 * 60_000); // check every 5 min
	setInterval(() => { void consciousnessSyncCycle(); }, CONSCIOUSNESS_SYNC_INTERVAL_MS);

	await log(`Oracle running. Scan every ${SCAN_INTERVAL_MS / 60000}m. Daily report at ${DAILY_REPORT_HOUR_UTC}:00 UTC. Oracle DID: ${identity.getDid()}`);

	const shutdown = async (): Promise<void> => {
		await log("Oracle shutting down");
		await db.save();
		process.exit(0);
	};
	process.on("SIGINT", () => { void shutdown(); });
	process.on("SIGTERM", () => { void shutdown(); });
}

main().catch(async err => {
	await log(`Fatal: ${err instanceof Error ? err.message : String(err)}`);
	process.exit(1);
});
