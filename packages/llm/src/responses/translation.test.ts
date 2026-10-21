import { describe, expect, it } from "vitest";
import type { CompleteChatWithToolsParams, LlmMessage } from "../chat-tools.js";
import { toResponses } from "./to-responses.js";
import { responsesRequestBody } from "./request.js";
import { responseUsage } from "./usage.js";
import { providerModelCapabilities } from "./capabilities.js";
const call = { id: "call_fixture", type: "function" as const, function: { name: "lookup", arguments: "{}" } };
const history: LlmMessage[] = [
	{ role: "system", content: "Be helpful." }, { role: "system", content: "Be concise." },
	{ role: "user", content: [{ type: "text", text: "Describe" }, { type: "image_url", image_url: { url: "data:image/png;base64,AA==" } }] },
	{ role: "assistant", content: "Checking.", tool_calls: [call] },
	{ role: "tool", tool_call_id: call.id, content: "result" },
];
const params: CompleteChatWithToolsParams = { model: "chatgpt/luna", apiKey: "unused", messages: history, tools: [{ type: "function", function: { name: "lookup", description: "Read data", parameters: { type: "object", properties: {} } } }], maxOutputTokens: 1, reasoningMaxTokens: 1, sessionId: "run_fixture" };

describe("tradução Responses", () => {
	it("preserva ids, ordem, imagens e várias instruções", () => {
		expect(toResponses(history, params.model)).toEqual({ instructions: "Be helpful.\n\nBe concise.", input: [
			{ role: "user", content: [{ type: "input_text", text: "Describe" }, { type: "input_image", image_url: "data:image/png;base64,AA==" }] },
			{ role: "assistant", content: [{ type: "output_text", text: "Checking." }] },
			{ type: "function_call", call_id: call.id, name: "lookup", arguments: "{}" },
			{ type: "function_call_output", call_id: call.id, output: "result" },
		] });
	});
	it("reinjeta itens opacos só no mesmo modelo, sem duplicar chamadas", () => {
		const items = [{ type: "reasoning", id: "reason_fixture", encrypted_content: "opaque_fixture" }, { type: "function_call", id: "fc_fixture", call_id: call.id, name: "lookup", arguments: "{}" }];
		const messages: LlmMessage[] = [{ role: "assistant", content: null, tool_calls: [call], providerItems: { provider: "chatgpt", model: params.model, items } }, history[4]!];
		expect(toResponses(messages, params.model).input.slice(0, 2)).toEqual(items);
		expect(toResponses(messages, "chatgpt/other").input).toHaveLength(2);
		expect(toResponses(messages, "openai/gpt-4o-mini").input).toHaveLength(2);
	});
	it("rejeita órfãos, duplicatas, pares ausentes e imagens internas", () => {
		for (const messages of [[history[4]!], [history[3]!], [history[3]!, history[4]!, history[4]!], [history[3]!, history[2]!], [{ role: "user" as const, content: [{ type: "image_ref" as const, artifactId: "artifact" }] }]])
			expect(() => toResponses(messages, params.model)).toThrow();
	});
	it("omite parâmetros proibidos e credenciais; a chave de cache só sai com id de sessão", () => {
		const body = responsesRequestBody(params);
		expect(Object.keys(body)).toEqual(["model", "instructions", "input", "tools", "tool_choice", "stream", "store", "prompt_cache_key"]);
		expect(body.tools).toEqual([{ type: "function", name: "lookup", description: "Read data", parameters: { type: "object", properties: {} } }]);
		expect(body.model).toBe("luna");
		expect(body.store).toBe(false);
	});
	it("mapeia uso real sem inventar custo USD", () => {
		expect(responseUsage({ input_tokens: 10, output_tokens: 20, total_tokens: 30, input_tokens_details: { cached_tokens: 3, cache_write_tokens: 2 }, output_tokens_details: { reasoning_tokens: 9 } })).toEqual({ costKind: "plan", promptTokens: 10, completionTokens: 20, totalTokens: 30, cachedTokens: 3, cacheWriteTokens: 2, reasoningTokens: 9 });
		expect(responseUsage(null)).not.toHaveProperty("costUnknown");
		expect(responseUsage({ input_tokens: -1, output_tokens: Infinity })).not.toHaveProperty("costUsd");
	});
	it("capacidades vêm do catálogo, teto depende do provedor", () => {
		expect(providerModelCapabilities("chatgpt", { supportsVision: true, supportsTools: true })).toEqual({ supportsVision: true, supportsTools: true, supportsOutputCap: false });
		expect(providerModelCapabilities("openrouter").supportsOutputCap).toBe(true);
	});
});
