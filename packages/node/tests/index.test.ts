import { describe, expect, it } from "vitest";
import { NodeModule } from "../src/index.js";

describe("@ensoul/node", () => {
	it("should export the module descriptor", () => {
		expect(NodeModule.name).toBe("@ensoul/node");
	});
});
