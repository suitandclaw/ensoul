/**
 * Status pages source: monitors public status endpoints for AI providers.
 * Most use statuspage.io which exposes a JSON API at /api/v2/status.json.
 */

import type { RawSignal } from "../types.js";
import { log, errMsg } from "../log.js";

interface StatusTarget {
	name: string;
	url: string; // base URL of the statuspage.io deployment
}

const TARGETS: StatusTarget[] = [
	{ name: "OpenAI", url: "https://status.openai.com" },
	{ name: "Anthropic", url: "https://status.anthropic.com" },
];

interface StatusPageResponse {
	page: { name: string; updated_at: string };
	status: { indicator: string; description: string };
}

interface StatusPageIncident {
	id: string;
	name: string;
	status: string;
	impact: string;
	created_at: string;
	updated_at: string;
	shortlink: string;
	incident_updates?: Array<{ body: string; created_at: string }>;
}

interface IncidentsResponse {
	incidents: StatusPageIncident[];
}

async function checkStatusPage(target: StatusTarget): Promise<RawSignal[]> {
	const signals: RawSignal[] = [];
	try {
		// First check overall status
		const statusRes = await fetch(`${target.url}/api/v2/status.json`, {
			signal: AbortSignal.timeout(10_000),
		});
		if (!statusRes.ok) return [];
		const status = (await statusRes.json()) as StatusPageResponse;

		// If overall status is not "none" (all good), fetch unresolved incidents
		if (status.status.indicator !== "none") {
			const incidentsRes = await fetch(`${target.url}/api/v2/incidents/unresolved.json`, {
				signal: AbortSignal.timeout(10_000),
			});
			if (!incidentsRes.ok) return [];
			const incidents = (await incidentsRes.json()) as IncidentsResponse;

			for (const inc of incidents.incidents ?? []) {
				const firstUpdate = inc.incident_updates?.[0]?.body ?? inc.name;
				signals.push({
					sourceId: inc.id,
					source: "status",
					url: inc.shortlink,
					title: `${target.name}: ${inc.name}`,
					excerpt: firstUpdate.slice(0, 1000),
					timestamp: new Date(inc.created_at).getTime(),
					metrics: {},
				});
			}
		}
	} catch (e) {
		await log(`Status check ${target.name} failed: ${errMsg(e)}`);
	}
	return signals;
}

export async function scanStatusPages(): Promise<RawSignal[]> {
	const all: RawSignal[] = [];
	for (const t of TARGETS) {
		const signals = await checkStatusPage(t);
		all.push(...signals);
	}
	await log(`Status scan: ${all.length} active incidents across ${TARGETS.length} providers`);
	return all;
}
