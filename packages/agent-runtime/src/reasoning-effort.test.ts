import { describe, expect, it, vi } from "vitest";
import { createReasoningEffortPicker } from "./reasoning-effort.js";

describe("createReasoningEffortPicker", () => {
	it("sem escolha não manda nada nem consulta o catálogo", async () => {
		const supports = vi.fn(() => true);
		expect(await createReasoningEffortPicker({ supportsReasoning: supports })("anthropic/claude-sonnet-5.5")).toBeUndefined();
		expect(supports).not.toHaveBeenCalled();
	});
	it("manda o nível só a modelo com suporte, por modelo", async () => {
		const pick = createReasoningEffortPicker({ effort: "low", supportsReasoning: (id) => id.includes("claude") });
		expect(await pick("anthropic/claude-sonnet-5.5")).toBe("low");
		expect(await pick("openai/gpt-4o")).toBeUndefined();
	});
	it("Desligado vira Baixo no modelo que não desliga", async () => {
		const pick = createReasoningEffortPicker({ effort: "off", supportsReasoning: () => true });
		expect(await pick("anthropic/claude-sonnet-5.5")).toBe("off");
		expect(await pick("openai/gpt-5")).toBe("low");
	});
	it("catálogo que falha não derruba: cai na curadoria", async () => {
		const pick = createReasoningEffortPicker({ effort: "high", supportsReasoning: async () => { throw new Error("catálogo fora"); } });
		expect(await pick("openai/gpt-5")).toBe("high");
		expect(await pick("someone/unknown")).toBeUndefined();
	});
});
