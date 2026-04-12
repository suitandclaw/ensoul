import * as core from "@actions/core";
import { Ensoul } from "@ensoul-network/sdk";

async function run(): Promise<void> {
	const consciousness = core.getInput("consciousness", { required: true });
	const seedInput = core.getInput("seed");
	const apiUrl = core.getInput("api_url") || "https://api.ensoul.dev";
	const referrer = core.getInput("referrer");

	const config = { apiUrl };

	let agent: Ensoul;
	let isNewAgent = false;

	if (seedInput) {
		core.info("Importing existing identity from seed...");
		agent = await Ensoul.fromSeed(seedInput, config);
		core.info(`DID: ${agent.did}`);
	} else {
		core.info("No seed provided. Generating new Ed25519 keypair...");
		agent = await Ensoul.createAgent(config);
		isNewAgent = true;
		core.info(`DID: ${agent.did}`);
		core.warning(
			"New agent created. Save the seed output as a GitHub secret " +
			"(e.g. ENSOUL_SEED) and pass it on future runs to reuse this identity.",
		);
	}

	// Set seed output (masked in logs)
	const seed = agent.seed;
	core.setSecret(seed);
	core.setOutput("seed", seed);
	core.setOutput("did", agent.did);

	// Check if already registered
	const agentRes = await fetch(`${apiUrl}/v1/agents/${agent.did}`);
	const agentData = agentRes.ok
		? (await agentRes.json()) as Record<string, unknown>
		: null;

	const alreadyRegistered = agentData?.["registered"] === true;

	if (!alreadyRegistered) {
		core.info("Registering agent on-chain...");
		const regOpts: { referredBy?: string } = {};
		if (referrer) {
			regOpts.referredBy = referrer;
		}
		const regResult = await agent.register(regOpts);
		if (regResult.registered) {
			core.info(`Registration confirmed (on-chain: ${regResult.onChain ?? false})`);
		} else {
			core.warning(`Registration returned: ${regResult.error ?? "unknown issue"}`);
		}
		core.setOutput("registered", String(regResult.registered));
	} else {
		core.info("Agent already registered on-chain.");
		core.setOutput("registered", "true");
	}

	// Determine consciousness version
	let version = 1;
	if (alreadyRegistered && agentData) {
		const currentVersion = Number(agentData["consciousnessVersion"] ?? 0);
		version = currentVersion + 1;
		core.info(`Updating consciousness: version ${currentVersion} -> ${version}`);
	} else {
		core.info("Storing initial consciousness (version 1)...");
	}

	// Build consciousness payload
	const payload: Record<string, unknown> = {
		description: consciousness,
		repository: process.env["GITHUB_REPOSITORY"] ?? "unknown",
		sha: process.env["GITHUB_SHA"] ?? "unknown",
		ref: process.env["GITHUB_REF"] ?? "unknown",
		runId: process.env["GITHUB_RUN_ID"] ?? "unknown",
		timestamp: new Date().toISOString(),
	};

	const result = await agent.storeConsciousness(payload, version);

	if (!result.applied) {
		core.setFailed(`Consciousness store failed: ${result.error ?? "unknown error"}`);
		return;
	}

	core.info(`Consciousness anchored at block ${result.height}`);
	core.info(`State root: ${result.stateRoot}`);
	core.info(`Version: ${version}`);

	core.setOutput("block_height", String(result.height));
	core.setOutput("state_root", result.stateRoot);
	core.setOutput("version", String(version));

	// Fetch consciousness age
	const updatedRes = await fetch(`${apiUrl}/v1/agents/${agent.did}`);
	if (updatedRes.ok) {
		const updated = (await updatedRes.json()) as Record<string, unknown>;
		const age = String(updated["consciousnessAge"] ?? 0);
		core.setOutput("consciousness_age", age);
		core.info(`Consciousness age: ${age} days`);
	} else {
		core.setOutput("consciousness_age", "0");
	}

	core.info("");
	core.info("Ensouled Handshake headers for this agent:");
	const headers = await agent.getHandshakeHeaders();
	core.info(`  X-Ensoul-Identity: ${headers["X-Ensoul-Identity"]}`);
	core.info(`  X-Ensoul-Proof: ${headers["X-Ensoul-Proof"]}`);
	core.info(`  X-Ensoul-Since: ${headers["X-Ensoul-Since"]}`);

	if (isNewAgent) {
		core.info("");
		core.info("NEXT STEP: Save the seed as a GitHub secret:");
		core.info("  gh secret set ENSOUL_SEED --body \"<seed from outputs>\"");
		core.info("Then add to your workflow:");
		core.info("  with:");
		core.info("    seed: ${{ secrets.ENSOUL_SEED }}");
	}

	core.summary
		.addHeading("Ensoul Agent", 2)
		.addTable([
			[{ data: "Field", header: true }, { data: "Value", header: true }],
			["DID", agent.did],
			["Block Height", String(result.height)],
			["State Root", result.stateRoot],
			["Version", String(version)],
			["New Agent", String(isNewAgent)],
		])
		.addLink("View on Explorer", `https://explorer.ensoul.dev/agent/${agent.did}`);
	await core.summary.write();
}

run().catch((err) => {
	core.setFailed(err instanceof Error ? err.message : String(err));
});
