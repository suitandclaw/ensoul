/**
 * Incident database: persists to JSON file at ~/.ensoul/consciousness-oracle/incidents.json.
 * Also tracks daily reports.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Incident, RawSignal, DailyReport } from "./types.js";
import { sha256Short, log } from "./log.js";

export class IncidentDB {
	private incidents = new Map<string, Incident>();
	private reports = new Map<string, DailyReport>();
	private readonly dataDir: string;
	private readonly incidentsFile: string;
	private readonly reportsFile: string;

	constructor(dataDir: string) {
		this.dataDir = dataDir;
		this.incidentsFile = join(dataDir, "incidents.json");
		this.reportsFile = join(dataDir, "daily-reports.json");
	}

	async load(): Promise<void> {
		await mkdir(this.dataDir, { recursive: true });
		try {
			const raw = await readFile(this.incidentsFile, "utf-8");
			const list = JSON.parse(raw) as Incident[];
			for (const inc of list) this.incidents.set(inc.id, inc);
		} catch { /* no file yet */ }

		try {
			const raw = await readFile(this.reportsFile, "utf-8");
			const list = JSON.parse(raw) as DailyReport[];
			for (const r of list) this.reports.set(r.date, r);
		} catch { /* no file yet */ }

		await log(`DB loaded: ${this.incidents.size} incidents, ${this.reports.size} reports`);
	}

	async save(): Promise<void> {
		const incList = Array.from(this.incidents.values())
			.sort((a, b) => b.discoveredAt - a.discoveredAt);
		await writeFile(this.incidentsFile, JSON.stringify(incList, null, "\t"));

		const repList = Array.from(this.reports.values())
			.sort((a, b) => b.date.localeCompare(a.date));
		await writeFile(this.reportsFile, JSON.stringify(repList, null, "\t"));
	}

	/** Returns existing incident id if we've seen this signal, else null. */
	alreadySeen(signal: RawSignal): string | null {
		const id = this.makeId(signal);
		return this.incidents.has(id) ? id : null;
	}

	/** Record a new signal as an incident. Returns the created Incident. */
	ingest(signal: RawSignal): Incident {
		const id = this.makeId(signal);
		const existing = this.incidents.get(id);
		if (existing) return existing;
		const incident: Incident = {
			id,
			signal,
			discoveredAt: Date.now(),
			posted: false,
		};
		this.incidents.set(id, incident);
		return incident;
	}

	update(id: string, patch: Partial<Incident>): void {
		const existing = this.incidents.get(id);
		if (!existing) return;
		Object.assign(existing, patch);
	}

	get(id: string): Incident | undefined {
		return this.incidents.get(id);
	}

	/** Incidents discovered in the last N hours. Most recent first. */
	recent(hours: number): Incident[] {
		const cutoff = Date.now() - hours * 3600_000;
		return Array.from(this.incidents.values())
			.filter(i => i.discoveredAt >= cutoff)
			.sort((a, b) => b.discoveredAt - a.discoveredAt);
	}

	/** Incidents that have been analyzed but not yet posted. */
	unposted(): Incident[] {
		return Array.from(this.incidents.values())
			.filter(i => !i.posted && i.analysis !== undefined)
			.sort((a, b) => b.discoveredAt - a.discoveredAt);
	}

	totalCount(): number {
		return this.incidents.size;
	}

	getReport(date: string): DailyReport | undefined {
		return this.reports.get(date);
	}

	setReport(report: DailyReport): void {
		this.reports.set(report.date, report);
	}

	private makeId(signal: RawSignal): string {
		return `${signal.source}-${sha256Short(signal.sourceId)}`;
	}
}
