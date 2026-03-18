import { describe, it, expect } from "vitest";
import { parseArgs, printHelp } from "../src/cli/args.js";
import { buildPlist } from "../src/cli/service.js";

// ── Arg parsing ──────────────────────────────────────────────────────

describe("parseArgs with service flags", () => {
	it("parses --install flag", () => {
		const args = parseArgs(["--validate", "--install"]);
		expect(args.install).toBe(true);
		expect(args.mode).toBe("validate");
	});

	it("parses --uninstall flag", () => {
		const args = parseArgs(["--uninstall"]);
		expect(args.uninstall).toBe(true);
	});

	it("parses uninstall subcommand", () => {
		const args = parseArgs(["uninstall"]);
		expect(args.uninstall).toBe(true);
	});

	it("install defaults to false", () => {
		const args = parseArgs(["--validate"]);
		expect(args.install).toBe(false);
		expect(args.uninstall).toBe(false);
	});

	it("install combines with other flags", () => {
		const args = parseArgs([
			"--validate",
			"--install",
			"--port",
			"8000",
			"--data-dir",
			"/data/ensoul",
		]);
		expect(args.install).toBe(true);
		expect(args.mode).toBe("validate");
		expect(args.port).toBe(8000);
		expect(args.dataDir).toBe("/data/ensoul");
	});

	it("help text includes --install", () => {
		const help = printHelp();
		expect(help).toContain("--install");
		expect(help).toContain("uninstall");
		expect(help).toContain("auto-start");
	});
});

// ── buildPlist ───────────────────────────────────────────────────────

describe("buildPlist", () => {
	it("generates valid plist XML structure", () => {
		const args = parseArgs(["--validate", "--port", "9000"]);
		const plist = buildPlist(args);

		expect(plist).toContain('<?xml version="1.0"');
		expect(plist).toContain("<plist version=");
		expect(plist).toContain("<key>Label</key>");
		expect(plist).toContain("dev.ensoul.validator");
	});

	it("includes RunAtLoad and KeepAlive", () => {
		const args = parseArgs(["--validate"]);
		const plist = buildPlist(args);

		expect(plist).toContain("<key>RunAtLoad</key>");
		expect(plist).toContain("<true/>");
		expect(plist).toContain("<key>KeepAlive</key>");
	});

	it("includes correct port", () => {
		const args = parseArgs(["--validate", "--port", "8888"]);
		const plist = buildPlist(args);

		expect(plist).toContain("<string>8888</string>");
	});

	it("includes correct api port", () => {
		const args = parseArgs(["--validate", "--api-port", "4000"]);
		const plist = buildPlist(args);

		expect(plist).toContain("<string>4000</string>");
	});

	it("includes data dir", () => {
		const args = parseArgs(["--validate", "--data-dir", "/data/mynode"]);
		const plist = buildPlist(args);

		expect(plist).toContain("<string>/data/mynode</string>");
	});

	it("includes --validate flag in program arguments", () => {
		const args = parseArgs(["--validate"]);
		const plist = buildPlist(args);

		expect(plist).toContain("<string>--validate</string>");
	});

	it("includes storage flag when non-default", () => {
		const args = parseArgs(["--validate", "--storage", "50"]);
		const plist = buildPlist(args);

		expect(plist).toContain("<string>--storage</string>");
		expect(plist).toContain("<string>50</string>");
	});

	it("omits storage flag when default (10)", () => {
		const args = parseArgs(["--validate"]);
		const plist = buildPlist(args);

		expect(plist).not.toContain("<string>--storage</string>");
	});

	it("includes log path in ~/.ensoul/", () => {
		const args = parseArgs(["--validate"]);
		const plist = buildPlist(args);

		expect(plist).toContain("StandardOutPath");
		expect(plist).toContain(".ensoul");
		expect(plist).toContain("validator.log");
	});

	it("includes PATH environment variable", () => {
		const args = parseArgs(["--validate"]);
		const plist = buildPlist(args);

		expect(plist).toContain("<key>PATH</key>");
		expect(plist).toContain("/usr/local/bin");
	});

	it("includes ThrottleInterval", () => {
		const args = parseArgs(["--validate"]);
		const plist = buildPlist(args);

		expect(plist).toContain("<key>ThrottleInterval</key>");
		expect(plist).toContain("<integer>5</integer>");
	});

	it("does not include --install in program arguments", () => {
		const args = parseArgs(["--validate", "--install"]);
		const plist = buildPlist(args);

		expect(plist).not.toContain("<string>--install</string>");
	});
});
