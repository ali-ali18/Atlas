import { describe, expect, it } from "vitest";
import { buildCatalog, describeModel, findOption, parseBotInfo, parseModels, parseTierModelIds, visibleOthers, type BotModelInfo } from "./model-catalog";

const bot = (model: string | null, tiers = false): BotModelInfo => ({ known: true, model, tiers });

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
	it("modelo e níveis do bot vêm da lista de bots", () => {
		const bots = { bots: [{ id: "b1", openRouterModel: "x/y" }, { id: "b2", openRouterModel: null }, { id: "b3", openRouterModel: "m/n", policyJson: { modelTiers: { hard: ["h/m"] } } }] };
		expect(parseBotInfo(bots, "b1")).toEqual({ known: true, model: "x/y", tiers: false });
		expect(parseBotInfo(bots, "b2")).toEqual({ known: true, model: null, tiers: false });
		expect(parseBotInfo(bots, "b3")).toEqual({ known: true, model: "m/n", tiers: true });
	});
	it("bot que não deu para ler (resposta ausente, torta ou sem o bot) é 'não sei', não 'sem modelo'", () => {
		const unknown = { known: false, model: null, tiers: false };
		expect(parseBotInfo({ bots: [{ id: "b1" }] }, "b9")).toEqual(unknown);
		expect(parseBotInfo(null, "b1")).toEqual(unknown);
		expect(parseBotInfo({ bots: "x" }, "b1")).toEqual(unknown);
	});
});

describe("buildCatalog: principais x outros", () => {
	const models = parseModels(body)!;
	it("principais são os dos níveis da conta; o resto vai para 'Outros' em ordem de nome", () => {
		const catalog = buildCatalog({ models, tierIds: ["deepseek/deepseek-v4.1-flash", "anthropic/claude-sonnet-5.5"], bot: bot(null) });
		expect(catalog.featured.map((option) => option.id)).toEqual(["deepseek/deepseek-v4.1-flash", "anthropic/claude-sonnet-5.5"]);
		expect(catalog.others.map((option) => option.name)).toEqual(["Alfa", "GPT-4o mini", "Zeta"]);
	});
	it("o modelo fixo do bot abre os principais, sem repetir se também é de um nível", () => {
		const catalog = buildCatalog({ models, tierIds: ["deepseek/deepseek-v4.1-flash", "openai/gpt-4o-mini"], bot: bot("openai/gpt-4o-mini") });
		expect(catalog.featured.map((option) => option.id)).toEqual(["openai/gpt-4o-mini", "deepseek/deepseek-v4.1-flash"]);
		expect(catalog.bot.model).toBe("openai/gpt-4o-mini");
	});
	it("sem níveis cadastrados usa os recomendados que o catálogo tem (o fallback do web)", () => {
		const catalog = buildCatalog({ models, tierIds: [], bot: bot(null) });
		expect(catalog.featured.map((option) => option.id)).toEqual(["deepseek/deepseek-v4.1-flash", "openai/gpt-4o-mini"]);
	});
	it("nível que sumiu do catálogo não aparece; modelo do bot fora do catálogo aparece pelo nome", () => {
		const catalog = buildCatalog({ models, tierIds: ["sumiu/modelo"], bot: bot("chatgpt/luna") });
		expect(catalog.featured.map((option) => option.id)).toEqual(["chatgpt/luna"]);
		expect(catalog.featured[0]!.name).toBe("luna");
	});
	it("nomes de exibição sem o fornecedor e sem id interno", () => {
		const catalog = buildCatalog({ models, tierIds: ["anthropic/claude-sonnet-5.5"], bot: bot(null) });
		expect(catalog.featured[0]!.name).toBe("Claude Sonnet 5.5");
		expect(findOption(catalog, "vendor/alfa")?.name).toBe("Alfa");
		expect(findOption(catalog, "nao/existe")).toBeNull();
		expect(findOption(null, "vendor/alfa")).toBeNull();
	});
	it("só modelos com raciocínio ajustável oferecem níveis de esforço", () => {
		const catalog = buildCatalog({ models, tierIds: ["anthropic/claude-sonnet-5.5", "deepseek/deepseek-v4.1-flash"], bot: bot(null) });
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

describe("descrição de modelos de outros provedores", () => {
	it("plano ChatGPT e chave própria dizem de onde vêm", () => {
		expect(describeModel("chatgpt/luna", { contextLength: 128_000 })).toMatch(/^Plano ChatGPT · .*128k de contexto$/);
		expect(describeModel("anthropic-direct/claude-sonnet-5.5", {})).toContain("via Anthropic");
	});
});

describe("visibleOthers: só os primeiros até 'Ver tudo (n)'", () => {
	const many = Array.from({ length: 120 }, (_, i) => ({ id: `v/m${i}`, name: `M${i}`, description: "", efforts: [], info: {} }));
	it("corta em 50 e diz quantos ficaram de fora", () => {
		const { shown, hidden } = visibleOthers(many, false);
		expect(shown).toHaveLength(50);
		expect(hidden).toBe(70);
		expect(shown[0]!.id).toBe("v/m0");
	});
	it("Ver tudo mostra todos; lista curta não corta", () => {
		expect(visibleOthers(many, true)).toEqual({ shown: many, hidden: 0 });
		expect(visibleOthers(many.slice(0, 50), false)).toEqual({ shown: many.slice(0, 50), hidden: 0 });
		expect(visibleOthers([], false)).toEqual({ shown: [], hidden: 0 });
	});
});
