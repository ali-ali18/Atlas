import { afterEach, describe, expect, it, vi } from "vitest";
import { chatRequestBody, completeChatWithTools, usageFrom } from "./chat-tools.js";
import type { ChatTool, LlmMessage } from "./chat-tools.js";
import {
	MAX_CACHE_BREAKPOINTS,
	applyCacheBreakpoints,
	stripCacheBreakpoints,
	supportsExplicitPromptCache,
} from "./prompt-cache.js";

const tools: ChatTool[] = [];
const conversation: LlmMessage[] = [
	{ role: "system", content: "sys" },
	{ role: "user", content: "faça X" },
	{ role: "assistant", content: null, tool_calls: [] },
	{ role: "tool", tool_call_id: "a", content: "resultado a" },
	{ role: "assistant", content: null, tool_calls: [] },
	{ role: "tool", tool_call_id: "b", content: "resultado b" },
];

function marked(messages: LlmMessage[]): number[] {
	return messages.flatMap((m, i) =>
		Array.isArray(m.content) &&
		m.content.some((p) => p.type === "text" && p.cache_control)
			? [i]
			: [],
	);
}

describe("prompt cache", () => {
	it("só modelos Anthropic usam breakpoints explícitos", () => {
		expect(supportsExplicitPromptCache("anthropic/claude-sonnet-5.5")).toBe(true);
		expect(supportsExplicitPromptCache("openai/gpt-5")).toBe(false);
	});

	it("marca sistema, última mensagem e o fim do request anterior", () => {
		const out = applyCacheBreakpoints(conversation);
		// 0 = sistema, 5 = última, 3 = mensagem antes do último assistant
		expect(marked(out)).toEqual([0, 3, 5]);
		expect(marked(out).length).toBeLessThanOrEqual(MAX_CACHE_BREAKPOINTS);
		expect(out[5]?.content).toEqual([
			{ type: "text", text: "resultado b", cache_control: { type: "ephemeral" } },
		]);
		// entrada intacta
		expect(conversation[0]?.content).toBe("sys");
	});

	it("com screenshot (texto + imagem) marca o texto e preserva a imagem", () => {
		const shot: LlmMessage = {
			role: "user",
			content: [
				{ type: "text", text: "Screenshot atual da tela:" },
				{ type: "image_url", image_url: { url: "data:image/jpeg;base64,AAA" } },
			],
		};
		const out = applyCacheBreakpoints([...conversation, shot]);
		const parts = out[6]?.content as Array<{ type: string }>;
		expect(parts[1]?.type).toBe("image_url");
		expect(marked(out)).toContain(6);
	});

	it("stripCacheBreakpoints desfaz a marcação", () => {
		const stripped = stripCacheBreakpoints(applyCacheBreakpoints(conversation));
		expect(marked(stripped)).toEqual([]);
	});

	it("corpo: anthropic leva cache_control; openai fica idêntico", () => {
		const anthropic = chatRequestBody(
			{ messages: conversation, model: "anthropic/claude-sonnet-5.5", apiKey: "k", tools },
			true,
		);
		expect(marked(anthropic.messages)).toEqual([0, 3, 5]);
		const openai = chatRequestBody(
			{ messages: conversation, model: "openai/gpt-5", apiKey: "k", tools },
			true,
		);
		expect(openai.messages).toBe(conversation);
	});

	it("sessionId vira session_id (cache sticky)", () => {
		const body = chatRequestBody(
			{ messages: conversation, model: "openai/gpt-5", apiKey: "k", tools, sessionId: "run1" },
			false,
		);
		expect(body.session_id).toBe("run1");
	});

	it("usageFrom lê cached_tokens e cache_write_tokens", () => {
		expect(
			usageFrom({
				prompt_tokens: 1000,
				completion_tokens: 10,
				total_tokens: 1010,
				prompt_tokens_details: { cached_tokens: 900, cache_write_tokens: 50 },
			}),
		).toMatchObject({ promptTokens: 1000, cachedTokens: 900, cacheWriteTokens: 50 });
		expect(usageFrom(undefined)).toBeUndefined();
	});

	it("usageFrom lê o custo real (usage.cost); inválido é ignorado", () => {
		expect(usageFrom({ prompt_tokens: 1, cost: 0.0123 })?.costUsd).toBe(0.0123);
		expect(usageFrom({ prompt_tokens: 1, cost: -1 })?.costUsd).toBeUndefined();
		expect(usageFrom({ prompt_tokens: 1 })?.costUsd).toBeUndefined();
	});

	it("o corpo pede a contabilidade de uso", () => {
		const body = chatRequestBody(
			{ messages: conversation, model: "openai/gpt-5", apiKey: "k", tools },
			true,
		);
		expect(body.usage).toEqual({ include: true });
	});
});

describe("fallback sem cache_control", () => {
	afterEach(() => vi.unstubAllGlobals());

	it("400 citando cache_control repete a chamada sem breakpoints", async () => {
		const bodies: string[] = [];
		const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
			bodies.push(String(init.body));
			if (bodies.length === 1) {
				return new Response(
					JSON.stringify({ error: { message: "cache_control not supported" } }),
					{ status: 400 },
				);
			}
			return new Response(
				JSON.stringify({
					model: "anthropic/claude-sonnet-5.5",
					choices: [{ message: { role: "assistant", content: "ok" } }],
				}),
				{ status: 200 },
			);
		});
		vi.stubGlobal("fetch", fetchMock);
		const result = await completeChatWithTools({
			messages: conversation,
			model: "anthropic/claude-sonnet-5.5",
			apiKey: "k",
			tools,
		});
		expect(result.message.content).toBe("ok");
		expect(bodies[0]).toContain("cache_control");
		expect(bodies[1]).not.toContain("cache_control");
	});
});
