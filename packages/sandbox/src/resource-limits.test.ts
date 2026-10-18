import { describe, expect, it } from "vitest";
import { resourceLimitsOutdated, resourceLimitsUpdate } from "./docker-manager.js";

const config = { memoryBytes: 2048 * 1024 * 1024, nanoCpus: 2_000_000_000 };

describe("resourceLimitsOutdated", () => {
	it("detecta container criado com limite antigo", () => {
		expect(
			resourceLimitsOutdated(config, {
				HostConfig: { Memory: 1024 * 1024 * 1024, NanoCpus: 1_000_000_000 },
			}),
		).toBe(true);
	});

	it("não mexe quando os limites batem com a config", () => {
		expect(
			resourceLimitsOutdated(config, {
				HostConfig: { Memory: config.memoryBytes, NanoCpus: config.nanoCpus },
			}),
		).toBe(false);
	});

	it("não mexe sem HostConfig", () => {
		expect(resourceLimitsOutdated(config, {})).toBe(false);
	});
});

describe("resourceLimitsUpdate", () => {
	it("leva o swap junto com a memória", () => {
		expect(resourceLimitsUpdate(config)).toEqual({
			Memory: config.memoryBytes,
			MemorySwap: config.memoryBytes * 2,
			NanoCpus: config.nanoCpus,
		});
	});
});
