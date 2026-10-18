import { describe, expect, it } from "vitest";
import { pickEffectiveModel } from "./effective-model.js";

describe("pickEffectiveModel", () => {
	const envDefault = "openai/gpt-6-luna";

	it("pedido explícito vence bot e padrão", () => {
		expect(
			pickEffectiveModel({ requested: "a/x", botModel: "b/y", envDefault }),
		).toBe("a/x");
	});

	it("sem pedido (ex.: questionário, confirm), usa o modelo do bot", () => {
		expect(pickEffectiveModel({ botModel: "anthropic/claude-sonnet-5.5", envDefault })).toBe(
			"anthropic/claude-sonnet-5.5",
		);
		expect(
			pickEffectiveModel({ requested: "  ", botModel: "b/y", envDefault }),
		).toBe("b/y");
	});

	it("sem pedido e sem modelo no bot, cai no padrão do ambiente", () => {
		expect(pickEffectiveModel({ botModel: null, envDefault })).toBe(envDefault);
	});
});
