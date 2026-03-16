import { describe, expect, it } from "vitest";
import { IdentityModule } from "../src/index.js";

describe("@ensoul/identity", () => {
	it("should export the module descriptor", () => {
		expect(IdentityModule.name).toBe("@ensoul/identity");
	});
});
