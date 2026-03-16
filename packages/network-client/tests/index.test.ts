import { describe, expect, it } from "vitest";
import { NetworkClientModule } from "../src/index.js";

describe("@ensoul/network-client", () => {
	it("should export the module descriptor", () => {
		expect(NetworkClientModule.name).toBe("@ensoul/network-client");
	});
});
