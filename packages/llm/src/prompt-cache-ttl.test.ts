import { afterEach, describe, expect, it, vi } from "vitest";
import { anthropicRequestBody } from "./anthropic/convert.js";
import { createAnthropicStreamChat } from "./anthropic/stream.js";
import { chatRequestBody, completeChatWithTools } from "./chat-tools.js";
import type { CompleteChatWithToolsParams } from "./chat-tools.js";
import { applyCacheBreakpoints, configuredCacheTtl } from "./prompt-cache.js";

const params: CompleteChatWithToolsParams = {
	apiKey: "k",
	model: "anthropic/claude-sonnet-5.5",
	tools: [{ type: "function", function: { name: "t", description: "d", parameters: { type: "object", properties: {} } } }],
	messages: [
		{ role: "system", content: "sys" },
		{ role: "user", content: "oi" },
		{ role: "assistant", content: "ola" },
		{ role: "user", content: "e agora" },
	],
};
const controls = (value: unknown) => JSON.stringify(value).match(/"cache_control":\{[^}]*\}/g) ?? [];
const okStream = () =>
	new Response(
		[
			`data: ${JSON.stringify({ type: "message_start", message: { model: "claude", usage: { input_tokens: 3 } } })}`,
			`data: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}`,
			`data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } })}`,
			`data: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } })}`,
			`data: ${JSON.stringify({ type: "message_stop" })}`,
			"",
		].join("\n\n"),
	);

afterEach(() => vi.unstubAllEnvs());

describe("validade de 1 hora do cache de prompt (ATLAS_PROMPT_CACHE_TTL)", () => {
	it("padrão inalterado: sem a chave nenhum breakpoint leva ttl", () => {
		expect(configuredCacheTtl()).toBeUndefined();
		expect(controls(anthropicRequestBody(params, "claude")).every((c) => !c.includes("ttl"))).toBe(true);
		expect(controls(chatRequestBody(params, true).messages).every((c) => !c.includes("ttl"))).toBe(true);
		vi.stubEnv("ATLAS_PROMPT_CACHE_TTL", "5m");
		expect(configuredCacheTtl()).toBeUndefined();
	});

	it("com 1h, todos os breakpoints levam ttl na Anthropic direta (sistema, ferramentas e mensagens) e no OpenRouter com Claude", () => {
		vi.stubEnv("ATLAS_PROMPT_CACHE_TTL", " 1H ");
		const direct = controls(anthropicRequestBody(params, "claude"));
		expect(direct.length).toBeGreaterThanOrEqual(3);
		expect(direct.every((c) => c.includes('"ttl":"1h"'))).toBe(true);
		const router = controls(chatRequestBody(params, true).messages);
		expect(router.length).toBeGreaterThanOrEqual(2);
		expect(router.every((c) => c.includes('"ttl":"1h"'))).toBe(true);
		// modelo sem cache explícito continua sem nada
		expect(controls(chatRequestBody({ ...params, model: "openai/gpt-5" }, true).messages)).toEqual([]);
		expect(controls(applyCacheBreakpoints(params.messages, 4, { ttl: "1h" })).every((c) => c.includes("1h"))).toBe(true);
	});

	it("Anthropic direta manda o cabeçalho beta (somando ao que já existia) e, se recusar o ttl, repete com 5 minutos", async () => {
		vi.stubEnv("ATLAS_PROMPT_CACHE_TTL", "1h");
		const fetchFn = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: "cache_control.ttl: extra inputs are not permitted" } }), { status: 400 }))
			.mockImplementation(async () => okStream());
		const chat = createAnthropicStreamChat({ provider: "anthropic", getApiKey: async () => "key", url: "https://api.example/v1/messages", auth: "x-api-key", fetch: fetchFn, headers: () => ({ "anthropic-beta": "other-beta" }) });
		const result = await chat(params);
		expect(result.message.content).toBe("ok");
		const [first, second] = fetchFn.mock.calls;
		expect((first![1]!.headers as Record<string, string>)["anthropic-beta"]).toBe("other-beta,extended-cache-ttl-2025-04-11");
		expect(String(first![1]!.body)).toContain('"ttl":"1h"');
		expect(String(second![1]!.body)).toContain("cache_control");
		expect(String(second![1]!.body)).not.toContain("ttl");
		expect((second![1]!.headers as Record<string, string>)["anthropic-beta"]).toBe("other-beta");
	});

	it("OpenCode Go (proxy) nunca recebe ttl nem o cabeçalho beta", async () => {
		vi.stubEnv("ATLAS_PROMPT_CACHE_TTL", "1h");
		const fetchFn = vi.fn<typeof fetch>().mockImplementation(async () => okStream());
		await createAnthropicStreamChat({ provider: "opencode-go", getApiKey: async () => "key", url: "https://go.example/v1/messages", auth: "bearer", fetch: fetchFn })({ ...params, model: "opencode-go/claude" });
		expect(String(fetchFn.mock.calls[0]![1]!.body)).not.toContain("ttl");
		expect(fetchFn.mock.calls[0]![1]!.headers as Record<string, string>).not.toHaveProperty("anthropic-beta");
	});

	it("OpenRouter: 400 por ttl repete com 5 minutos; 400 por cache_control repete sem breakpoints", async () => {
		vi.stubEnv("ATLAS_PROMPT_CACHE_TTL", "1h");
		const body = (call: unknown[]) => String((call[1] as RequestInit).body);
		const done = () => new Response(JSON.stringify({ model: "m", choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
		const ttlFirst = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: "ttl not supported" } }), { status: 400 })).mockImplementation(async () => done());
		await completeChatWithTools(params);
		expect(body(ttlFirst.mock.calls[0]!)).toContain('"ttl":"1h"');
		expect(body(ttlFirst.mock.calls[1]!)).toContain("cache_control");
		expect(body(ttlFirst.mock.calls[1]!)).not.toContain("ttl");
		ttlFirst.mockRestore();
		const plain = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: "bad cache_control" } }), { status: 400 })).mockImplementation(async () => done());
		await completeChatWithTools(params);
		expect(body(plain.mock.calls[1]!)).not.toContain("cache_control");
		plain.mockRestore();
	});
});
