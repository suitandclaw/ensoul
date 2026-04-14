/**
 * Weekly phase scheduler. Times are America/New_York.
 *
 * Schedule:
 *   Mon-Thu all day:        learn
 *   Fri 00:00 - 14:59:      learn
 *   Fri 15:00 - 15:59:      announce (countdown threads at :00, :30)
 *   Fri 16:00 - 16:04:      kill (agent exits; wipe script runs)
 *   Fri 16:05 - 23:59:      resurrect (new machine recovers + proves)
 *   Sat all day:            silent (celebration + resurrection thread pinned)
 *   Sun all day:            learn (new cycle begins)
 *
 * Phase transitions are event-driven: the agent polls every 60s.
 */

import type { Phase } from "./types.js";
import { currentEstHour } from "./log.js";

export function currentPhase(): Phase {
	const t = currentEstHour();
	const { dayOfWeek, hour, minute } = t;

	// Friday specific logic
	if (dayOfWeek === 5) {
		if (hour < 15) return "learn";
		if (hour === 15) return "announce";
		if (hour === 16 && minute < 5) return "silent"; // during the wipe
		if (hour === 16 && minute >= 5) return "resurrect";
		return "silent"; // rest of Friday evening
	}

	// Saturday: silent celebration day (resurrection thread stays pinned)
	if (dayOfWeek === 6) return "silent";

	// Sun-Thu: learn
	return "learn";
}

/**
 * Should we post a countdown tweet right now?
 * - 15:00 EST (start of announce phase): T-60 minutes
 * - 15:30 EST: T-30 minutes
 * - 15:55 EST: T-5 minutes (final)
 */
export function countdownBucket(): "t60" | "t30" | "t5" | null {
	const t = currentEstHour();
	if (t.dayOfWeek !== 5 || t.hour !== 15) return null;
	if (t.minute < 5) return "t60";
	if (t.minute >= 28 && t.minute < 33) return "t30";
	if (t.minute >= 55) return "t5";
	return null;
}

/**
 * Have we already posted today? Check in the consciousness.posts ledger.
 */
export function wasPostedToday(posts: Array<{ timestamp: number }>, tag: string, now = Date.now()): boolean {
	const today = new Date(now).toISOString().slice(0, 10);
	return posts.some(p => new Date(p.timestamp).toISOString().slice(0, 10) === today && (p as unknown as { tag?: string }).tag === tag);
}

/** Get ISO date (YYYY-MM-DD) of the Monday that starts the current week. */
export function currentCycleStart(): string {
	const t = currentEstHour();
	// Roll back to Monday. JS Date weekday: Sun=0..Sat=6
	const now = new Date();
	const daysFromMonday = (t.dayOfWeek + 6) % 7;
	const monday = new Date(now.getTime() - daysFromMonday * 86400000);
	return monday.toISOString().slice(0, 10);
}
