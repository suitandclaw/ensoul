import { describe, expect, it } from "vitest";
import { StateTreeModule } from "../src/index.js";

describe("@ensoul/state-tree", () => {
	it("should export the module descriptor", () => {
		expect(StateTreeModule.name).toBe("@ensoul/state-tree");
	});
});
