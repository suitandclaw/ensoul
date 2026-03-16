import { describe, expect, it } from "vitest";
import { SecurityModule } from "../src/index.js";

describe("@ensoul/security", () => {
	it("should export the module descriptor", () => {
		expect(SecurityModule.name).toBe("@ensoul/security");
	});
});
