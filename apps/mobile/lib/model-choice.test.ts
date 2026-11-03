import { describe, expect, it } from "vitest";
import type { CacheStorage } from "./home-cache";
import { currentSelection, loadModelChoice, modelChoiceKey, parseModelChoice, runModelFields, saveModelChoice, serializeModelChoice } from "./model-choice";

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
	it("sem catálogo carregado o esforço salvo segue (o servidor ignora o que não valer)", () => {
		expect(runModelFields({ mode: "model", model: "vendor/m", effort: "low" })).toEqual({ model: "vendor/m", reasoningEffort: "low" });
	});
});

describe("currentSelection: o que a folha marca", () => {
	it("a escolha salva vence", () => {
		expect(currentSelection({ mode: "auto" }, "bot/m")).toEqual({ mode: "auto" });
		expect(currentSelection({ mode: "model", model: "x/y" }, "bot/m")).toEqual({ mode: "model", model: "x/y" });
	});
	it("sem escolha: o modelo fixo do bot; sem modelo fixo, o Automático", () => {
		expect(currentSelection(null, "bot/m")).toEqual({ mode: "model", model: "bot/m" });
		expect(currentSelection(null, null)).toEqual({ mode: "auto" });
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
