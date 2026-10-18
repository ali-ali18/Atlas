import { describe, expect, it } from "vitest";
import { modelStepTelemetry } from "./step-telemetry.js";

describe("modelStepTelemetry: id da geração", () => {
	it("guarda o generationId (só metadado) e deixa o custo ausente quando desconhecido", () => {
		const t = modelStepTelemetry({
			requestedModel: "a/b",
			fallbackModelMs: 10,
			result: { model: "a/b", generationId: "gen-1", usage: { promptTokens: 5, costUnknown: true } },
		});
		expect(t.generationId).toBe("gen-1");
		expect(t).not.toHaveProperty("costUsd");
	});

	it("sem id, não inventa o campo", () => {
		const t = modelStepTelemetry({ requestedModel: "a/b", fallbackModelMs: 10, result: { model: "a/b" } });
		expect(t).not.toHaveProperty("generationId");
	});
});
