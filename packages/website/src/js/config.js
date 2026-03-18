/**
 * Site-wide configuration for ensoul.dev.
 *
 * Change EXPLORER_URL when the tunnel URL changes or when a permanent
 * domain is set up. All nav links with class "explorer-link" will be
 * updated automatically.
 */

(function () {
	"use strict";

	// ── Edit this URL when the explorer location changes ──
	var EXPLORER_URL = "http://localhost:3000";

	// Update all explorer links in the page
	var links = document.querySelectorAll("a.explorer-link");
	for (var i = 0; i < links.length; i++) {
		links[i].setAttribute("href", EXPLORER_URL);
	}
})();
