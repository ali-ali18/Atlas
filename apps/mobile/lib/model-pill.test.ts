import { describe, expect, it } from "vitest";
import { buildCatalog, parseModels } from "./model-catalog";
import { modelPill, pillAccessibilityLabel, shortModelName } from "./model-pill";

describe("shortModelName", () => {
	it("tira o 'Claude' do começo", () => {
		expect(shortModelName("Claude Opus 5.5")).toBe("Opus 5.5");
		expect(shortModelName("Claude Haiku 5.5")).toBe("Haiku 5.5");
		expect(shortModelName("claude sonnet 4")).toBe("sonnet 4");
	});
	it("nome curto fica como está", () => {
		expect(shortModelName("GPT-5.1")).toBe("GPT-5.1");
		expect(shortModelName("DeepSeek V4.1 Flash")).toBe("DeepSeek V4.1 Flash".length <= 18 ? "DeepSeek V4.1 Flash" : "DeepSeek V4.1 Fla…");
	});
	it("nome longo é cortado em 18 caracteres com reticências", () => {
		const short = shortModelName("Llama 3.1 Nemotron 70B Instruct");
		expect(short).toHaveLength(18);
		expect(short.endsWith("…")).toBe(true);
		expect(shortModelName("x".repeat(18))).toBe("x".repeat(18));
		expect(shortModelName("x".repeat(19))).toHaveLength(18);
	});
});

describe("modelPill", () => {
	const models = parseModels({
		models: [
			{ id: "anthropic/claude-opus-5.5", name: "Anthropic: Claude Opus 5.5", contextLength: 1_000_000, supportedParameters: ["tools", "reasoning"] },
			{ id: "deepseek/deepseek-v4.1-flash", name: "DeepSeek: DeepSeek V4.1 Flash", contextLength: 128_000, supportedParameters: ["tools"] },
		],
	})!;
	const catalog = (model: string | null, known = true) => buildCatalog({ models, tierIds: [], bot: { known, model, tiers: false } });
	it("modelo com raciocínio mostra o esforço escolhido em pt-BR", () => {
		const choice = { mode: "model" as const, model: "anthropic/claude-opus-5.5", effort: "medium" as const };
		expect(modelPill(choice, catalog(null))).toEqual({ name: "Opus 5.5", effort: "Médio" });
		expect(modelPill({ ...choice, effort: "high" }, catalog(null)).effort).toBe("Alto");
		expect(modelPill({ ...choice, effort: "low" }, catalog(null)).effort).toBe("Baixo");
		expect(modelPill({ ...choice, effort: "off" }, catalog(null)).effort).toBe("Desligado");
	});
	it("'Padrão do modelo' (sem esforço escolhido) não aparece", () => {
		expect(modelPill({ mode: "model", model: "anthropic/claude-opus-5.5" }, catalog(null))).toEqual({ name: "Opus 5.5", effort: null });
	});
	it("modelo sem raciocínio mostra só o nome, mesmo com esforço salvo", () => {
		expect(modelPill({ mode: "model", model: "deepseek/deepseek-v4.1-flash", effort: "high" }, catalog(null))).toEqual({ name: "DeepSeek V4.1 Fla…", effort: null });
	});
	it("Automático, modelo do bot sem escolha, e 'Modelo' quando não dá para saber", () => {
		expect(modelPill({ mode: "auto" }, catalog(null))).toEqual({ name: "Automático", effort: null });
		expect(modelPill(null, catalog("anthropic/claude-opus-5.5"))).toEqual({ name: "Opus 5.5", effort: null });
		expect(modelPill(null, catalog(null))).toEqual({ name: "Automático", effort: null });
		expect(modelPill(null, catalog(null, false))).toEqual({ name: "Modelo", effort: null });
		expect(modelPill(null, null)).toEqual({ name: "Modelo", effort: null });
	});
	it("rótulo de acessibilidade", () => {
		expect(pillAccessibilityLabel({ name: "Opus 5.5", effort: "Médio" })).toBe("Modelo: Opus 5.5, esforço Médio. Trocar modelo");
		expect(pillAccessibilityLabel({ name: "Automático", effort: null })).toBe("Modelo: Automático. Trocar modelo");
	});
});
