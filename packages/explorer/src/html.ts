import type { BlockData, TxData, AgentProfile, ValidatorData, NetworkStats } from "./types.js";

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&family=Plus+Jakarta+Sans:wght@600;700;800&family=JetBrains+Mono:wght@400;500&display=swap');

*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: 'IBM Plex Sans', system-ui, sans-serif; background: #09090b; color: #a1a1aa; line-height: 1.6; -webkit-font-smoothing: antialiased; font-size: 15px; padding-top: 56px; }
a { color: #7c5bf5; text-decoration: none; transition: color 0.2s; }
a:hover { color: #fafafa; }

/* -- Fixed nav -- */
.site-nav { position: fixed; top: 0; left: 0; right: 0; z-index: 1000; background: rgba(9,9,11,0.85); backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px); border-bottom: 1px solid transparent; transition: border-color 300ms; }
.site-nav.scrolled { border-bottom-color: rgba(255,255,255,0.06); }
.site-nav .inner { max-width: 1120px; margin: 0 auto; padding: 0 24px; height: 56px; display: flex; align-items: center; gap: 24px; }
.site-nav .logo { font-family: 'Plus Jakarta Sans', sans-serif; font-size: 1rem; font-weight: 800; letter-spacing: 0.005em; color: #fafafa; white-space: nowrap; display: inline-flex; align-items: center; gap: 8px; }
.site-nav .logo-live { display: inline-flex; align-items: center; gap: 5px; margin-left: 10px; font-size: 0.6875rem; color: #22c55e; font-weight: 500; }
.site-nav .logo-live-dot { width: 5px; height: 5px; border-radius: 50%; background: #22c55e; animation: livePulse 2.5s ease-in-out infinite; }
@keyframes livePulse { 0%,100%{opacity:1} 50%{opacity:0.4} }
.site-nav .hamburger { display: none; background: none; border: none; color: #a1a1aa; font-size: 1.2rem; padding: 8px; cursor: pointer; margin-left: auto; }
.site-nav .links { display: flex; gap: 24px; margin-left: auto; align-items: center; }
.site-nav .links a { color: #52525b; font-size: 0.875rem; font-weight: 500; }
.site-nav .links a:hover { color: #fafafa; }
.site-nav .links a.active { color: #fafafa; }

/* -- Explorer sub-nav -- */
.explorer-nav { max-width: 1080px; margin: 0 auto; padding: 16px 24px 0; display: flex; gap: 20px; border-bottom: 1px solid rgba(255,255,255,0.04); overflow-x: auto; -webkit-overflow-scrolling: touch; }
.explorer-nav a { color: #52525b; font-size: 0.8125rem; font-weight: 500; padding: 8px 2px 12px; border-bottom: 2px solid transparent; white-space: nowrap; transition: all 0.2s; }
.explorer-nav a:hover { color: #fafafa; }
.explorer-nav a.active { color: #fafafa; border-bottom-color: #7c5bf5; }

/* -- Content -- */
.content { max-width: 1080px; margin: 0 auto; padding: 32px 24px; }
h1 { font-family: 'Plus Jakarta Sans', sans-serif; color: #fafafa; margin-bottom: 8px; font-size: 1.75rem; font-weight: 700; letter-spacing: -0.02em; }
h2 { font-family: 'Plus Jakarta Sans', sans-serif; color: #fafafa; padding-bottom: 10px; margin-top: 32px; margin-bottom: 14px; font-size: 1.125rem; font-weight: 600; border-bottom: 1px solid rgba(255,255,255,0.04); }

/* -- Cards -- */
.card { background: #111113; border: 1px solid rgba(255,255,255,0.04); border-radius: 12px; padding: 20px; margin: 12px 0; overflow-x: auto; transition: background 0.2s, border-color 0.2s; }
.card:hover { background: #131316; border-color: rgba(255,255,255,0.06); }

/* -- Stats -- */
.stat { display: inline-block; margin: 0 24px 12px 0; }
.stat-value { font-family: 'JetBrains Mono', monospace; font-size: 1.5rem; font-weight: 500; color: #fafafa; font-variant-numeric: tabular-nums; letter-spacing: -0.01em; }
.stat-label { font-size: 0.6875rem; color: #52525b; text-transform: uppercase; letter-spacing: 0.08em; margin-top: 2px; }

/* -- Badges (updated with validator tier colors) -- */
.badge { display: inline-flex; align-items: center; padding: 3px 10px; border-radius: 100px; font-size: 0.6875rem; font-weight: 600; letter-spacing: 0.02em; white-space: nowrap; font-family: 'JetBrains Mono', monospace; text-transform: uppercase; }
.badge-basic { background: rgba(52,211,153,0.1); color: #34d399; }
.badge-verified { background: rgba(96,165,250,0.1); color: #60a5fa; }
.badge-anchored { background: rgba(124,91,245,0.12); color: #9b7dff; }
.badge-immortal { background: rgba(236,72,153,0.1); color: #ec4899; }
.badge-sovereign { background: rgba(251,191,36,0.1); color: #fbbf24; }
.badge-alive { background: rgba(34,197,94,0.1); color: #22c55e; }
.badge-dead { background: rgba(239,68,68,0.1); color: #ef4444; }
.badge-pioneer { background: rgba(251,191,36,0.12); color: #fbbf24; }
.badge-genesis { background: rgba(124,91,245,0.12); color: #9b7dff; }
.badge-foundation { background: rgba(161,161,170,0.1); color: #a1a1aa; }

/* -- Tables -- */
table { width: 100%; border-collapse: collapse; margin: 10px 0; }
th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid rgba(255,255,255,0.04); font-size: 0.875rem; }
th { color: #52525b; font-weight: 500; text-transform: uppercase; font-size: 0.6875rem; letter-spacing: 0.08em; cursor: pointer; user-select: none; font-family: 'JetBrains Mono', monospace; }
th:hover { color: #fafafa; }
tbody tr { transition: background 0.15s; }
tbody tr:hover { background: rgba(255,255,255,0.015); }
td { color: #a1a1aa; }
td code { font-family: 'JetBrains Mono', monospace; }

/* -- Forms -- */
.search { width: 100%; padding: 10px 14px; background: #111113; border: 1px solid rgba(255,255,255,0.04); border-radius: 8px; color: #fafafa; font-size: 0.9375rem; margin: 8px 0; font-family: 'JetBrains Mono', monospace; transition: border-color 0.2s; }
.search:focus { outline: none; border-color: rgba(124,91,245,0.4); }

/* -- Code -- */
code { background: #0c0c0e; border-radius: 4px; padding: 2px 6px; font-family: 'JetBrains Mono', monospace; font-size: 0.8125rem; word-break: break-all; color: #fafafa; }

/* -- Footer -- */
.footer { max-width: 1080px; margin: 48px auto 0; padding: 32px 24px; text-align: center; color: #52525b; font-size: 0.8125rem; border-top: 1px solid rgba(255,255,255,0.04); font-style: italic; }

/* -- Pagination -- */
.pagination { display: flex; justify-content: center; gap: 4px; margin: 20px 0; flex-wrap: wrap; }
.pagination a { padding: 6px 12px; background: #111113; border: 1px solid rgba(255,255,255,0.04); border-radius: 6px; color: #a1a1aa; font-size: 0.8125rem; font-family: 'JetBrains Mono', monospace; transition: all 0.2s; }
.pagination a:hover { background: #161618; color: #fafafa; border-color: rgba(255,255,255,0.08); }
.pagination a.active { background: #7c5bf5; color: #fff; border-color: #7c5bf5; }

/* -- Layout helpers -- */
.two-col { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
.hide-mobile { }

/* -- Online/offline dots -- */
.dot-on { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: #22c55e; box-shadow: 0 0 8px rgba(34,197,94,0.4); }
.dot-off { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: #ef4444; }

/* -- Lock countdown -- */
.lock-info { display: inline-flex; align-items: center; gap: 6px; background: rgba(251,191,36,0.08); border: 1px solid rgba(251,191,36,0.15); border-radius: 8px; padding: 6px 12px; font-size: 0.8125rem; color: #fbbf24; font-family: 'JetBrains Mono', monospace; }

/* -- Mobile -- */
@media (max-width: 768px) {
  body { font-size: 14px; }
  .site-nav .hamburger { display: block; }
  .site-nav .links { display: none; position: fixed; top: 56px; right: 0; bottom: 0; width: 260px; flex-direction: column; background: #111113; border-left: 1px solid rgba(255,255,255,0.04); padding: 20px; gap: 16px; margin: 0; z-index: 200; }
  .site-nav .links.open { display: flex; }
  .explorer-nav { gap: 16px; padding: 12px 16px 0; }
  .content { padding: 20px 16px; }
  .two-col { grid-template-columns: 1fr; }
  .hide-mobile { display: none !important; }
  .stat-value { font-size: 1.25rem; }
  table { font-size: 0.8125rem; }
  th, td { padding: 8px 10px; }
  h1 { font-size: 1.375rem; }
  h2 { font-size: 1rem; }
  .card { padding: 16px; }
}
`;

function siteNav(activePage: string): string {
	const link = (href: string, label: string, id: string): string => {
		const cls = id === activePage ? ' class="active"' : "";
		return `<a href="${href}"${cls}>${label}</a>`;
	};
	return `<nav class="site-nav" id="site-nav"><div class="inner"><a href="https://ensoul.dev" class="logo"><svg viewBox="0 0 110 110" width="20" height="20"><circle cx="55" cy="55" r="42" fill="none" stroke="#7c5bf5" stroke-width="2"/><path d="M55 28 C55 28, 38 48, 38 60 C38 73, 45 82, 55 82 C65 82, 72 73, 72 60 C72 48, 55 28, 55 28 Z" fill="#7c5bf5"/><circle cx="55" cy="62" r="4" fill="white" opacity="0.9"/></svg>Ensoul<span class="logo-live"><span class="logo-live-dot"></span>Live</span></a><button class="hamburger" onclick="document.querySelector('.site-nav .links').classList.toggle('open')" aria-label="Menu"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg></button><div class="links">${link("/", "Explorer", "explorer")}${link("https://ensoul.dev/genesis", "Genesis", "genesis")}${link("https://ensoul.dev/docs/validator.html", "Validators", "validators")}${link("https://ensoul.dev/docs/quickstart.html", "Docs", "docs")}${link("https://github.com/suitandclaw/ensoul", "GitHub", "github")}${link("https://ensoul.dev/try", "Try It", "try")}</div></div></nav>`;
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
	const navScript = `<script>(function(){var n=document.getElementById("site-nav");if(!n)return;window.addEventListener("scroll",function(){if(window.scrollY>10)n.classList.add("scrolled");else n.classList.remove("scrolled");},{passive:true});})();</script>`;
	return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} - Ensoul Explorer</title><link rel="icon" type="image/x-icon" href="/favicon.ico"><link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png"><link rel="icon" type="image/png" sizes="16x16" href="/favicon-16x16.png"><link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png"><style>${CSS}</style></head><body>${siteNav("explorer")}${explorerNav(tab)}<div class="content">${content}</div><div class="footer">the persistence layer for AI agents</div>${navScript}${refreshScript}</body></html>`;
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
(function updateBlockAge(){
  var el=document.getElementById("block-age");
  if(!el)return;
  var ts=Number(el.getAttribute("data-ts")||0);
  if(!ts)return;
  setInterval(function(){
    var age=Math.round((Date.now()-ts)/1000);
    el.textContent=age+"s ago";
    el.style.color=age>60?"#f87171":"#7c3aed";
  },1000);
})();
</script>
<div class="card" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(100px,1fr));gap:10px;text-align:center">
<div class="stat"><div class="stat-value">${stats.blockHeight}</div><div class="stat-label">Block Height</div></div>
<div class="stat"><div class="stat-value" id="block-age" data-ts="${latestBlocks[0]?.timestamp ?? 0}">--</div><div class="stat-label">Last Block</div></div>
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
	const online = validators.filter((v) => v.uptimePercent !== 0 && v.uptimePercent !== -1).length;
	const totalStakeWei = validators.reduce((s, v) => s + BigInt(v.stake || "0"), 0n);
	const totalStake = formatEnsl(totalStakeWei.toString());

	const rows = validators
		.map(
			(v, i) => {
				const shortDid = v.did.length > 40 ? `${v.did.slice(0, 16)}...${v.did.slice(-6)}` : v.did;
				const stakeEnsl = formatEnsl(v.stake);
				const statusDot = v.uptimePercent !== 0 && v.uptimePercent !== -1
					? '<span class="dot-on"></span>'
					: '<span class="dot-off"></span>';
				const uptimeDisplay = v.uptimePercent < 0
					? '<span title="Collecting data (need 100+ samples)">N/A</span>'
					: `${v.uptimePercent.toFixed(1)}%`;
				const cat = v.category ?? v.tier ?? "";
				const catBadge = cat === "genesis-partners"
					? ' <span class="badge badge-genesis" style="margin-left:6px">Genesis Partner</span>'
					: cat === "foundation"
						? ' <span class="badge badge-foundation" style="margin-left:6px">Foundation</span>'
						: cat === "pioneer"
							? ' <span class="badge badge-pioneer" style="margin-left:6px">Pioneer</span>'
							: cat === "community"
								? ' <span class="badge badge-basic" style="margin-left:6px">Community</span>'
								: "";
				return `<tr data-stake="${v.stake}" data-blocks="${v.blocksProduced}" data-uptime="${v.uptimePercent}"><td>${i + 1}</td><td><a href="/account/${encodeURIComponent(v.did)}">${shortDid}</a>${catBadge}</td><td>${statusDot}</td><td>${stakeEnsl}</td><td>${v.blocksProduced}</td><td>${uptimeDisplay}</td></tr>`;
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
