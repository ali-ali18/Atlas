import { describe, expect, it } from "vitest";
import { buildCatalog, describeModel, findOption, parseBotModel, parseModels, parseTierModelIds } from "./model-catalog";

const body = {
	models: [
		{ id: "anthropic/claude-sonnet-5.5", name: "Anthropic: Claude Sonnet 5.5", provider: "anthropic", contextLength: 200_000, inputModalities: ["text", "image"], supportedParameters: ["tools", "reasoning"] },
		{ id: "deepseek/deepseek-v4.1-flash", name: "DeepSeek: DeepSeek V4.1 Flash", provider: "deepseek", contextLength: 128_000, inputModalities: ["text"], supportedParameters: ["tools"] },
		{ id: "openai/gpt-4o-mini", name: "OpenAI: GPT-4o mini", provider: "openai", contextLength: 128_000, inputModalities: ["text", "image"], supportedParameters: ["tools"] },
		{ id: "vendor/zeta", name: "Vendor: Zeta", provider: "vendor", contextLength: null },
		{ id: "vendor/alfa", name: "Vendor: Alfa", provider: "vendor", contextLength: 32_000 },
	],
};

describe("parseModels", () => {
	it("lê o catálogo e ignora entradas inválidas e repetidas", () => {
		const parsed = parseModels({ models: [...body.models, { id: "anthropic/claude-sonnet-5.5", name: "dup" }, { name: "sem id" }, null, 3, { id: "  " }] });
		expect(parsed?.map((model) => model.id)).toEqual(body.models.map((model) => model.id));
	});
	it("resposta fora do formato = null", () => {
		for (const raw of [null, [], {}, { models: "x" }, "oi"]) expect(parseModels(raw)).toBeNull();
	});
});

describe("níveis da conta e modelo do bot", () => {
	it("principais = modelos dos níveis, Fácil a Difícil, sem repetição", () => {
		const settings = { effective: { models: { tiers: { value: { easy: ["deepseek/deepseek-v4.1-flash"], medium: ["anthropic/claude-sonnet-5.5"], hard: ["anthropic/claude-sonnet-5.5"] } } } } };
		expect(parseTierModelIds(settings)).toEqual(["deepseek/deepseek-v4.1-flash", "anthropic/claude-sonnet-5.5"]);
	});
	it("resposta ausente ou torta = sem níveis", () => {
		for (const raw of [null, {}, { effective: {} }, { effective: { models: { tiers: { value: "x" } } } }]) expect(parseTierModelIds(raw)).toEqual([]);
	});
	it("modelo do bot vem da lista de bots; outro bot, sem modelo ou resposta torta = null", () => {
		const bots = { bots: [{ id: "b1", openRouterModel: "x/y" }, { id: "b2", openRouterModel: null }, { id: "b3" }] };
		expect(parseBotModel(bots, "b1")).toBe("x/y");
		for (const id of ["b2", "b3", "b9"]) expect(parseBotModel(bots, id)).toBeNull();
		expect(parseBotModel(null, "b1")).toBeNull();
		expect(parseBotModel({ bots: "x" }, "b1")).toBeNull();
	});
});

describe("buildCatalog: principais x outros", () => {
	const models = parseModels(body)!;
	it("principais são os dos níveis da conta; o resto vai para 'Outros' em ordem de nome", () => {
		const catalog = buildCatalog({ models, tierIds: ["deepseek/deepseek-v4.1-flash", "anthropic/claude-sonnet-5.5"], botModel: null });
		expect(catalog.featured.map((option) => option.id)).toEqual(["deepseek/deepseek-v4.1-flash", "anthropic/claude-sonnet-5.5"]);
		expect(catalog.others.map((option) => option.name)).toEqual(["Alfa", "GPT-4o mini", "Zeta"]);
	});
	it("o modelo fixo do bot abre os principais, sem repetir se também é de um nível", () => {
		const catalog = buildCatalog({ models, tierIds: ["deepseek/deepseek-v4.1-flash", "openai/gpt-4o-mini"], botModel: "openai/gpt-4o-mini" });
		expect(catalog.featured.map((option) => option.id)).toEqual(["openai/gpt-4o-mini", "deepseek/deepseek-v4.1-flash"]);
		expect(catalog.botModel).toBe("openai/gpt-4o-mini");
	});
	it("sem níveis cadastrados usa os recomendados que o catálogo tem (o fallback do web)", () => {
		const catalog = buildCatalog({ models, tierIds: [], botModel: null });
		expect(catalog.featured.map((option) => option.id)).toEqual(["deepseek/deepseek-v4.1-flash", "openai/gpt-4o-mini"]);
	});
	it("nível que sumiu do catálogo não aparece; modelo do bot fora do catálogo aparece pelo nome", () => {
		const catalog = buildCatalog({ models, tierIds: ["sumiu/modelo"], botModel: "chatgpt/luna" });
		expect(catalog.featured.map((option) => option.id)).toEqual(["chatgpt/luna"]);
		expect(catalog.featured[0]!.name).toBe("luna");
	});
	it("nomes de exibição sem o fornecedor e sem id interno", () => {
		const catalog = buildCatalog({ models, tierIds: ["anthropic/claude-sonnet-5.5"], botModel: null });
		expect(catalog.featured[0]!.name).toBe("Claude Sonnet 5.5");
		expect(findOption(catalog, "vendor/alfa")?.name).toBe("Alfa");
		expect(findOption(catalog, "nao/existe")).toBeNull();
		expect(findOption(null, "vendor/alfa")).toBeNull();
	});
	it("só modelos com raciocínio ajustável oferecem níveis de esforço", () => {
		const catalog = buildCatalog({ models, tierIds: ["anthropic/claude-sonnet-5.5", "deepseek/deepseek-v4.1-flash"], botModel: null });
		const [sonnet, flash] = catalog.featured;
		expect(sonnet!.efforts).toEqual(["off", "low", "medium", "high"]);
		expect(flash!.efforts).toEqual([]);
	});
});

describe("descrição de uma linha", () => {
	it("só o que o catálogo confirma: imagens, raciocínio e contexto", () => {
		const [sonnet, flash, , zeta] = parseModels(body)!;
		expect(describeModel(sonnet!.id, sonnet!.info)).toBe("Lê imagens · Raciocínio · 200k de contexto");
		expect(describeModel(flash!.id, flash!.info)).toBe("128k de contexto");
		expect(describeModel(zeta!.id, zeta!.info)).toBe("");
	});
});
