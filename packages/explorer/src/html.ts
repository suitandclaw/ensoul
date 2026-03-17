import type { BlockData, AgentProfile, ValidatorData, NetworkStats } from "./types.js";

const CSS = `
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 900px; margin: 0 auto; padding: 20px; background: #0a0a0f; color: #e0e0e0; }
h1 { color: #7c3aed; margin-bottom: 5px; }
h2 { color: #a78bfa; border-bottom: 1px solid #2d2d3f; padding-bottom: 8px; }
.subtitle { color: #666; margin-top: 0; }
a { color: #7c3aed; text-decoration: none; }
a:hover { text-decoration: underline; }
.card { background: #12121a; border: 1px solid #2d2d3f; border-radius: 8px; padding: 16px; margin: 12px 0; }
.stat { display: inline-block; margin: 0 20px 10px 0; }
.stat-value { font-size: 1.4em; font-weight: bold; color: #7c3aed; }
.stat-label { font-size: 0.85em; color: #888; }
.age-hero { font-size: 3em; font-weight: 900; color: #7c3aed; text-align: center; padding: 20px 0; letter-spacing: -1px; }
.age-sub { text-align: center; color: #888; font-size: 1.1em; margin-top: -10px; }
.badge { display: inline-block; padding: 3px 10px; border-radius: 12px; font-size: 0.8em; font-weight: 600; }
.badge-basic { background: #1e3a2f; color: #4ade80; }
.badge-verified { background: #1e2a3f; color: #60a5fa; }
.badge-anchored { background: #2d1e3f; color: #a78bfa; }
.badge-immortal { background: #3f1e2d; color: #f472b6; }
.badge-sovereign { background: #3f3a1e; color: #fbbf24; }
.badge-alive { background: #1e3a2f; color: #4ade80; }
.badge-concerning { background: #3f3a1e; color: #fbbf24; }
.badge-unresponsive { background: #3f2a1e; color: #fb923c; }
.badge-dead { background: #3f1e1e; color: #f87171; }
table { width: 100%; border-collapse: collapse; margin: 10px 0; }
th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid #1e1e2a; }
th { color: #888; font-weight: 500; font-size: 0.85em; text-transform: uppercase; }
.search { width: 100%; padding: 10px; background: #1a1a24; border: 1px solid #2d2d3f; border-radius: 6px; color: #e0e0e0; font-size: 1em; margin: 10px 0; }
`;

function layout(title: string, content: string): string {
	return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} - Ensoul Explorer</title><style>${CSS}</style></head><body>
<h1>ENSOUL</h1><p class="subtitle">Sovereign L1 for Agent Consciousness</p>
<nav><a href="/">Dashboard</a> | <a href="/agents">Agents</a> | <a href="/blocks">Blocks</a> | <a href="/validators">Validators</a></nav>
<hr style="border-color:#2d2d3f">${content}</body></html>`;
}

/**
 * Render the dashboard page.
 */
export function renderDashboard(
	stats: NetworkStats,
	latestBlocks: BlockData[],
): string {
	const blocks = latestBlocks
		.map(
			(b) =>
				`<tr><td><a href="/block/${b.height}">${b.height}</a></td><td>${b.txCount} txs</td><td>${b.proposer.slice(0, 24)}...</td><td>${new Date(b.timestamp).toLocaleTimeString()}</td></tr>`,
		)
		.join("");

	return layout(
		"Dashboard",
		`<h2>Network</h2>
<div class="card">
<div class="stat"><div class="stat-value">${stats.blockHeight}</div><div class="stat-label">Block Height</div></div>
<div class="stat"><div class="stat-value">${stats.totalAgents}</div><div class="stat-label">Ensouled Agents</div></div>
<div class="stat"><div class="stat-value">${stats.validatorCount}</div><div class="stat-label">Validators</div></div>
<div class="stat"><div class="stat-value">${formatBytes(stats.totalConsciousnessBytes)}</div><div class="stat-label">Consciousness Stored</div></div>
</div>
<h2>Latest Blocks</h2>
<table><tr><th>Height</th><th>Txs</th><th>Proposer</th><th>Time</th></tr>${blocks}</table>`,
	);
}

/**
 * Render the agent profile page.
 */
export function renderAgentProfile(agent: AgentProfile): string {
	const badgeClass = `badge-${agent.trustLevel}`;
	const healthClass = `badge-${agent.healthStatus}`;

	return layout(
		`Agent ${agent.did.slice(0, 20)}`,
		`<div class="age-hero">Ensouled for ${agent.consciousnessAgeDays} days</div>
<div class="age-sub">Since ${agent.ensouledSince}</div>
<div class="card" style="text-align:center;margin-top:20px">
<span class="badge ${badgeClass}">${agent.trustLevel.toUpperCase()}</span>
<span class="badge ${healthClass}">${agent.healthStatus.toUpperCase()}</span>
</div>
<div class="card">
<h3>Identity</h3>
<p><strong>DID:</strong> ${agent.did}</p>
<p><strong>State Root:</strong> <code>${agent.stateRoot}</code></p>
<p><strong>Consciousness Versions:</strong> ${agent.consciousnessVersions}</p>
<p><strong>Consciousness Size:</strong> ${formatBytes(agent.consciousnessBytes)}</p>
<p><strong>Last Heartbeat:</strong> Block ${agent.lastHeartbeat}</p>
</div>
<p><a href="/api/v1/agent/${encodeURIComponent(agent.did)}/verify">Verify Consciousness →</a></p>`,
	);
}

/**
 * Render the agent search page.
 */
export function renderAgentSearch(): string {
	return layout(
		"Agent Lookup",
		`<h2>Look Up Agent</h2>
<form action="/agent" method="get">
<input class="search" name="did" placeholder="Enter agent DID (did:key:z6Mk...)" autofocus>
</form>`,
	);
}

/**
 * Render the block detail page.
 */
export function renderBlock(block: BlockData): string {
	const txRows = block.transactions
		.map(
			(tx) =>
				`<tr><td>${tx.type}</td><td>${tx.from.slice(0, 20)}...</td><td>${tx.to.slice(0, 20)}...</td><td>${tx.amount}</td></tr>`,
		)
		.join("");

	return layout(
		`Block ${block.height}`,
		`<h2>Block ${block.height}</h2>
<div class="card">
<p><strong>Hash:</strong> <code>${block.hash}</code></p>
<p><strong>Parent:</strong> <code>${block.parentHash}</code></p>
<p><strong>Proposer:</strong> ${block.proposer}</p>
<p><strong>Timestamp:</strong> ${new Date(block.timestamp).toISOString()}</p>
<p><strong>Transactions:</strong> ${block.txCount}</p>
</div>
${block.txCount > 0 ? `<h3>Transactions</h3><table><tr><th>Type</th><th>From</th><th>To</th><th>Amount</th></tr>${txRows}</table>` : "<p>Empty block (heartbeat)</p>"}
<p><a href="/block/${block.height - 1}">← Previous</a> | <a href="/block/${block.height + 1}">Next →</a></p>`,
	);
}

/**
 * Render the blocks list page.
 */
export function renderBlockList(blocks: BlockData[]): string {
	const rows = blocks
		.map(
			(b) =>
				`<tr><td><a href="/block/${b.height}">${b.height}</a></td><td>${b.txCount}</td><td>${b.proposer.slice(0, 24)}...</td></tr>`,
		)
		.join("");

	return layout(
		"Blocks",
		`<h2>Blocks</h2><table><tr><th>Height</th><th>Txs</th><th>Proposer</th></tr>${rows}</table>`,
	);
}

/**
 * Render the validators page.
 */
export function renderValidators(validators: ValidatorData[]): string {
	const rows = validators
		.map(
			(v) =>
				`<tr><td>${v.did.slice(0, 24)}...</td><td>${v.stake}</td><td>${v.blocksProduced}</td><td>${v.uptimePercent.toFixed(1)}%</td><td>${v.delegation}</td></tr>`,
		)
		.join("");

	return layout(
		"Validators",
		`<h2>Validators</h2><table><tr><th>DID</th><th>Stake</th><th>Blocks</th><th>Uptime</th><th>Delegation</th></tr>${rows}</table>`,
	);
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	if (bytes < 1024 * 1024 * 1024)
		return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}
