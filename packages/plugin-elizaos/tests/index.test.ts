import { describe, expect, it } from "vitest";
import { PluginElizaOSModule } from "../src/index.js";

describe("@ensoul/plugin-elizaos", () => {
	it("should export the module descriptor", () => {
		expect(PluginElizaOSModule.name).toBe("@ensoul/plugin-elizaos");
	});
});
