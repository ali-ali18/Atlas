import { expect, it, vi } from "vitest";
import type { CompleteChatWithToolsParams, CompleteChatWithToolsResult } from "./chat-tools.js";
import { createProviderStreamChat } from "./provider-router.js";
const result: CompleteChatWithToolsResult = { model: "fixture", message: { role: "assistant", content: "ok" } };
const params: CompleteChatWithToolsParams = { model: "openai/gpt-4o-mini", apiKey: "fixture", messages: [{ role: "user", content: "Hello" }], tools: [] };

it("OpenRouter recebe exatamente o contrato antigo; ChatGPT é despachado só pelo namespace", async () => {
	const openrouter = vi.fn().mockResolvedValue(result);
	const chatgpt = vi.fn().mockResolvedValue(result);
	const stream = createProviderStreamChat({ openrouter, chatgpt });
	await stream(params);
	expect(openrouter).toHaveBeenCalledWith(params, undefined);
	expect(chatgpt).not.toHaveBeenCalled();
	await stream({ ...params, model: "chatgpt/luna" });
	expect(chatgpt).toHaveBeenCalledTimes(1);
});

it("remove itens opacos na troca de modelo/provedor sem mutar a mensagem original", async () => {
	const openrouter = vi.fn().mockResolvedValue(result);
	const chatgpt = vi.fn().mockResolvedValue(result);
	const opaque = { provider: "chatgpt" as const, model: "chatgpt/luna", items: [{ type: "reasoning", id: "reason_fixture" }] };
	const message = { role: "assistant" as const, content: "Hello", providerItems: opaque };
	const stream = createProviderStreamChat({ openrouter, chatgpt });
	await stream({ ...params, messages: [message] });
	expect(openrouter.mock.calls[0]![0].messages[0]).not.toHaveProperty("providerItems");
	await stream({ ...params, model: "chatgpt/other", messages: [message] });
	expect(chatgpt.mock.calls[0]![0].messages[0]).not.toHaveProperty("providerItems");
	await stream({ ...params, model: "chatgpt/luna", messages: [message] });
	expect(chatgpt.mock.calls[1]![0].messages[0].providerItems).toBe(opaque);
	expect(message.providerItems).toBe(opaque);
});
