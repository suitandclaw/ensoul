/**
 * Live network stats fetcher for ensoul.dev hero section.
 * Pulls from the explorer API and updates the DOM every 30 seconds.
 *
 * Configure the endpoint via:
 *   <script data-api="https://explorer.ensoul.dev" src="/js/stats.js"></script>
 * Falls back to /api/v1/status (same-origin) if not specified.
 */

(function () {
	"use strict";

	var script = document.currentScript;
	var apiBase = (script && script.getAttribute("data-api")) || "";
	var endpoint = apiBase + "/api/v1/status";
	var INTERVAL = 30000;

	function formatNumber(n) {
		if (n >= 1e9) return (n / 1e9).toFixed(1) + "B";
		if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
		if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
		return String(n);
	}

	function formatBytes(bytes) {
		if (bytes >= 1e12) return (bytes / 1e12).toFixed(1) + " TB";
		if (bytes >= 1e9) return (bytes / 1e9).toFixed(1) + " GB";
		if (bytes >= 1e6) return (bytes / 1e6).toFixed(1) + " MB";
		if (bytes >= 1e3) return (bytes / 1e3).toFixed(1) + " KB";
		return bytes + " B";
	}

	function update(data) {
		var el;
		el = document.getElementById("stat-height");
		if (el) el.textContent = formatNumber(data.blockHeight || 0);
		el = document.getElementById("stat-agents");
		if (el) el.textContent = formatNumber(data.totalAgents || 0);
		el = document.getElementById("stat-validators");
		if (el) el.textContent = formatNumber(data.validatorCount || 0);
		el = document.getElementById("stat-storage");
		if (el) el.textContent = formatBytes(data.totalConsciousnessBytes || 0);
	}

	function fallback() {
		update({ blockHeight: 0, totalAgents: 0, validatorCount: 0, totalConsciousnessBytes: 0 });
	}

	function fetchStats() {
		fetch(endpoint)
			.then(function (r) { return r.json(); })
			.then(function (data) { update(data); })
			.catch(function () { /* silent — stats stay at last known value */ });
	}

	// Initial render with zeros, then fetch real data
	fallback();
	fetchStats();
	setInterval(fetchStats, INTERVAL);
})();
