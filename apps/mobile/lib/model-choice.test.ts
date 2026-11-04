import { describe, expect, it } from "vitest";
import type { CacheStorage } from "./home-cache";
import { buildCatalog, parseModels } from "./model-catalog";
import { currentSelection, loadModelChoice, modelChoiceKey, parseModelChoice, reconcileLoaded, reconcileWithCatalog, runModelFields, saveModelChoice, serializeModelChoice } from "./model-choice";

function memoryStorage(initial: Record<string, string> = {}): CacheStorage & { data: Map<string, string> } {
	const data = new Map(Object.entries(initial));
	return { data, getItem: async (key) => data.get(key) ?? null, setItem: async (key, value) => void data.set(key, value), removeItem: async (key) => void data.delete(key), getAllKeys: async () => [...data.keys()] };
}

const reasoning = { supportedParameters: ["reasoning", "tools"] };
const plain = { supportedParameters: ["tools"] };

describe("runModelFields: o corpo do run a partir da escolha", () => {
	it("sem escolha nada vai (o modelo fixo do bot vale; modelAuto aqui o ignoraria)", () => {
		expect(runModelFields(null)).toEqual({});
	});
	it("Automático: modelAuto true e nenhum modelo nem esforço", () => {
		expect(runModelFields({ mode: "auto" })).toEqual({ modelAuto: true });
	});
	it("modelo escolhido: modelo + esforço, sem modelAuto", () => {
		const fields = runModelFields({ mode: "model", model: "anthropic/claude-sonnet-5.5", effort: "high" }, () => reasoning);
		expect(fields).toEqual({ model: "anthropic/claude-sonnet-5.5", reasoningEffort: "high" });
		expect(fields).not.toHaveProperty("modelAuto");
	});
	it("esforço só se o modelo suporta raciocínio", () => {
		expect(runModelFields({ mode: "model", model: "vendor/simples", effort: "high" }, () => plain)).toEqual({ model: "vendor/simples" });
	});
	it("modelo sem esforço escolhido não manda esforço", () => {
		expect(runModelFields({ mode: "model", model: "vendor/m" }, () => reasoning)).toEqual({ model: "vendor/m" });
	});
	it("'Desligado' vira 'Baixo' onde o modelo não desliga (mesma regra do web)", () => {
		expect(runModelFields({ mode: "model", model: "vendor/pensa", effort: "off" }, () => reasoning)).toEqual({ model: "vendor/pensa", reasoningEffort: "low" });
	});
	it("sem catálogo carregado o esforço salvo segue, menos 'Desligado' (não se sabe se o modelo desliga)", () => {
		expect(runModelFields({ mode: "model", model: "vendor/m", effort: "low" })).toEqual({ model: "vendor/m", reasoningEffort: "low" });
		expect(runModelFields({ mode: "model", model: "vendor/m", effort: "off" })).toEqual({ model: "vendor/m" });
	});
});

describe("currentSelection: o que a folha marca", () => {
	const known = (model: string | null, tiers = false) => ({ known: true, model, tiers });
	it("a escolha salva vence", () => {
		expect(currentSelection({ mode: "auto" }, known("bot/m"))).toEqual({ mode: "auto" });
		expect(currentSelection({ mode: "model", model: "x/y" }, known("bot/m"))).toEqual({ mode: "model", model: "x/y" });
	});
	it("sem escolha: o modelo fixo do bot; sem modelo fixo, o Automático", () => {
		expect(currentSelection(null, known("bot/m"))).toEqual({ mode: "model", model: "bot/m" });
		expect(currentSelection(null, known(null))).toEqual({ mode: "auto" });
	});
	it("bot com níveis próprios roda no Automático (a API ignora o modelo do bot nesse caso)", () => {
		expect(currentSelection(null, known("bot/m", true))).toEqual({ mode: "auto" });
	});
	it("bot que não deu para ler: não marca nada (nunca um Automático falso)", () => {
		expect(currentSelection(null, { known: false, model: null, tiers: false })).toEqual({ mode: "unknown" });
		expect(currentSelection(null, null)).toEqual({ mode: "unknown" });
		expect(currentSelection({ mode: "auto" }, null)).toEqual({ mode: "auto" });
	});
});

describe("modelo salvo que sumiu do catálogo", () => {
	const raw = parseModels({ models: [{ id: "a/one", name: "One" }, { id: "b/two", name: "Two" }] })!;
	const catalog = (complete = true, botModel: string | null = null) => buildCatalog({ models: raw, tierIds: [], bot: { known: true, model: botModel, tiers: false }, complete });
	it("modelo que existe (ou é o do bot) continua; Automático e sem escolha também", () => {
		expect(reconcileWithCatalog({ mode: "model", model: "a/one" }, catalog())).toEqual({ mode: "model", model: "a/one" });
		expect(reconcileWithCatalog({ mode: "model", model: "chatgpt/luna" }, catalog(true, "chatgpt/luna"))).toEqual({ mode: "model", model: "chatgpt/luna" });
		expect(reconcileWithCatalog({ mode: "auto" }, catalog())).toEqual({ mode: "auto" });
		expect(reconcileWithCatalog(null, catalog())).toBeNull();
	});
	it("modelo do catálogo geral que sumiu é descartado", () => {
		expect(reconcileWithCatalog({ mode: "model", model: "z/gone", effort: "high" }, catalog())).toBeNull();
		expect(reconcileWithCatalog({ mode: "model", model: "z/gone" }, catalog(false))).toBeNull();
	});
	it("modelo de plano ou chave própria só é descartado com todas as fontes lidas", () => {
		const own = { mode: "model" as const, model: "chatgpt/luna" };
		expect(reconcileWithCatalog(own, catalog(true))).toBeNull();
		expect(reconcileWithCatalog(own, catalog(false))).toEqual(own);
	});
});

describe("reconcileLoaded: escolha salva lida x a que já está na tela", () => {
	const mine = { mode: "model" as const, model: "x/y" };
	const saved = { mode: "auto" as const };
	it("chat novo que acabou de criar a conversa não perde a escolha quando a leitura volta vazia", () => {
		expect(reconcileLoaded({ saved: null, current: mine, previousConversationId: null, changedDuringLoad: false })).toEqual(mine);
	});
	it("trocou para outra conversa: vale o que está salvo nela (vazio zera)", () => {
		expect(reconcileLoaded({ saved: null, current: mine, previousConversationId: "c0", changedDuringLoad: false })).toBeNull();
		expect(reconcileLoaded({ saved, current: mine, previousConversationId: "c0", changedDuringLoad: false })).toEqual(saved);
	});
	it("abriu o app: o salvo entra", () => {
		expect(reconcileLoaded({ saved, current: null, previousConversationId: null, changedDuringLoad: false })).toEqual(saved);
	});
	it("escolha feita enquanto lia nunca é pisada", () => {
		expect(reconcileLoaded({ saved, current: mine, previousConversationId: "c0", changedDuringLoad: true })).toEqual(mine);
		expect(reconcileLoaded({ saved: null, current: null, previousConversationId: "c0", changedDuringLoad: true })).toBeNull();
	});
});

describe("persistência por conversa", () => {
	it("a chave leva servidor, e-mail (sem caixa) e conversa, e fica sob o prefixo que o `clearChatCache` apaga", () => {
		const key = modelChoiceKey("https://a.test", "Dono@Ex.com", "c1");
		expect(key).toBe("atlas.chat.model.v1:https://a.test|dono@ex.com|c1");
		expect(key.startsWith("atlas.chat.")).toBe(true);
		expect(key).not.toBe(modelChoiceKey("https://a.test", "dono@ex.com", "c2"));
		expect(key).not.toBe(modelChoiceKey("https://a.test", "outro@ex.com", "c1"));
	});
	it("guarda e lê de volta (Automático, modelo e modelo com esforço)", async () => {
		const storage = memoryStorage();
		for (const choice of [{ mode: "auto" as const }, { mode: "model" as const, model: "x/y" }, { mode: "model" as const, model: "x/y", effort: "medium" as const }]) {
			await saveModelChoice(storage, "k", choice);
			expect(await loadModelChoice(storage, "k")).toEqual(choice);
		}
	});
	it("conversas diferentes guardam escolhas independentes", async () => {
		const storage = memoryStorage();
		await saveModelChoice(storage, "c1", { mode: "auto" });
		await saveModelChoice(storage, "c2", { mode: "model", model: "x/y" });
		expect(await loadModelChoice(storage, "c1")).toEqual({ mode: "auto" });
		expect(await loadModelChoice(storage, "c2")).toEqual({ mode: "model", model: "x/y" });
		expect(await loadModelChoice(storage, "c3")).toBeNull();
	});
	it("leitura inválida é ignorada (JSON quebrado, versão antiga, modo ou modelo fora do formato, esforço desconhecido)", () => {
		for (const raw of [null, "", "{", "[]", "null", '"auto"', JSON.stringify({ v: 0, mode: "auto" }), JSON.stringify({ v: 1, mode: "outro" }), JSON.stringify({ v: 1, mode: "model" }), JSON.stringify({ v: 1, mode: "model", model: "  " }), JSON.stringify({ v: 1, mode: "model", model: 7 }), JSON.stringify({ v: 1, mode: "model", model: "m".repeat(500) })]) {
			expect(parseModelChoice(raw)).toBeNull();
		}
		expect(parseModelChoice(JSON.stringify({ v: 1, mode: "model", model: "x/y", effort: "extremo" }))).toEqual({ mode: "model", model: "x/y" });
	});
	it("só grava os campos conhecidos", () => {
		const raw = serializeModelChoice({ mode: "model", model: "x/y", effort: "low" });
		expect(Object.keys(JSON.parse(raw)).sort()).toEqual(["effort", "mode", "model", "v"]);
		expect(JSON.stringify(parseModelChoice(JSON.stringify({ v: 1, mode: "auto", token: "segredo" })))).not.toContain("segredo");
	});
	it("disco que falha nunca lança (lê sem escolha, grava em silêncio)", async () => {
		const broken: CacheStorage = { getItem: async () => Promise.reject(new Error("x")), setItem: async () => Promise.reject(new Error("x")), removeItem: async () => Promise.reject(new Error("x")), getAllKeys: async () => [] };
		expect(await loadModelChoice(broken, "k")).toBeNull();
		await expect(saveModelChoice(broken, "k", { mode: "auto" })).resolves.toBeUndefined();
		await expect(saveModelChoice(broken, "k", null)).resolves.toBeUndefined();
	});
	it("salvar `null` apaga a escolha", async () => {
		const storage = memoryStorage();
		await saveModelChoice(storage, "k", { mode: "auto" });
		await saveModelChoice(storage, "k", null);
		expect(storage.data.has("k")).toBe(false);
	});
});
