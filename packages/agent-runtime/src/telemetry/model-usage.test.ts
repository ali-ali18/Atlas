import { describe, expect, it } from "vitest";
import { modelUsage } from "./model-usage.js";
import { addUsage, emptyUsage } from "../budget.js";
import { modelStepTelemetry } from "./step-telemetry.js";
describe("uso do plano", () => {
	it("conta plano do pai e filhos sem custo desconhecido nem USD zero", () => {
		const u = modelUsage({
			usage: {
				promptTokens: 10,
				completionTokens: 5,
				costKind: "plan",
				reasoningTokens: 2,
			},
		});
		const total = addUsage(addUsage(emptyUsage(), u), u);
		expect(total.planCalls).toBe(2);
		expect(total.totalTokens).toBe(30);
		expect(total).not.toHaveProperty("costUsd");
		expect(total).not.toHaveProperty("costUnknownCalls");
		expect(
			addUsage(total, modelUsage({ usage: { promptTokens: 1 } }))
				.costUnknownCalls
		).toBe(1);
	});
	it("telemetria mostra provedor, reasoning e fallback sem inventar custo", () => {
		const t = modelStepTelemetry({
			requestedModel: "chatgpt/luna",
			fallbackModelMs: 1,
			result: {
				model: "chatgpt/luna",
				usage: { costKind: "plan", reasoningTokens: 2 },
			},
		});
		expect(t).toMatchObject({
			provider: "chatgpt",
			costKind: "plan",
			reasoningTokens: 2,
		});
		expect(t).not.toHaveProperty("costUsd");
		expect(
			modelStepTelemetry({
				requestedModel: "chatgpt/luna",
				fallbackModelMs: 2,
				result: {
					model: "deepseek/deepseek-v4.1-flash",
					fallbackFrom: "chatgpt/luna",
				},
			})
		).toMatchObject({ provider: "openrouter", fallbackFrom: "chatgpt/luna" });
	});
});
