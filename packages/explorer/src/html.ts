import type { BlockData, TxData, AgentProfile, ValidatorData, NetworkStats } from "./types.js";

const CSS = `
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0a0a0f; color: #e0e0e0; line-height: 1.6; -webkit-font-smoothing: antialiased; font-size: 15px; }
a { color: #7c3aed; text-decoration: none; transition: color 0.2s; }
a:hover { color: #a78bfa; }

/* -- Nav with hamburger -- */
.site-nav { position: sticky; top: 0; z-index: 100; background: rgba(10,10,15,0.95); backdrop-filter: blur(12px); border-bottom: 1px solid #2d2d3f; padding: 12px 0; }
.site-nav .inner { max-width: 1120px; margin: 0 auto; padding: 0 16px; display: flex; align-items: center; gap: 24px; flex-wrap: wrap; }
.site-nav .logo { font-size: 1.1em; font-weight: 800; letter-spacing: 1px; color: #7c3aed; text-transform: uppercase; white-space: nowrap; }
.site-nav .hamburger { display: none; background: none; border: 1px solid #2d2d3f; color: #888; font-size: 1.4em; padding: 4px 10px; border-radius: 4px; cursor: pointer; margin-left: auto; }
.site-nav .links { display: flex; gap: 20px; margin-left: auto; }
.site-nav .links a { color: #888; font-size: 0.9em; font-weight: 500; }
.site-nav .links a:hover { color: #e0e0e0; }
.site-nav .links a.active { color: #7c3aed; }

/* -- Explorer sub-nav -- */
.explorer-nav { max-width: 900px; margin: 0 auto; padding: 10px 16px 0; display: flex; gap: 12px; border-bottom: 1px solid #1e1e2a; overflow-x: auto; }
.explorer-nav a { color: #888; font-size: 0.85em; padding: 6px 2px 8px; border-bottom: 2px solid transparent; white-space: nowrap; }
.explorer-nav a:hover { color: #e0e0e0; }
.explorer-nav a.active { color: #7c3aed; border-bottom-color: #7c3aed; }

/* -- Content -- */
.content { max-width: 900px; margin: 0 auto; padding: 16px; }
h1 { color: #7c3aed; margin-bottom: 5px; font-size: 1.3em; }
h2 { color: #a78bfa; border-bottom: 1px solid #2d2d3f; padding-bottom: 6px; margin-top: 20px; font-size: 1.1em; }
.card { background: #12121a; border: 1px solid #2d2d3f; border-radius: 8px; padding: 14px; margin: 10px 0; overflow-x: auto; }
.stat { display: inline-block; margin: 0 16px 8px 0; }
.stat-value { font-size: 1.3em; font-weight: bold; color: #7c3aed; }
.stat-label { font-size: 0.8em; color: #888; }
.badge { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 0.75em; font-weight: 600; white-space: nowrap; }
.badge-basic { background: #1e3a2f; color: #4ade80; }
.badge-verified { background: #1e2a3f; color: #60a5fa; }
.badge-anchored { background: #2d1e3f; color: #a78bfa; }
.badge-immortal { background: #3f1e2d; color: #f472b6; }
.badge-sovereign { background: #3f3a1e; color: #fbbf24; }
.badge-alive { background: #1e3a2f; color: #4ade80; }
.badge-dead { background: #3f1e1e; color: #f87171; }
table { width: 100%; border-collapse: collapse; margin: 8px 0; }
th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #1e1e2a; font-size: 0.85em; }
th { color: #888; font-weight: 500; text-transform: uppercase; cursor: pointer; user-select: none; }
th:hover { color: #7c3aed; }
.search { width: 100%; padding: 10px 12px; background: #1a1a24; border: 1px solid #2d2d3f; border-radius: 6px; color: #e0e0e0; font-size: 1em; margin: 8px 0; }
code { background: #1a1a24; border: 1px solid #2d2d3f; border-radius: 4px; padding: 2px 6px; font-family: monospace; font-size: 0.85em; word-break: break-all; }
.footer { max-width: 900px; margin: 30px auto 0; padding: 16px; text-align: center; color: #666; font-size: 0.8em; border-top: 1px solid #1e1e2a; }
.pagination { display: flex; justify-content: center; gap: 6px; margin: 14px 0; flex-wrap: wrap; }
.pagination a { padding: 5px 10px; background: #1a1a24; border: 1px solid #2d2d3f; border-radius: 4px; color: #888; font-size: 0.8em; }
.pagination a:hover { border-color: #7c3aed; color: #e0e0e0; }
.pagination a.active { background: #7c3aed; color: #fff; border-color: #7c3aed; }
.two-col { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
.hide-mobile { }

/* -- Mobile -- */
@media (max-width: 768px) {
  body { font-size: 14px; }
  .site-nav .hamburger { display: block; }
  .site-nav .links { display: none; width: 100%; flex-direction: column; gap: 12px; padding: 12px 0; }
  .site-nav .links.open { display: flex; }
  .site-nav .inner { flex-wrap: wrap; }
  .explorer-nav { gap: 8px; padding: 8px 12px 0; }
  .content { padding: 12px; }
  .two-col { grid-template-columns: 1fr; }
  .hide-mobile { display: none !important; }
  .stat-value { font-size: 1.1em; }
  table { font-size: 0.8em; }
  th, td { padding: 5px 6px; }
  h1 { font-size: 1.1em; }
  h2 { font-size: 1em; }
  .card { padding: 10px; }
}
`;

function siteNav(activePage: string): string {
	const link = (href: string, label: string, id: string): string => {
		const cls = id === activePage ? ' class="active"' : "";
		return `<a href="${href}"${cls}>${label}</a>`;
	};
	return `<nav class="site-nav"><div class="inner"><a href="/" class="logo" style="display:inline-flex;align-items:center;gap:8px"><svg viewBox="0 0 110 110" width="22" height="22"><circle cx="55" cy="55" r="42" fill="none" stroke="#7C6AE8" stroke-width="1.5"/><path d="M55 28 C55 28, 38 48, 38 60 C38 73, 45 82, 55 82 C65 82, 72 73, 72 60 C72 48, 55 28, 55 28 Z" fill="#7C6AE8"/><circle cx="55" cy="62" r="4" fill="white" opacity="0.9"/></svg>ENSOUL EXPLORER</a><button class="hamburger" onclick="document.querySelector('.site-nav .links').classList.toggle('open')">&#9776;</button><div class="links">${link("/", "Explorer", "explorer")}${link("/validators", "Validators", "validators")}${link("https://ensoul.dev/validator-dashboard.html", "Dashboard", "dashboard")}${link("https://ensoul.dev/wallet.html", "Wallet", "wallet")}${link("https://ensoul.dev/docs/quickstart.html", "Docs", "docs")}${link("https://github.com/suitandclaw/ensoul", "GitHub", "github")}</div></div></nav>`;
}

function explorerNav(activeTab: string): string {
	const tab = (href: string, label: string, id: string): string => {
		const cls = id === activeTab ? ' class="active"' : "";
		return `<a href="${href}"${cls}>${label}</a>`;
	};
	return `<div class="explorer-nav">${tab("/", "Dashboard", "dashboard")}${tab("/agents", "Agents", "agents")}${tab("/blocks", "Blocks", "blocks")}${tab("/transactions", "Transactions", "transactions")}${tab("/validators", "Validators", "validators")}${tab("/wallets", "Wallets", "wallets")}</div>`;
}

function layout(title: string, tab: string, content: string, autoRefresh = false): string {
	const refreshScript = autoRefresh ? `<script>setTimeout(function(){location.reload()},6000)</script>` : "";
	return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} - Ensoul Explorer</title><link rel="icon" type="image/x-icon" href="/favicon.ico"><link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png"><link rel="icon" type="image/png" sizes="16x16" href="/favicon-16x16.png"><link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png"><style>${CSS}</style></head><body>${siteNav("explorer")}${explorerNav(tab)}<div class="content">${content}</div><div class="footer">ensoul.dev - the immortality layer for AI agents</div>${refreshScript}</body></html>`;
}

/**
 * Render the dashboard page.
 */
export function renderDashboard(
	stats: NetworkStats,
	latestBlocks: BlockData[],
): string {
	const blockRows = latestBlocks.slice(0, 10)
		.map((b) => {
			const shortProposer = b.proposer === "genesis" ? "genesis" : `<a href="/account/${encodeURIComponent(b.proposer)}">${b.proposer.slice(0, 8)}...${b.proposer.slice(-4)}</a>`;
			const rewardTx = b.transactions.find((t) => t.type === "block_reward");
			const reward = rewardTx ? formatEnsl(rewardTx.amount) : "0";
			return `<tr><td><a href="/block/${b.height}">${b.height}</a></td><td>${shortProposer}</td><td class="hide-mobile">${b.txCount}</td><td class="hide-mobile">${reward}</td><td>${timeAgo(b.timestamp)}</td></tr>`;
		})
		.join("");

	// Collect latest transactions from all blocks
	const allTxs: Array<{ tx: TxData; blockHeight: number }> = [];
	for (const b of latestBlocks) {
		for (const tx of b.transactions) {
			allTxs.push({ tx, blockHeight: b.height });
		}
	}
	allTxs.sort((a, b) => b.tx.timestamp - a.tx.timestamp);
	const txRows = allTxs.slice(0, 10)
		.map(({ tx }) => {
			const typeLabel = tx.type.replace(/_/g, " ").toUpperCase();
			const shortFrom = tx.from.length > 24 ? `<a href="/account/${encodeURIComponent(tx.from)}">${tx.from.slice(0, 10)}...${tx.from.slice(-4)}</a>` : tx.from;
			const shortTo = tx.to.length > 24 ? `<a href="/account/${encodeURIComponent(tx.to)}">${tx.to.slice(0, 10)}...${tx.to.slice(-4)}</a>` : tx.to;
			const shortHash = `${tx.hash.slice(0, 10)}...`;
			return `<tr><td>${shortHash}</td><td><span class="badge badge-basic">${typeLabel}</span></td><td>${shortFrom}</td><td>${shortTo}</td><td>${formatEnsl(tx.amount)}</td><td>${timeAgo(tx.timestamp)}</td></tr>`;
		})
		.join("");

	// Calculate block time and TPS from the last 10 blocks directly
	let avgBlockTimeStr = "6.0s";
	let tps = "0.0";
	const last10 = latestBlocks.slice(0, 10);
	if (last10.length >= 2) {
		const newest = last10[0]!;
		const oldest = last10[last10.length - 1]!;
		const spanMs = newest.timestamp - oldest.timestamp;
		if (spanMs > 0) {
			const avgMs = spanMs / (last10.length - 1);
			avgBlockTimeStr = `${(avgMs / 1000).toFixed(1)}s`;
			const txCount = last10.reduce((s, b) => s + b.txCount, 0);
			tps = (txCount / (spanMs / 1000)).toFixed(1);
		}
	}

	return layout(
		"Dashboard",
		"dashboard",
		`<form id="search-form" style="margin:16px 0">
<input class="search" id="search-input" placeholder="Search by DID, block height, or transaction hash..." autofocus>
</form>
<script>
document.getElementById("search-form").onsubmit=function(e){
  e.preventDefault();
  var q=document.getElementById("search-input").value.trim();
  if(!q)return;
  if(/^\\d+$/.test(q)){window.location="/block/"+q;return;}
  if(q.startsWith("did:")||q.startsWith("z6Mk")){
    var did=q.startsWith("z6Mk")?"did:key:"+q:q;
    window.location="/account/"+encodeURIComponent(did);return;
  }
  window.location="/tx/"+encodeURIComponent(q);
};
</script>
<div class="card" style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;text-align:center">
<div class="stat"><div class="stat-value">${stats.blockHeight}</div><div class="stat-label">Block Height</div></div>
<div class="stat"><div class="stat-value">${avgBlockTimeStr}</div><div class="stat-label">Block Time</div></div>
<div class="stat"><div class="stat-value">${stats.validatorCount}</div><div class="stat-label">Validators</div></div>
<div class="stat"><div class="stat-value">${stats.totalTransactions}</div><div class="stat-label">Transactions</div></div>
<div class="stat"><div class="stat-value">${tps}</div><div class="stat-label">TPS</div></div>
<div class="stat"><div class="stat-value">${stats.totalAgents}</div><div class="stat-label">Agents</div></div>
</div>
<div class="two-col">
<div>
<h2>Latest Blocks</h2>
<table><tr><th>Height</th><th>Proposer</th><th class="hide-mobile">Txs</th><th class="hide-mobile">Reward</th><th>Time</th></tr>${blockRows}</table>
<p style="text-align:center;margin:8px 0"><a href="/blocks">View all blocks &rarr;</a></p>
</div>
<div>
<h2>Latest Transactions</h2>
<table><tr><th>Hash</th><th>Type</th><th>From</th><th>To</th><th>Amount</th><th>Time</th></tr>${txRows}</table>
</div>
</div>`,
		true,
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
		"agents",
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
<p><a href="/api/v1/agent/${encodeURIComponent(agent.did)}/verify">Verify Consciousness</a></p>`,
	);
}

/**
 * Render the agent search page.
 */
export function renderAgentSearch(): string {
	return layout(
		"Agent Lookup",
		"agents",
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
	const shortProposer = block.proposer === "genesis" ? "genesis" : block.proposer.length > 40 ? `${block.proposer.slice(0, 20)}...${block.proposer.slice(-8)}` : block.proposer;
	const txRows = block.transactions
		.map(
			(tx) => {
				const typeLabel = tx.type.replace(/_/g, " ").toUpperCase();
				const shortFrom = tx.from.length > 24 ? `${tx.from.slice(0, 16)}...${tx.from.slice(-6)}` : tx.from;
				const shortTo = tx.to.length > 24 ? `${tx.to.slice(0, 16)}...${tx.to.slice(-6)}` : tx.to;
				return `<tr><td><span class="badge badge-basic">${typeLabel}</span></td><td>${shortFrom}</td><td>${shortTo}</td><td>${formatEnsl(tx.amount)}</td></tr>`;
			},
		)
		.join("");

	return layout(
		`Block ${block.height}`,
		"blocks",
		`<h2>Block #${block.height}</h2>
<div class="card">
<p><strong>Block Hash:</strong> <code>${block.hash}</code></p>
<p><strong>Parent Hash:</strong> <code>${block.parentHash.slice(0, 20)}...${block.parentHash.slice(-8)}</code></p>
<p><strong>Proposer:</strong> <a href="/account/${encodeURIComponent(block.proposer)}">${shortProposer}</a></p>
<p><strong>Timestamp:</strong> ${new Date(block.timestamp).toISOString()} (${timeAgo(block.timestamp)})</p>
<p><strong>Transactions:</strong> ${block.txCount}</p>
</div>
${block.txCount > 0 ? `<h3>Transactions (${block.txCount})</h3><table><tr><th>Type</th><th>From</th><th>To</th><th>Amount</th></tr>${txRows}</table>` : "<p>Empty block (heartbeat)</p>"}
<div style="display:flex;justify-content:space-between;margin:16px 0">
<a href="/block/${block.height - 1}">&larr; Block ${block.height - 1}</a>
<a href="/block/${block.height + 1}">Block ${block.height + 1} &rarr;</a>
</div>`,
	);
}

/**
 * Render the blocks list page.
 */
export function renderBlockList(blocks: BlockData[], page: number, totalHeight: number): string {
	const perPage = 50;
	const totalPages = Math.ceil(totalHeight / perPage);
	const rows = blocks
		.map(
			(b) => {
				const time = b.timestamp ? timeAgo(b.timestamp) : "";
				const proposerShort = b.proposer.length > 24 ? `${b.proposer.slice(0, 20)}...` : b.proposer;
				return `<tr><td><a href="/block/${b.height}">${b.height}</a></td><td>${b.txCount}</td><td>${proposerShort}</td><td>${time}</td></tr>`;
			},
		)
		.join("");

	const prevLink = page > 1 ? `<a href="/blocks?page=${page - 1}" class="btn btn-secondary" style="padding:4px 12px;font-size:0.85em">&laquo; Prev</a>` : "";
	const nextLink = page < totalPages ? `<a href="/blocks?page=${page + 1}" class="btn btn-secondary" style="padding:4px 12px;font-size:0.85em">Next &raquo;</a>` : "";

	return layout(
		"Blocks",
		"blocks",
		`<h2>Blocks</h2>
<div style="display:flex;gap:12px;align-items:center;margin-bottom:12px">
<form action="/blocks" method="get" style="display:flex;gap:8px">
<input name="height" class="search" placeholder="Jump to height..." style="width:180px">
<button type="submit" class="btn btn-secondary" style="padding:4px 12px;font-size:0.85em">Go</button>
</form>
<span style="color:var(--text-secondary);font-size:0.85em">Page ${page} of ${totalPages} (${totalHeight} blocks)</span>
</div>
<table><tr><th>Height</th><th>Txs</th><th>Proposer</th><th>Age</th></tr>${rows}</table>
<div style="display:flex;justify-content:space-between;margin-top:12px">${prevLink}${nextLink}</div>`,
	);
}

/**
 * Render the transactions page.
 */
export function renderTransactions(
	txs: Array<{ height: number; type: string; from: string; to: string; amount: string; timestamp: number }>,
	page: number,
	totalTxs: number,
	search: string,
): string {
	const perPage = 50;
	const totalPages = Math.max(1, Math.ceil(totalTxs / perPage));
	const rows = txs
		.map((tx) => {
			const fromShort = tx.from.length > 24 ? `${tx.from.slice(0, 18)}...${tx.from.slice(-4)}` : tx.from;
			const time = tx.timestamp ? timeAgo(tx.timestamp) : "";
			const typeBadge = tx.type === "consciousness_store"
				? '<span style="color:#7c3aed">consciousness</span>'
				: tx.type === "agent_register"
					? '<span style="color:#4ade80">register</span>'
					: tx.type === "transfer"
						? '<span style="color:#60a5fa">transfer</span>'
						: tx.type === "stake"
							? '<span style="color:#fbbf24">stake</span>'
							: tx.type === "delegate"
								? '<span style="color:#f472b6">delegate</span>'
								: `<span>${tx.type}</span>`;
			return `<tr><td><a href="/block/${tx.height}">${tx.height}</a></td><td>${typeBadge}</td><td><a href="/account/${encodeURIComponent(tx.from)}">${fromShort}</a></td><td>${time}</td></tr>`;
		})
		.join("");

	const prevLink = page > 1 ? `<a href="/transactions?page=${page - 1}${search ? "&search=" + encodeURIComponent(search) : ""}" class="btn btn-secondary" style="padding:4px 12px;font-size:0.85em">&laquo; Prev</a>` : "";
	const nextLink = page < totalPages ? `<a href="/transactions?page=${page + 1}${search ? "&search=" + encodeURIComponent(search) : ""}" class="btn btn-secondary" style="padding:4px 12px;font-size:0.85em">Next &raquo;</a>` : "";

	return layout(
		"Transactions",
		"transactions",
		`<h2>Transactions</h2>
<div style="display:flex;gap:12px;align-items:center;margin-bottom:12px">
<form action="/transactions" method="get" style="display:flex;gap:8px">
<input name="search" class="search" placeholder="Search by DID or type..." value="${search}" style="width:240px">
<button type="submit" class="btn btn-secondary" style="padding:4px 12px;font-size:0.85em">Search</button>
</form>
<span style="color:var(--text-secondary);font-size:0.85em">${totalTxs} total transactions</span>
</div>
<table><tr><th>Block</th><th>Type</th><th>Sender</th><th>Age</th></tr>${rows}</table>
<div style="display:flex;justify-content:space-between;margin-top:12px">${prevLink}${nextLink}</div>`,
	);
}

/**
 * Render the validators page.
 */
export function renderValidators(validators: ValidatorData[]): string {
	const online = validators.filter((v) => v.uptimePercent > 0).length;
	const totalStakeWei = validators.reduce((s, v) => s + BigInt(v.stake || "0"), 0n);
	const totalStake = formatEnsl(totalStakeWei.toString());

	const rows = validators
		.map(
			(v, i) => {
				const shortDid = v.did.length > 40 ? `${v.did.slice(0, 16)}...${v.did.slice(-6)}` : v.did;
				const stakeEnsl = formatEnsl(v.stake);
				const statusDot = v.uptimePercent > 0
					? '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#4ade80"></span>'
					: '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#f87171"></span>';
				const tier = v.tier ?? "genesis";
				const tierBadge = tier === "pioneer"
					? ' <span class="badge badge-anchored">PIONEER</span>'
					: tier === "genesis" || tier === "foundation"
						? ' <span class="badge badge-sovereign">FOUNDATION</span>'
						: tier === "open"
							? ' <span class="badge badge-verified">OPEN</span>'
							: "";
				return `<tr data-stake="${v.stake}" data-blocks="${v.blocksProduced}" data-uptime="${v.uptimePercent}"><td>${i + 1}</td><td><a href="/account/${encodeURIComponent(v.did)}">${shortDid}</a>${tierBadge}</td><td>${statusDot}</td><td>${stakeEnsl}</td><td>${v.blocksProduced}</td><td>${v.uptimePercent.toFixed(1)}%</td></tr>`;
			},
		)
		.join("");

	return layout(
		"Validators",
		"validators",
		`<h2>Network Validators</h2>
<input class="search" id="v-search" placeholder="Search by DID..." oninput="filterTable()">
<div class="card" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:12px;text-align:center">
<div class="stat"><div class="stat-value">${validators.length}</div><div class="stat-label">Total</div></div>
<div class="stat"><div class="stat-value">${online}</div><div class="stat-label">Online</div></div>
<div class="stat"><div class="stat-value">${totalStake}</div><div class="stat-label">Total Staked</div></div>
</div>
<table id="v-table"><thead><tr><th onclick="sortTable(0)">#</th><th onclick="sortTable(1)">Validator</th><th>Status</th><th onclick="sortTable(3)">Stake</th><th onclick="sortTable(4)">Blocks</th><th onclick="sortTable(5)">Uptime</th></tr></thead><tbody>${rows}</tbody></table>
<script>
function sortTable(col){
  var t=document.getElementById("v-table"),tbody=t.querySelector("tbody"),rows=Array.from(tbody.querySelectorAll("tr"));
  var asc=t.getAttribute("data-sort-col")==String(col)&&t.getAttribute("data-sort-dir")!=="asc";
  t.setAttribute("data-sort-col",String(col));t.setAttribute("data-sort-dir",asc?"asc":"desc");
  rows.sort(function(a,b){
    var av=a.cells[col].textContent.replace(/[^0-9.-]/g,""),bv=b.cells[col].textContent.replace(/[^0-9.-]/g,"");
    var an=parseFloat(av)||0,bn=parseFloat(bv)||0;
    if(an!==bn)return asc?an-bn:bn-an;
    return asc?av.localeCompare(bv):bv.localeCompare(av);
  });
  rows.forEach(function(r){tbody.appendChild(r)});
}
function filterTable(){
  var q=document.getElementById("v-search").value.toLowerCase();
  var rows=document.querySelectorAll("#v-table tbody tr");
  rows.forEach(function(r){r.style.display=r.textContent.toLowerCase().includes(q)?"":"none"});
}
</script>`,
	);
}

/**
 * Render the wallets/accounts list page.
 */
export function renderWallets(
	data: {
		accounts: Array<{ did: string; balance: string; stakedBalance: string; delegatedBalance: string; total: string; totalEnsl: number; label: string; nonce: number; lastActivity: number }>;
		total: number; page: number; pages: number;
	},
	search: string,
): string {
	const rows = data.accounts.map((a, i) => {
		const shortDid = a.did.length > 40 ? `${a.did.slice(0, 16)}...${a.did.slice(-6)}` : a.did;
		const balance = formatEnsl(a.balance);
		const staked = formatEnsl(a.stakedBalance);
		const delegated = formatEnsl(a.delegatedBalance);
		const total = formatEnsl(a.total);
		const labelBadge = a.label === "Foundation Validator"
			? '<span class="badge badge-sovereign">VALIDATOR</span>'
			: a.label === "Cloud Validator"
				? '<span class="badge badge-anchored">CLOUD</span>'
				: a.label === "Agent"
					? '<span class="badge badge-verified">AGENT</span>'
					: a.label === "Delegator"
						? '<span class="badge" style="background:#6366f1;color:white">DELEGATOR</span>'
						: a.label === "Protocol"
							? '<span class="badge" style="background:#f59e0b;color:black">PROTOCOL</span>'
							: `<span class="badge">${a.label.toUpperCase()}</span>`;
		const rank = ((data.page - 1) * 50) + i + 1;
		return `<tr><td>${rank}</td><td><a href="/account/${encodeURIComponent(a.did)}">${shortDid}</a> ${labelBadge}</td><td>${balance}</td><td>${staked}</td><td>${delegated}</td><td><strong>${total}</strong></td></tr>`;
	}).join("");

	const prevDisabled = data.page <= 1 ? "disabled" : "";
	const nextDisabled = data.page >= data.pages ? "disabled" : "";
	const pagination = data.pages > 1
		? `<div style="margin:16px 0;display:flex;gap:8px;align-items:center;justify-content:center">
			<a href="/wallets?page=${data.page - 1}&search=${encodeURIComponent(search)}" class="btn" ${prevDisabled} style="padding:4px 12px;border:1px solid #333;border-radius:4px;color:#ccc;text-decoration:none">Prev</a>
			<span>Page ${data.page} of ${data.pages} (${data.total} accounts)</span>
			<a href="/wallets?page=${data.page + 1}&search=${encodeURIComponent(search)}" class="btn" ${nextDisabled} style="padding:4px 12px;border:1px solid #333;border-radius:4px;color:#ccc;text-decoration:none">Next</a>
		</div>`
		: `<div style="margin:8px 0;color:#888">${data.total} accounts</div>`;

	return layout(
		"Wallets",
		"wallets",
		`<h2>All Accounts</h2>
<form method="get" action="/wallets" style="margin:12px 0">
<input class="search" name="search" value="${search}" placeholder="Search by DID or label..." autofocus>
</form>
${pagination}
<table id="w-table"><thead><tr>
<th onclick="sortTable(0,'w-table')">#</th>
<th onclick="sortTable(1,'w-table')">Account</th>
<th onclick="sortTable(2,'w-table')">Available</th>
<th onclick="sortTable(3,'w-table')">Staked</th>
<th onclick="sortTable(4,'w-table')">Delegated</th>
<th onclick="sortTable(5,'w-table')">Total</th>
</tr></thead><tbody>${rows}</tbody></table>
${pagination}
<script>
function sortTable(col,tid){
  var t=document.getElementById(tid),tbody=t.querySelector("tbody"),rows=Array.from(tbody.querySelectorAll("tr"));
  var asc=t.getAttribute("data-sort-col")==String(col)&&t.getAttribute("data-sort-dir")!=="asc";
  t.setAttribute("data-sort-col",String(col));t.setAttribute("data-sort-dir",asc?"asc":"desc");
  rows.sort(function(a,b){
    var av=a.cells[col].textContent.replace(/[^0-9.-]/g,""),bv=b.cells[col].textContent.replace(/[^0-9.-]/g,"");
    var an=parseFloat(av)||0,bn=parseFloat(bv)||0;
    if(an!==bn)return asc?an-bn:bn-an;
    return asc?av.localeCompare(bv):bv.localeCompare(av);
  });
  rows.forEach(function(r){tbody.appendChild(r)});
}
</script>`,
	);
}

/**
 * Render a transaction detail page.
 */
export function renderTransaction(tx: TxData, block: BlockData): string {
	const typeLabel = tx.type.replace(/_/g, " ").toUpperCase();
	const shortFrom = tx.from.length > 40 ? `${tx.from.slice(0, 20)}...${tx.from.slice(-8)}` : tx.from;
	const shortTo = tx.to.length > 40 ? `${tx.to.slice(0, 20)}...${tx.to.slice(-8)}` : tx.to;

	return layout(
		`Transaction ${tx.hash.slice(0, 16)}`,
		"blocks",
		`<h2>Transaction Details</h2>
<div class="card">
<p><strong>Hash:</strong> <code style="word-break:break-all">${tx.hash}</code></p>
<p><strong>Status:</strong> <span class="badge badge-verified">CONFIRMED</span></p>
<p><strong>Block:</strong> <a href="/block/${block.height}">#${block.height}</a></p>
<p><strong>Timestamp:</strong> ${new Date(tx.timestamp).toISOString()} (${timeAgo(tx.timestamp)})</p>
</div>
<div class="card">
<p><strong>Type:</strong> <span class="badge badge-basic">${typeLabel}</span></p>
<p><strong>From:</strong> <a href="/account/${encodeURIComponent(tx.from)}">${shortFrom}</a></p>
<p><strong>To:</strong> <a href="/account/${encodeURIComponent(tx.to)}">${shortTo}</a></p>
<p><strong>Amount:</strong> ${formatEnsl(tx.amount)}</p>
</div>`,
	);
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	if (bytes < 1024 * 1024 * 1024)
		return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function timeAgo(ts: number): string {
	const diff = Math.floor((Date.now() - ts) / 1000);
	if (diff < 60) return `${diff}s ago`;
	if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
	if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
	return `${Math.floor(diff / 86400)}d ago`;
}

function formatEnsl(amountStr: string): string {
	try {
		const wei = BigInt(amountStr);
		const whole = wei / (10n ** 18n);
		return `${whole.toLocaleString()} ENSL`;
	} catch {
		return amountStr;
	}
}

/**
 * Render an account/wallet detail page.
 */
export function renderAccount(
	did: string,
	account: Record<string, string> | null,
	isValidator: boolean,
	validatorData: { blocksProduced: number; stake: string } | null,
	txs: Array<{ hash: string; type: string; from: string; to: string; amount: string; timestamp: number; blockHeight: number }>,
	totalTxs = 0,
	page = 1,
	totalPages = 1,
): string {
	const shortDid = did.length > 40 ? `${did.slice(0, 20)}...${did.slice(-8)}` : did;
	const balance = formatEnsl(account?.balance ?? "0");
	const staked = formatEnsl(account?.staked ?? "0");
	const delegated = formatEnsl(account?.delegated ?? "0");
	const totalWei = BigInt(account?.balance ?? "0") + BigInt(account?.staked ?? "0") + BigInt(account?.delegated ?? "0");
	const total = formatEnsl(totalWei.toString());
	const credits = account?.storageCredits ?? "0";

	let badges = "";
	if (isValidator) badges += '<span class="badge badge-verified">VALIDATOR</span> ';
	// Agent badge would require checking consciousness store

	const txRows = txs.slice(0, 50).map((tx) => {
		const typeLabel = tx.type.replace(/_/g, " ").toUpperCase();
		const shortFrom = tx.from.length > 30 ? `${tx.from.slice(0, 14)}...${tx.from.slice(-6)}` : tx.from;
		const shortTo = tx.to.length > 30 ? `${tx.to.slice(0, 14)}...${tx.to.slice(-6)}` : tx.to;
		const direction = tx.from === did ? "OUT" : "IN";
		return `<tr>
			<td><a href="/block/${tx.blockHeight}">${tx.blockHeight}</a></td>
			<td><span class="badge badge-basic">${typeLabel}</span></td>
			<td>${direction === "OUT" ? shortFrom : `<a href="/account/${encodeURIComponent(tx.from)}">${shortFrom}</a>`}</td>
			<td>${direction === "IN" ? shortTo : `<a href="/account/${encodeURIComponent(tx.to)}">${shortTo}</a>`}</td>
			<td>${formatEnsl(tx.amount)}</td>
			<td>${timeAgo(tx.timestamp)}</td>
		</tr>`;
	}).join("");

	let validatorSection = "";
	if (isValidator && validatorData) {
		validatorSection = `
		<h2>Validator Stats</h2>
		<div class="card">
			<div class="stat"><div class="stat-value">${validatorData.blocksProduced}</div><div class="stat-label">Blocks Produced</div></div>
			<div class="stat"><div class="stat-value">${formatEnsl(validatorData.stake)}</div><div class="stat-label">Total Stake</div></div>
			<div class="stat"><div class="stat-value">10%</div><div class="stat-label">Commission</div></div>
		</div>`;
	}

	return layout(
		`Account ${shortDid}`,
		"agents",
		`<h2>Account</h2>
<div class="card">
<p><strong>DID:</strong> <code style="font-size:0.85em;word-break:break-all">${did}</code></p>
<p>${badges}</p>
</div>
<div class="card" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;text-align:center">
<div class="stat"><div class="stat-value">${balance}</div><div class="stat-label">Available</div></div>
<div class="stat"><div class="stat-value">${staked}</div><div class="stat-label">Staked</div></div>
<div class="stat"><div class="stat-value">${delegated}</div><div class="stat-label">Delegated</div></div>
<div class="stat"><div class="stat-value">${total}</div><div class="stat-label">Total</div></div>
<div class="stat"><div class="stat-value">${credits}</div><div class="stat-label">Storage Credits</div></div>
</div>
${validatorSection}
<h2>Transactions (${totalTxs})</h2>
${txs.length > 0 ? `<table><tr><th>Block</th><th>Type</th><th>From</th><th>To</th><th>Amount</th><th>Time</th></tr>${txRows}</table>` : '<p style="color:#888">No transactions found for this account.</p>'}
${totalPages > 1 ? `<div class="pagination">${page > 1 ? `<a href="/account/${encodeURIComponent(did)}?page=${page - 1}">&larr; Prev</a>` : ""}${Array.from({ length: Math.min(totalPages, 10) }, (_, i) => i + 1).map((p) => `<a href="/account/${encodeURIComponent(did)}?page=${p}" class="${p === page ? "active" : ""}">${p}</a>`).join("")}${page < totalPages ? `<a href="/account/${encodeURIComponent(did)}?page=${page + 1}">Next &rarr;</a>` : ""}</div>` : ""}`,
	);
}
