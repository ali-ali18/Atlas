import { afterEach, expect, it, vi } from "vitest";
import { chatRequestBody } from "./chat-tools.js";

const base = {
	apiKey: "test",
	model: "anthropic/claude-sonnet-5.5",
	tools: [],
	messages: [{ role: "user" as const, content: "oi" }],
};

afterEach(() => vi.unstubAllEnvs());

it("sem nível, o corpo não leva effort (padrão do modelo)", () => {
	expect(chatRequestBody(base, true)).not.toHaveProperty("reasoning");
});

it.each(["low", "medium", "high"] as const)("envia reasoning.effort %s", (effort) => {
	expect(chatRequestBody({ ...base, reasoningEffort: effort }, true)).toHaveProperty("reasoning", { effort });
});

it("Desligado manda enabled:false", () => {
	expect(chatRequestBody({ ...base, reasoningEffort: "off" }, true)).toHaveProperty("reasoning", { enabled: false });
});

it("o nível vence o teto de tokens de raciocínio (param e env)", () => {
	vi.stubEnv("LLM_REASONING_MAX_TOKENS", "2000");
	const body = chatRequestBody({ ...base, maxOutputTokens: 8000, reasoningMaxTokens: 1000, reasoningEffort: "high" }, false);
	expect(body.reasoning).toEqual({ effort: "high" });
	expect(body).toHaveProperty("max_tokens", 8000);
});

it("sem nível, o teto de tokens de raciocínio continua valendo", () => {
	expect(chatRequestBody({ ...base, maxOutputTokens: 8000, reasoningMaxTokens: 1000 }, false).reasoning).toEqual({ max_tokens: 1000 });
});

it("modelo de outro provedor nunca recebe o parâmetro", () => {
	expect(chatRequestBody({ ...base, model: "chatgpt/gpt-5", reasoningEffort: "low" }, true)).not.toHaveProperty("reasoning");
	expect(chatRequestBody({ ...base, model: "opencode-go/glm-5", reasoningEffort: "low" }, true)).not.toHaveProperty("reasoning");
});

it("Desligado com reserva que não desliga (ou desconhecida) vira low; reserva que desliga mantém enabled:false", () => {
	const off = { ...base, reasoningEffort: "off" as const };
	expect(chatRequestBody({ ...off, fallbackModels: ["openai/gpt-5"] }, true).reasoning).toEqual({ effort: "low" });
	expect(chatRequestBody({ ...off, fallbackModels: ["someone/unknown"] }, true).reasoning).toEqual({ effort: "low" });
	expect(chatRequestBody({ ...off, fallbackModels: ["anthropic/claude-haiku-5"] }, true).reasoning).toEqual({ enabled: false });
	expect(chatRequestBody({ ...off, fallbackModels: [] }, true).reasoning).toEqual({ enabled: false });
});

it("níveis low/medium/high não mudam por causa da reserva", () => {
	expect(chatRequestBody({ ...base, reasoningEffort: "high", fallbackModels: ["openai/gpt-5"] }, true).reasoning).toEqual({ effort: "high" });
});
