import { describe, expect, it } from "vitest";
import { formatModelRef, parseModelRef } from "./model-ref.js";

describe("referências por provedor", () => {
	it("preserva IDs antigos e caixa de vendors desconhecidos", () => {
		for (const id of ["openai/gpt-4o-mini", "deepseek/deepseek-v4.1-flash", "vendor/new-model", "ChatGPT/Luna", "auto"])
			expect(parseModelRef(id)).toEqual({ provider: "openrouter", slug: id });
	});
	it("formata e valida slugs ChatGPT sem mudar a caixa", () => {
		for (const slug of ["luna", "Luna_2.0:fast", "x".repeat(256)])
			expect(parseModelRef(formatModelRef("chatgpt", slug))).toEqual({ provider: "chatgpt", slug });
		expect(formatModelRef("openrouter", "openai/gpt-4o-mini")).toBe("openai/gpt-4o-mini");
		for (const id of ["", " chatgpt/luna", "chatgpt/", "chatgpt/a/b", "chatgpt/a b", "chatgpt/ç", "chatgpt/" + "x".repeat(257)])
			expect(() => parseModelRef(id)).toThrow(RangeError);
		expect(() => formatModelRef("openrouter", "chatgpt/luna")).toThrow(RangeError);
	});
	it("roteia anthropic-direct/ e opencode-go/ sem colidir com anthropic/ do OpenRouter", () => {
		expect(parseModelRef("anthropic/claude-sonnet-5-5")).toEqual({ provider: "openrouter", slug: "anthropic/claude-sonnet-5-5" });
		expect(parseModelRef("anthropic-direct/claude-sonnet-5-5")).toEqual({ provider: "anthropic", slug: "claude-sonnet-5-5" });
		expect(parseModelRef("opencode-go/kimi-k3")).toEqual({ provider: "opencode-go", slug: "kimi-k3" });
		expect(formatModelRef("opencode-go", "glm-5.3")).toBe("opencode-go/glm-5.3");
		expect(() => parseModelRef("opencode-go/a/b")).toThrow(RangeError);
	});
});
