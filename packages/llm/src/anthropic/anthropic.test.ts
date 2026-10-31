import { describe, expect, it, vi } from "vitest";
import type { CompleteChatWithToolsParams } from "../chat-tools.js";
import { ProviderApiError } from "../provider-errors.js";
import { anthropicRequestBody, toAnthropicMessages } from "./convert.js";
import { createAnthropicStreamChat, readAnthropicSse } from "./stream.js";

const KEY = "sk-ant-test-SECRET-1234";
const tool = {
	type: "function" as const,
	function: { name: "buscar", description: "Busca algo", parameters: { type: "object" as const, properties: { q: { type: "string" } }, required: ["q"] } },
};
const base: CompleteChatWithToolsParams = {
	apiKey: "",
	model: "anthropic-direct/claude-sonnet-5-5",
	tools: [tool],
	messages: [
		{ role: "system", content: "Você é um assistente." },
		{ role: "user", content: [{ type: "text", text: "olhe" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }] },
		{ role: "assistant", content: "Vou buscar", tool_calls: [{ id: "toolu_1", type: "function", function: { name: "buscar", arguments: '{"q":"x"}' } }] },
		{ role: "tool", tool_call_id: "toolu_1", content: "resultado" },
		{ role: "user", content: "e agora?" },
	],
};

function sse(events: unknown[]): ReadableStream<Uint8Array> {
	const text = events.map((event) => `event: ${(event as { type: string }).type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
	return new ReadableStream({
		start(controller) {
			controller.enqueue(new TextEncoder().encode(text));
			controller.close();
		},
	});
}
const happy = [
	{ type: "message_start", message: { id: "msg_1", model: "claude-sonnet-5-5", usage: { input_tokens: 10, cache_read_input_tokens: 200, cache_creation_input_tokens: 30, output_tokens: 1 } } },
	{ type: "ping" },
	{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
	{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Olá " } },
	{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "mundo" } },
	{ type: "content_block_stop", index: 0 },
	{ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_9", name: "buscar", input: {} } },
	{ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"q":' } },
	{ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '"gato"}' } },
	{ type: "content_block_stop", index: 1 },
	{ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 42 } },
	{ type: "message_stop" },
];

describe("conversão para a Messages API", () => {
	it("system vira campo de topo; tool_result volta como user e vem antes do texto", () => {
		const { system, messages } = toAnthropicMessages(base.messages);
		expect(system).toEqual([{ type: "text", text: "Você é um assistente." }]);
		expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
		expect(messages[0]!.content[1]).toEqual({ type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } });
		expect(messages[1]!.content).toEqual([
			{ type: "text", text: "Vou buscar" },
			{ type: "tool_use", id: "toolu_1", name: "buscar", input: { q: "x" } },
		]);
		expect(messages[2]!.content).toEqual([
			{ type: "tool_result", tool_use_id: "toolu_1", content: "resultado" },
			{ type: "text", text: "e agora?" },
		]);
	});

	it("argumentos inválidos viram objeto vazio; imagem https vira url", () => {
		const { messages } = toAnthropicMessages([
			{ role: "user", content: [{ type: "image_url", image_url: { url: "https://x.test/a.png" } }] },
			{ role: "assistant", content: null, tool_calls: [{ id: "a", type: "function", function: { name: "n", arguments: "{quebrado" } }] },
		]);
		expect(messages[0]!.content[0]).toEqual({ type: "image", source: { type: "url", url: "https://x.test/a.png" } });
		expect(messages[1]!.content).toEqual([{ type: "tool_use", id: "a", name: "n", input: {} }]);
	});

	it("aplica cache_control no último tool, no sistema e no último turno (máx. 4)", () => {
		const body = anthropicRequestBody(base, "claude-sonnet-5-5");
		expect(body.model).toBe("claude-sonnet-5-5");
		expect(body.stream).toBe(true);
		expect(body.tools?.at(-1)?.cache_control).toEqual({ type: "ephemeral" });
		expect(body.system?.[0]?.cache_control).toEqual({ type: "ephemeral" });
		const json = JSON.stringify(body);
		expect((json.match(/"cache_control"/g) ?? []).length).toBeLessThanOrEqual(4);
		expect(json).not.toContain("providerItems");
		expect(body.tool_choice).toEqual({ type: "auto" });
	});

	it("sem cache não envia cache_control; required vira any", () => {
		const body = anthropicRequestBody({ ...base, toolChoice: "required" }, "m", { cache: false });
		expect(JSON.stringify(body)).not.toContain("cache_control");
		expect(body.tool_choice).toEqual({ type: "any" });
	});
});

describe("breakpoint de cache em resultado de tool", () => {
	it("o cache_control marcado no texto do resultado vai para o bloco tool_result (não some no join)", () => {
		const { messages } = toAnthropicMessages([
			{ role: "user", content: "oi" },
			{ role: "assistant", content: null, tool_calls: [{ id: "t1", type: "function", function: { name: "x", arguments: "{}" } }] },
			{ role: "tool", tool_call_id: "t1", content: [{ type: "text", text: "resultado", cache_control: { type: "ephemeral" } }] },
		]);
		expect(messages.at(-1)!.content[0]).toEqual({ type: "tool_result", tool_use_id: "t1", content: "resultado", cache_control: { type: "ephemeral" } });
		const plain = toAnthropicMessages([
			{ role: "user", content: "oi" },
			{ role: "assistant", content: null, tool_calls: [{ id: "t1", type: "function", function: { name: "x", arguments: "{}" } }] },
			{ role: "tool", tool_call_id: "t1", content: "resultado" },
		]);
		expect(plain.messages.at(-1)!.content[0]).toEqual({ type: "tool_result", tool_use_id: "t1", content: "resultado" });
	});
});

describe("parser SSE da Anthropic", () => {
	it("acumula texto, tool_use e uso", async () => {
		const events: string[] = [];
		await readAnthropicSse(sse(happy), (event) => events.push(event.type));
		expect(events).toContain("content_block_delta");
		expect(events.at(-1)).toBe("message_stop");
	});

	it("fim do corpo antes de message_stop é stream_interrupted", async () => {
		await expect(readAnthropicSse(sse(happy.slice(0, 4)), () => undefined)).rejects.toMatchObject({ code: "stream_interrupted" });
	});

	it("evento error vira erro tipado sem texto do upstream", async () => {
		const body = sse([{ type: "error", error: { type: "overloaded_error", message: `segredo ${KEY}` } }]);
		const error = await readAnthropicSse(body, () => undefined).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(ProviderApiError);
		expect((error as ProviderApiError).code).toBe("unavailable");
		expect((error as Error).message).not.toContain(KEY);
	});
});

describe("createAnthropicStreamChat", () => {
	function make(fetchImpl: typeof fetch) {
		return createAnthropicStreamChat({ provider: "anthropic", getApiKey: async () => KEY, url: "https://api.anthropic.com/v1/messages", auth: "x-api-key", fetch: fetchImpl });
	}

	it("envia x-api-key e anthropic-version, devolve tool_calls e uso com custo desconhecido", async () => {
		const fetchMock = vi.fn(async (..._args: unknown[]) => new Response(sse(happy), { status: 200 }));
		const deltas: string[] = [];
		const result = await make(fetchMock as unknown as typeof fetch)({ ...base, apiKey: "" }, { onDelta: (t) => deltas.push(t) });
		const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe("https://api.anthropic.com/v1/messages");
		const headers = init.headers as Record<string, string>;
		expect(headers["x-api-key"]).toBe(KEY);
		expect(headers["anthropic-version"]).toBe("2023-06-01");
		expect(headers.Authorization).toBeUndefined();
		expect(JSON.parse(init.body as string).model).toBe("claude-sonnet-5-5");
		expect(init.body as string).not.toContain(KEY);
		expect(deltas.join("")).toBe("Olá mundo");
		expect(result.message.content).toBe("Olá mundo");
		expect(result.message.tool_calls).toEqual([{ id: "toolu_9", type: "function", function: { name: "buscar", arguments: '{"q":"gato"}' } }]);
		expect(result.finishReason).toBe("tool_calls");
		expect(result.model).toBe("anthropic-direct/claude-sonnet-5-5");
		expect(result.usage).toEqual({ promptTokens: 240, completionTokens: 42, totalTokens: 282, cachedTokens: 200, cacheWriteTokens: 30, costUnknown: true });
	});

	it("avisa o nome da tool (sem argumentos) assim que o bloco começa", async () => {
		const fetchMock = vi.fn(async (..._args: unknown[]) => new Response(sse(happy), { status: 200 }));
		const intents: unknown[] = [];
		await make(fetchMock as unknown as typeof fetch)({ ...base, apiKey: "" }, { onToolIntent: (i) => intents.push(i) });
		expect(intents).toEqual([{ index: 1, id: "toolu_9", name: "buscar" }]);
	});

	it("401 vira auth_failed sem eco da chave nem do corpo", async () => {
		const fetchMock = vi.fn(async (..._args: unknown[]) => new Response(JSON.stringify({ error: { type: "authentication_error", message: `invalid ${KEY}` } }), { status: 401 }));
		const error = await make(fetchMock as unknown as typeof fetch)(base).catch((e: unknown) => e);
		expect(error).toMatchObject({ name: "ProviderApiError", code: "auth_failed", status: 401 });
		expect(JSON.stringify(error)).not.toContain(KEY);
		expect((error as Error).message).not.toContain(KEY);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("repete uma vez sem cache_control quando o provedor recusa", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: "cache_control not allowed" } }), { status: 400 }))
			.mockResolvedValueOnce(new Response(sse(happy), { status: 200 }));
		await make(fetchMock as unknown as typeof fetch)(base);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(fetchMock.mock.calls[0]![1].body).toContain("cache_control");
		expect(fetchMock.mock.calls[1]![1].body).not.toContain("cache_control");
	});
});
