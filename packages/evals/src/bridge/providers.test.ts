import { describe, expect, it } from "vitest";
import { CLAUDE_DIRECT_PRICES, anthropicKeyFrom, assertKeysFor, claudeCallCostUsd, claudePriceFor, createRealModel, isClaudeDirect } from "./providers.js";

/** Anthropic direta na ponte: fetch mockado (nada de rede), custo calculado dos tokens, chave só do ambiente e nunca impressa. */

const KEY = "sk-ant-segredo-do-teste";
const HAIKU = CLAUDE_DIRECT_PRICES[0]!;

function sse(events: unknown[]): Response {
	const text = events.map((event) => `event: x\ndata: ${JSON.stringify(event)}\n\n`).join("");
	return new Response(new ReadableStream({ start: (controller) => { controller.enqueue(new TextEncoder().encode(text)); controller.close(); } }), { status: 200, headers: { "content-type": "text/event-stream" } });
}

const toolUseStream = (usage: Record<string, number>) => [
	{ type: "message_start", message: { id: "msg_1", model: "claude-haiku-5-5", usage } },
	{ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name: "tool_search" } },
	{ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"query":' } },
	{ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '"painel"}' } },
	{ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 200 } },
	{ type: "message_stop" },
];

const params = { model: "claude-haiku-5-5", apiKey: "x", messages: [{ role: "system" as const, content: "Seja breve." }, { role: "user" as const, content: "crie um painel" }], tools: [{ type: "function" as const, function: { name: "tool_search", description: "busca", parameters: { type: "object" as const, properties: { query: { type: "string" } }, required: ["query"] } } }] };

describe("Anthropic direta na ponte", () => {
	it("reconhece só claude-* como direto (anthropic/claude-* continua OpenRouter)", () => {
		expect(isClaudeDirect("claude-haiku-5-5")).toBe(true);
		expect(isClaudeDirect("anthropic-direct/claude-opus-5-5")).toBe(true);
		expect(isClaudeDirect("anthropic/claude-sonnet-4.5")).toBe(false);
		expect(isClaudeDirect("deepseek/deepseek-chat")).toBe(false);
	});

	it("chave: ANTHROPIC_API_KEY, depois CLAUDE_KEY, depois claude_key", () => {
		expect(anthropicKeyFrom({ ANTHROPIC_API_KEY: "a", CLAUDE_KEY: "b", claude_key: "c" })).toBe("a");
		expect(anthropicKeyFrom({ CLAUDE_KEY: "b", claude_key: "c" })).toBe("b");
		expect(anthropicKeyFrom({ claude_key: " c " })).toBe("c");
		expect(anthropicKeyFrom({})).toBe("");
	});

	it("chave ausente falha claro antes de gastar, com os nomes e sem valor", () => {
		expect(() => assertKeysFor(["claude-haiku-5-5"], {})).toThrow(/ANTHROPIC_API_KEY ou CLAUDE_KEY ou claude_key/);
		expect(() => assertKeysFor(["claude-haiku-5-5"], { claude_key: KEY })).not.toThrow();
		// Só Claude: a chave do OpenRouter não é exigida.
		expect(() => assertKeysFor(["claude-haiku-5-5", "deepseek/deepseek-chat"], { claude_key: KEY })).toThrow(/OPENROUTER_API_KEY/);
		let message = "";
		try {
			assertKeysFor(["claude-haiku-5-5", "opencode-go/kimi-k2"], { claude_key: KEY });
		} catch (error) {
			message = String(error);
		}
		expect(message).not.toContain(KEY);
	});

	it("modelo claude sem preço falha antes de gastar, e --prices resolve", () => {
		expect(() => assertKeysFor(["claude-novo-9"], { claude_key: KEY })).toThrow(/sem preço para claude-novo-9/);
		expect(() => assertKeysFor(["claude-novo-9"], { claude_key: KEY }, [{ model: "claude-novo-9", promptUsdPerMTok: 1, completionUsdPerMTok: 2 }])).not.toThrow();
	});

	it("custo: entrada nova + cache lido (0,1x) + cache gravado (1,25x) + saída, e a faixa acima de 100 mil tokens", () => {
		// 1.000 novos + 8.000 lidos + 2.000 gravados = 11.000 de prompt; 500 de saída.
		const usd = claudeCallCostUsd({ promptTokens: 11_000, completionTokens: 500, cachedTokens: 8_000, cacheWriteTokens: 2_000 }, HAIKU);
		expect(usd).toBeCloseTo((1_000 * 0.1 + 8_000 * 0.1 * 0.1 + 2_000 * 0.1 * 1.25 + 500 * 0.5) / 1_000_000, 10);
		const long = claudeCallCostUsd({ promptTokens: 120_000, completionTokens: 1_000 }, HAIKU);
		expect(long).toBeCloseTo((120_000 * 0.5 + 1_000 * 2.5) / 1_000_000, 10);
		expect(claudePriceFor("anthropic-direct/claude-haiku-5-5").model).toBe("claude-haiku-5-5");
	});

	it("manda a Messages API com x-api-key e tool use, e devolve tool_call, tokens, cache e custo", async () => {
		const calls: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }> = [];
		const fetchMock: typeof fetch = async (input, init) => {
			calls.push({ url: String(input), headers: Object.fromEntries(new Headers(init?.headers).entries()), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
			return sse(toolUseStream({ input_tokens: 1_000, cache_read_input_tokens: 8_000, cache_creation_input_tokens: 2_000, output_tokens: 1 }));
		};
		const real = createRealModel({ claude_key: KEY }, { fetch: fetchMock });
		const result = await real.streamChat(params);

		expect(calls).toHaveLength(1);
		expect(calls[0]!.url).toBe("https://api.anthropic.com/v1/messages");
		expect(calls[0]!.headers["x-api-key"]).toBe(KEY);
		expect(calls[0]!.headers["anthropic-version"]).toBe("2023-06-01");
		// O id enviado é o slug da Anthropic, sem prefixo interno.
		expect(calls[0]!.body.model).toBe("claude-haiku-5-5");
		const tools = calls[0]!.body.tools as Array<{ name: string; input_schema: unknown }>;
		expect(tools[0]!.name).toBe("tool_search");
		expect(tools[0]!.input_schema).toBeTruthy();

		expect(result.message.tool_calls).toEqual([{ id: "toolu_1", type: "function", function: { name: "tool_search", arguments: '{"query":"painel"}' } }]);
		expect(result.finishReason).toBe("tool_calls");
		expect(result.usage).toMatchObject({ promptTokens: 11_000, completionTokens: 200, cachedTokens: 8_000, cacheWriteTokens: 2_000 });
		expect(result.usage?.costUnknown).toBeUndefined();
		expect(result.usage?.costUsd).toBeCloseTo((1_000 * 0.1 + 8_000 * 0.01 + 2_000 * 0.125 + 200 * 0.5) / 1_000_000, 10);
		expect(real.secrets).toEqual([KEY]);
		expect(real.apiKey).toBe(KEY);
	});

	it("o preço de --prices vale no custo informado", async () => {
		const fetchMock: typeof fetch = async () => sse(toolUseStream({ input_tokens: 1_000_000, output_tokens: 1 }));
		const real = createRealModel({ ANTHROPIC_API_KEY: KEY }, { fetch: fetchMock, prices: [{ model: "claude-haiku-5-5", promptUsdPerMTok: 1, completionUsdPerMTok: 5 }] });
		const result = await real.streamChat(params);
		expect(result.usage?.costUsd).toBeCloseTo(1 + 200 * 5 / 1_000_000, 8);
	});

	it("erro HTTP não vaza a chave", async () => {
		const fetchMock: typeof fetch = async () => new Response(JSON.stringify({ error: { type: "authentication_error", message: `invalid x-api-key ${KEY}` } }), { status: 401 });
		const real = createRealModel({ claude_key: KEY }, { fetch: fetchMock });
		const error = await real.streamChat(params).then(() => "", (caught: unknown) => String(caught instanceof Error ? caught.message : caught));
		expect(error).not.toBe("");
		expect(error).not.toContain(KEY);
	});

	it("sem chave no ambiente, claude-* falha claro no streamChat", async () => {
		const real = createRealModel({ OPENROUTER_API_KEY: "or" }, {});
		await expect(real.streamChat(params)).rejects.toThrow(/ANTHROPIC_API_KEY ou CLAUDE_KEY ou claude_key/);
	});
});
