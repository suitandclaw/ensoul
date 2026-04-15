/**
 * Admin CLI commands. These wrap the API's admin-protected endpoints
 * with the local ENSOUL_ADMIN_KEY env var.
 *
 * Subcommands:
 *   ensoul-node admin pioneer-list [pending|approved|rejected]
 *   ensoul-node admin pioneer-approve <DID>
 *   ensoul-node admin help
 *
 * Environment:
 *   ENSOUL_ADMIN_KEY  - the admin secret matching the API's value
 *   ENSOUL_API_URL    - defaults to https://api.ensoul.dev
 */

const API = process.env["ENSOUL_API_URL"] ?? "https://api.ensoul.dev";

function getAdminKey(): string {
	const key = process.env["ENSOUL_ADMIN_KEY"] ?? "";
	if (!key) {
		console.error("Error: ENSOUL_ADMIN_KEY environment variable not set.");
		console.error("Set it with: export ENSOUL_ADMIN_KEY=...");
		process.exit(1);
	}
	return key;
}

function printHelp(): void {
	console.log(`Ensoul admin commands:

  ensoul-node admin pioneer-list [status]
      List Pioneer applications. Optional status filter:
      pending (default), approved, rejected, all.

  ensoul-node admin pioneer-approve <DID>
      Approve a Pioneer application. Triggers the 1,000,000 ENSL
      foundation delegation (locked 24 months) and 100 ENSL
      self-stake transfer.

  ensoul-node admin help
      Show this help.

Environment:
  ENSOUL_ADMIN_KEY  required, must match the API server
  ENSOUL_API_URL    defaults to https://api.ensoul.dev
`);
}

interface PioneerAppSummary {
	did: string;
	name: string;
	contact: string;
	status: string;
	appliedAt?: string;
	approvedAt?: string;
	rejectedAt?: string;
	rejectionReason?: string;
	delegationHeight?: number;
	delegationHash?: string;
	lockedUntil?: number;
	lockExpiryDate?: string | null;
}

async function pioneerList(status: string): Promise<void> {
	const adminKey = getAdminKey();
	const url = `${API}/v1/pioneers/list?status=${encodeURIComponent(status)}&admin_key=${encodeURIComponent(adminKey)}`;
	const res = await fetch(url);
	if (res.status === 403) {
		console.error("Error: admin key rejected by API.");
		process.exit(1);
	}
	if (!res.ok) {
		console.error(`Error: API returned ${res.status}`);
		process.exit(1);
	}
	const data = (await res.json()) as { status: string; count: number; applications: PioneerAppSummary[] };

	console.log(`\nPioneer applications (${data.status}): ${data.count}\n`);
	if (data.applications.length === 0) {
		console.log("  (none)\n");
		return;
	}
	for (const a of data.applications) {
		const date = a.appliedAt ? new Date(a.appliedAt).toISOString().slice(0, 10) : "?";
		const shortDid = a.did.length > 40 ? `${a.did.slice(0, 24)}...${a.did.slice(-8)}` : a.did;
		console.log(`  [${a.status.toUpperCase()}] ${a.name}`);
		console.log(`    DID:     ${shortDid}`);
		console.log(`    Contact: ${a.contact}`);
		console.log(`    Applied: ${date}`);
		if (a.status === "approved") {
			console.log(`    Approved: ${a.approvedAt?.slice(0, 10) ?? "?"}, block ${a.delegationHeight}`);
			if (a.lockExpiryDate) console.log(`    Lock expires: ${a.lockExpiryDate.slice(0, 10)}`);
		}
		if (a.status === "rejected" && a.rejectionReason) {
			console.log(`    Reason: ${a.rejectionReason}`);
		}
		console.log("");
	}
}

async function pioneerApprove(did: string): Promise<void> {
	if (!did) {
		console.error("Usage: ensoul-node admin pioneer-approve <DID>");
		process.exit(1);
	}
	const adminKey = getAdminKey();

	console.log(`Approving Pioneer ${did.slice(0, 30)}...`);
	const res = await fetch(`${API}/v1/pioneers/approve`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ did, admin_key: adminKey }),
	});
	const data = await res.json() as Record<string, unknown>;

	if (res.status === 403) {
		console.error("Error: admin key rejected by API.");
		process.exit(1);
	}
	if (res.status === 404) {
		console.error(`Error: no application found for ${did}`);
		process.exit(1);
	}
	if (!res.ok) {
		console.error(`Error ${res.status}: ${JSON.stringify(data)}`);
		process.exit(1);
	}

	if (data["status"] === "already_approved") {
		console.log(`\nAlready approved.`);
		console.log(`  Delegation tx: ${data["delegation_tx"]}`);
		console.log(`  Locked until:  ${data["locked_until"]}\n`);
		return;
	}

	console.log(`\nApproved.`);
	console.log(`  DID:           ${data["did"]}`);
	console.log(`  Name:          ${data["name"]}`);
	console.log(`  Delegation tx: ${data["delegation_tx"]}`);
	console.log(`  Block height:  ${data["delegationHeight"]}`);
	console.log(`  Amount:        1,000,000 ENSL`);
	console.log(`  Self-stake:    ${data["selfStakeSent"] ? "100 ENSL sent" : "FAILED (Pioneer must self-fund)"}`);
	console.log(`  Locked until:  ${data["locked_until"]}`);
	console.log(`\nNext step for the Pioneer:`);
	console.log(`  ensoul-node wallet stake 100`);
	console.log(`  ensoul-node wallet consensus-join\n`);
}

export async function runAdminCommand(args: string[]): Promise<void> {
	const sub = args[0];
	if (!sub || sub === "help" || sub === "--help" || sub === "-h") {
		printHelp();
		return;
	}
	if (sub === "pioneer-list") {
		const status = args[1] ?? "pending";
		await pioneerList(status);
		return;
	}
	if (sub === "pioneer-approve") {
		const did = args[1] ?? "";
		await pioneerApprove(did);
		return;
	}
	console.error(`Unknown admin subcommand: ${sub}`);
	printHelp();
	process.exit(1);
}
