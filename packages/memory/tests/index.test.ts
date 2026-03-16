import { describe, expect, it } from "vitest";
import { MemoryModule } from "../src/index.js";

describe("@ensoul/memory", () => {
	it("should export the module descriptor", () => {
		expect(MemoryModule.name).toBe("@ensoul/memory");
	});
});
