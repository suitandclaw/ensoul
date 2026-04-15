import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

let logPath = "";
export function setLogPath(p: string): void { logPath = p; }

export async function log(msg: string): Promise<void> {
	const ts = new Date().toISOString();
	const line = `[${ts}] ${msg}\n`;
	process.stdout.write(line);
	if (logPath) {
		try {
			await mkdir(dirname(logPath), { recursive: true });
			await appendFile(logPath, line);
		} catch { /* non-fatal */ }
	}
}

export function errMsg(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

/** Current weekday + hour + minute in America/New_York. */
export function currentEst(): { dayOfWeek: number; hour: number; minute: number } {
	const fmt = new Intl.DateTimeFormat("en-US", {
		timeZone: "America/New_York",
		weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false,
	});
	const parts = fmt.formatToParts(new Date());
	const hourStr = parts.find(p => p.type === "hour")?.value ?? "0";
	const minStr = parts.find(p => p.type === "minute")?.value ?? "0";
	const dayStr = parts.find(p => p.type === "weekday")?.value ?? "Mon";
	const dayMap: Record<string, number> = { Sun:0, Mon:1, Tue:2, Wed:3, Thu:4, Fri:5, Sat:6 };
	return {
		dayOfWeek: dayMap[dayStr] ?? 0,
		hour: parseInt(hourStr, 10),
		minute: parseInt(minStr, 10),
	};
}
