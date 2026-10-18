import { describe, expect, it } from "vitest";
import { getModelCapabilities, formatContextTokens, missingForRole, roleCapabilityWarning } from "./model-capabilities.js";
import { parseOpenRouterModelInfo } from "./openrouter-model-parse.js";

describe("getModelCapabilities", () => {
	it("override curado cobre Claude, GPT, Gemini e Haiku 5.5", () => {
		for (const id of ["anthropic/claude-haiku-5.5", "anthropic/claude-sonnet-5-5", "anthropic-direct/claude-opus-5", "openai/gpt-5.1", "openai/gpt-4o-mini", "google/gemini-2.5-pro"]) {
			const caps = getModelCapabilities(id);
			expect(caps, id).toMatchObject({ vision: true, pdf: true, tools: true, source: "override" });
		}
		expect(getModelCapabilities("anthropic/claude-haiku-5.5").reasoning).toBe(true);
		expect(getModelCapabilities("openai/gpt-3.5-turbo").vision).toBe(false);
	});

	it("nome sem o vendor certo no OpenRouter não herda o override", () => {
		expect(getModelCapabilities("someone/gpt-5-clone")).toMatchObject({ vision: false, pdf: false, source: "unknown" });
	});

	it("desconhecido é conservador: sem imagem nem PDF, ferramentas como hoje", () => {
		expect(getModelCapabilities("acme/mystery-1")).toEqual({
			vision: false, pdf: false, tools: true, reasoning: false, contextTokens: null, maxOutputTokens: null, streaming: true, source: "unknown",
		});
		expect(getModelCapabilities("opencode-go/glm-5.3")).toMatchObject({ vision: false, pdf: false, tools: true });
	});

	it("catálogo preenche o que o override não diz e perde para o override", () => {
		const catalog = { inputModalities: ["text", "image", "file"], contextLength: 1_000_000, maxOutputTokens: 64_000, supportedParameters: ["tools", "reasoning"] };
		expect(getModelCapabilities("acme/new", catalog)).toMatchObject({ vision: true, pdf: true, tools: true, reasoning: true, contextTokens: 1_000_000, maxOutputTokens: 64_000, source: "catalog" });
		const merged = getModelCapabilities("opencode-go/kimi-k3", { inputModalities: ["text", "image"], contextLength: 256_000, capabilities: { tools: true, vision: true } });
		expect(merged).toMatchObject({ vision: true, pdf: false, contextTokens: 256_000, source: "override" });
		expect(getModelCapabilities("anthropic/claude-sonnet-5", { inputModalities: ["text"], contextLength: 200_000 })).toMatchObject({ vision: true, contextTokens: 200_000 });
	});

	it("catálogo que lista parâmetros sem tools tira as ferramentas", () => {
		expect(getModelCapabilities("acme/chat-only", { supportedParameters: ["temperature"] }).tools).toBe(false);
		expect(getModelCapabilities("acme/chat-only", { capabilities: { tools: false } }).tools).toBe(false);
	});

	it("preserva as regras de visão por provedor", () => {
		// Anthropic: lê por padrão, salvo declaração contrária do catálogo.
		expect(getModelCapabilities("anthropic-direct/novo", { capabilities: "unknown" }).vision).toBe(true);
		expect(getModelCapabilities("anthropic-direct/novo", { capabilities: { vision: false } }).vision).toBe(false);
		// ChatGPT: sem flag tenta; flag falsa respeitada.
		expect(getModelCapabilities("chatgpt/luna", { capabilities: "unknown" }).vision).toBe(true);
		expect(getModelCapabilities("chatgpt/luna", { capabilities: { vision: false } }).vision).toBe(false);
		// OpenCode Go: só com declaração.
		expect(getModelCapabilities("opencode-go/glm-5.3", { capabilities: "unknown" }).vision).toBe(false);
		expect(getModelCapabilities("opencode-go/kimi-k3", { capabilities: { vision: true } }).vision).toBe(true);
	});

	it("referência malformada cai no desconhecido sem lançar", () => {
		expect(getModelCapabilities(" bad ref ").source).toBe("unknown");
	});
});

describe("avisos por função", () => {
	it("modelo de manutenção sem ferramentas e leitor de imagem sem visão", () => {
		const noTools = getModelCapabilities("acme/x", { supportedParameters: ["temperature"] });
		expect(missingForRole("maintenance", noTools)).toEqual(["tools"]);
		expect(roleCapabilityWarning("maintenance", noTools)).toMatch(/ferramentas/);
		expect(roleCapabilityWarning("maintenance", getModelCapabilities("openai/gpt-5"))).toBeNull();
		expect(roleCapabilityWarning("vision", getModelCapabilities("openai/gpt-3.5-turbo"))).toMatch(/não lê imagens/);
		expect(roleCapabilityWarning("vision", getModelCapabilities("acme/unknown"))).toMatch(/Não sabemos/);
	});
});

describe("formatContextTokens", () => {
	it("formata k e M", () => {
		expect([formatContextTokens(200_000), formatContextTokens(128_000), formatContextTokens(1_000_000), formatContextTokens(1_500_000), formatContextTokens(null)]).toEqual(["200k", "128k", "1M", "1,5M", null]);
	});
});

describe("parseOpenRouterModelInfo", () => {
	it("lê modalidades, contexto, saída e parâmetros", () => {
		expect(parseOpenRouterModelInfo({
			id: "x/y", context_length: 200000, architecture: { input_modalities: ["text", "image", "file"], output_modalities: ["text"] },
			top_provider: { max_completion_tokens: 8192 }, supported_parameters: ["tools", "reasoning", 3],
		})).toEqual({ contextLength: 200000, maxOutputTokens: 8192, inputModalities: ["text", "image", "file"], outputModalities: ["text"], supportedParameters: ["tools", "reasoning"] });
	});
	it("campos ausentes ficam não declarados", () => {
		expect(parseOpenRouterModelInfo({ id: "x/y", context_length: -1 })).toEqual({ contextLength: null, maxOutputTokens: null });
		expect(parseOpenRouterModelInfo(null)).toEqual({ contextLength: null, maxOutputTokens: null });
	});
});
