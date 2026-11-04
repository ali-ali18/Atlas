import { describe, expect, it } from "vitest";
import type { ModelOption } from "./model-catalog";
import { normalizeSearch, searchModels } from "./model-search";

const opt = (id: string, name: string, source: string | null = null): ModelOption => ({ id, name, description: "", source, efforts: [], info: {} });
const all = [
	opt("anthropic/claude-haiku-5", "Claude Haiku 5"),
	opt("anthropic-direct/claude-haiku-5", "Claude Haiku 5", "Anthropic"),
	opt("openai/gpt-5.1", "GPT-5.1"),
	opt("chatgpt/gpt-5.1", "GPT-5.1", "ChatGPT"),
	opt("opencode-go/kimi-k2", "Kimi K2", "OpenCode Go"),
	opt("google/gemini-3-pro", "Gemini 3 Pro"),
	opt("mistralai/mistral-large", "Mistral Large"),
	opt("vendor/zeta", "Modelo Épico"),
	opt("deepseek/deepseek-r1", "R1 (haiku-like)"),
];

describe("normalizeSearch", () => {
	it("sem acentos, sem maiúsculas, pontuação vira espaço", () => {
		expect(normalizeSearch("  Modelo ÉPICO ")).toBe("modelo epico");
		expect(normalizeSearch("GPT-5.1")).toBe("gpt 5 1");
		expect(normalizeSearch("")).toBe("");
		expect(normalizeSearch("---")).toBe("");
	});
});

describe("searchModels", () => {
	it("busca vazia não devolve nada (a folha mostra as seções)", () => {
		expect(searchModels(all, "")).toEqual([]);
		expect(searchModels(all, "   ")).toEqual([]);
	});
	it("junta todas as fontes e mantém os iguais (cada um com a sua origem)", () => {
		const found = searchModels(all, "haiku");
		expect(found.map((o) => o.id)).toEqual(["anthropic/claude-haiku-5", "anthropic-direct/claude-haiku-5", "deepseek/deepseek-r1"]);
	});
	it("sem acento e sem diferenciar maiúsculas", () => {
		expect(searchModels(all, "EPICO").map((o) => o.id)).toEqual(["vendor/zeta"]);
		expect(searchModels(all, "épico").map((o) => o.id)).toEqual(["vendor/zeta"]);
	});
	it("várias palavras: todas precisam aparecer, em qualquer ordem", () => {
		expect(searchModels(all, "pro gemini").map((o) => o.id)).toEqual(["google/gemini-3-pro"]);
		expect(searchModels(all, "gpt 5").map((o) => o.id)).toEqual(["openai/gpt-5.1", "chatgpt/gpt-5.1"]);
		expect(searchModels(all, "gemini mistral")).toEqual([]);
	});
	it("acha pelo id do provedor e pela origem", () => {
		expect(searchModels(all, "anthropic").map((o) => o.id)).toEqual(["anthropic/claude-haiku-5", "anthropic-direct/claude-haiku-5"]);
		expect(searchModels(all, "opencode").map((o) => o.id)).toEqual(["opencode-go/kimi-k2"]);
		expect(searchModels(all, "chatgpt").map((o) => o.id)).toEqual(["chatgpt/gpt-5.1"]);
	});
	it("nome que começa com o termo vem antes de nome que só contém, e só id/origem por último", () => {
		const list = [opt("a/x", "Super Haiku"), opt("a/y", "Haiku Prime"), opt("haiku/z", "Outro")];
		expect(searchModels(list, "haiku").map((o) => o.id)).toEqual(["a/y", "a/x", "haiku/z"]);
	});
	it("sem resultado devolve lista vazia", () => {
		expect(searchModels(all, "naoexiste")).toEqual([]);
	});
});
