(function () {
"use strict";
var endpoint = "https://api.ensoul.dev/v1/network/status";
var INTERVAL = 30000;

function formatNumber(n) {
if (n >= 1e9) return (n / 1e9).toFixed(1) + "B";
if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
return String(n);
}

function update(data) {
var el;
el = document.getElementById("stat-height");
if (el) el.textContent = formatNumber(data.blockHeight || 0);
el = document.getElementById("stat-agents");
if (el) el.textContent = formatNumber(data.agentCount || 0);
el = document.getElementById("stat-validators");
if (el) el.textContent = "35";
el = document.getElementById("stat-storage");
if (el) el.textContent = formatNumber(data.totalConsciousnessStored || 0);
}

function fetchStats() {
fetch(endpoint)
.then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
.then(function (data) { update(data); })
.catch(function () { });
}

fetchStats();
setInterval(fetchStats, INTERVAL);
})();
