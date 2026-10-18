import { afterEach, expect, it, vi } from "vitest";
import { chatRequestBody, streamChatWithTools } from "./chat-tools.js";

const params = {
	apiKey: "test",
	model: "model",
	tools: [],
	messages: [{ role: "user" as const, content: "create a long document" }],
};

afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

it("callers sem orçamento explícito não herdam teto de saída do loop", () => {
	vi.stubEnv("LLM_MAX_OUTPUT_TOKENS", "4096");
	expect(chatRequestBody(params, false)).not.toHaveProperty("max_tokens");
	expect(
		chatRequestBody({ ...params, maxOutputTokens: 8192 }, true),
	).toHaveProperty("max_tokens", 8192);
});

it("argumento longo de create_file chega inteiro sem teto global de 4096", async () => {
	vi.stubEnv("LLM_MAX_OUTPUT_TOKENS", "4096");
	// Mais de 4096 tokens mesmo para um tokenizer que agrupe dígitos em trios.
	const argumentsJson = JSON.stringify({
		filename: "documento.txt",
		content: "123456789012345678901234567890 ".repeat(5000),
	});
	const parts = [argumentsJson.slice(0, 70000), argumentsJson.slice(70000)];
	const body =
		parts
			.map(
				(argumentsPart, index) =>
					`data: ${JSON.stringify({
						choices: [
							{
								delta: {
									tool_calls: [
										{
											index: 0,
											...(index === 0
												? { id: "create", type: "function" }
												: {}),
											function: {
												...(index === 0 ? { name: "create_file" } : {}),
												arguments: argumentsPart,
											},
										},
									],
								},
							},
						],
					})}\n\n`,
			)
			.join("") + "data: [DONE]\n\n";
	const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
		expect(JSON.parse(String(init?.body))).not.toHaveProperty("max_tokens");
		return new Response(body);
	});
	vi.stubGlobal("fetch", fetcher);
	const result = await streamChatWithTools(params);
	expect(result.message.tool_calls?.[0]?.function.arguments).toBe(
		argumentsJson,
	);
	expect(
		JSON.parse(result.message.tool_calls![0]!.function.arguments).content,
	).toHaveLength(155000);
	expect(fetcher).toHaveBeenCalledTimes(1);
});

it("reasoning da configuração acompanha o saldo reduzido de saída", () => {
	vi.stubEnv("LLM_REASONING_MAX_TOKENS", "2048");
	expect(
		chatRequestBody({ ...params, maxOutputTokens: 64 }, true),
	).toMatchObject({
		max_tokens: 64,
		reasoning: { max_tokens: 32 },
	});
	expect(
		chatRequestBody({ ...params, maxOutputTokens: 1 }, true),
	).not.toHaveProperty("reasoning");
	expect(
		chatRequestBody(
			{ ...params, maxOutputTokens: 64, reasoningMaxTokens: 16 },
			true,
		),
	).toHaveProperty("reasoning.max_tokens", 16);
	expect(() =>
		chatRequestBody(
			{ ...params, maxOutputTokens: 64, reasoningMaxTokens: 0 },
			true,
		),
	).toThrow(RangeError);
	vi.stubEnv("LLM_REASONING_MAX_TOKENS", "invalid");
	expect(() =>
		chatRequestBody({ ...params, maxOutputTokens: 1 }, true),
	).toThrow(RangeError);
});
