import { describe, expect, it } from "vitest";
import { modelDisplayName } from "./model-display-name.js";

describe("modelDisplayName", () => {
	it("tira o prefixo do fornecedor", () => {
		expect(modelDisplayName("DeepSeek: DeepSeek V4.1 Flash", "deepseek/deepseek-v4.1-flash")).toBe("DeepSeek V4.1 Flash");
		expect(modelDisplayName("Anthropic: Claude Sonnet 4", "anthropic/claude-sonnet-4")).toBe("Claude Sonnet 4");
		expect(modelDisplayName("OpenAI: GPT-4o mini", "openai/gpt-4o-mini")).toBe("GPT-4o mini");
	});
	it("casa fornecedor com segmento do id apesar de grafia diferente", () => {
		expect(modelDisplayName("Meta: Llama 3.3 70B", "meta-llama/llama-3.3-70b")).toBe("Llama 3.3 70B");
		expect(modelDisplayName("Z.ai: GLM 4.6", "z-ai/glm-4.6")).toBe("GLM 4.6");
		expect(modelDisplayName("Mistral AI: Large", "mistralai/mistral-large")).toBe("Large");
	});
	it("mantém nomes sem prefixo", () => {
		expect(modelDisplayName("GPT-5 Luna", "chatgpt/luna")).toBe("GPT-5 Luna");
		expect(modelDisplayName("Auto", "auto")).toBe("Auto");
	});
	it("não mexe em ':' que não é prefixo de fornecedor", () => {
		expect(modelDisplayName("Claude 3: Opus", "anthropic/claude-3-opus")).toBe("Claude 3: Opus");
		expect(modelDisplayName("Foo: Bar", "other/bar")).toBe("Foo: Bar");
		expect(modelDisplayName("Foo: Bar")).toBe("Foo: Bar");
	});
	it("casos estranhos", () => {
		expect(modelDisplayName("DeepSeek: ", "deepseek/x")).toBe("DeepSeek:");
		expect(modelDisplayName(": X", "deepseek/x")).toBe(": X");
		expect(modelDisplayName("", "deepseek/deepseek-v4")).toBe("deepseek-v4");
		expect(modelDisplayName(null, undefined)).toBe("");
		expect(modelDisplayName("  Qwen: Qwen3 Max  ", "qwen/qwen3-max")).toBe("Qwen3 Max");
	});
});
