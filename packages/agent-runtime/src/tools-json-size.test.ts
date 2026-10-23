import { afterEach, describe, expect, it, vi } from "vitest";
import type { LlmMessage } from "@workspace/llm";
import { toolsJsonCharsOf } from "./tools-json-size.js";
import { applyPromptHygiene, estimateMessagesTokens } from "./hygiene.js";
import { TOKEN_ESTIMATE_CHARS_PER_TOKEN } from "@workspace/shared";

const tool = (name: string, extra = "") => ({
	type: "function" as const,
	function: { name, description: `faz ${name}${extra} "aspas" e ç`, parameters: { type: "object", properties: { q: { type: "string" } }, required: ["q"] } },
});

afterEach(() => vi.restoreAllMocks());

describe("toolsJsonCharsOf", () => {
	it("bate com JSON.stringify(tools).length (vazio, um, vários)", () => {
		for (const tools of [[], [tool("a")], [tool("a"), tool("b", "x".repeat(300)), tool("c")]]) {
			expect(toolsJsonCharsOf(tools)).toBe(JSON.stringify(tools).length);
		}
	});

	it("serializa cada definição uma vez só; tool nova entra sem reserializar as outras", () => {
		const tools = [tool("a"), tool("b"), tool("c")];
		const spy = vi.spyOn(JSON, "stringify");
		const first = toolsJsonCharsOf(tools);
		expect(spy).toHaveBeenCalledTimes(3);
		spy.mockClear();
		expect(toolsJsonCharsOf(tools)).toBe(first);
		expect(toolsJsonCharsOf(tools.slice(0, 2))).toBe(JSON.stringify(tools.slice(0, 2)).length);
		spy.mockClear();
		const grown = [...tools, tool("d")];
		const size = toolsJsonCharsOf(grown);
		expect(spy).toHaveBeenCalledTimes(1);
		spy.mockRestore();
		expect(size).toBe(JSON.stringify(grown).length);
	});
});

/** Referência sem memo: a fórmula de antes. */
function naiveTokens(messages: readonly LlmMessage[], toolsJsonChars = 0): number {
	let chars = toolsJsonChars;
	for (const message of messages) {
		if (typeof message.content === "string") chars += message.content.length;
		else if (message.content !== null) chars += Math.min(JSON.stringify(message.content).length, 20_000);
		if (message.providerItems) chars += JSON.stringify(message.providerItems).length;
		if (message.tool_calls) chars += JSON.stringify(message.tool_calls).length;
	}
	return chars <= 0 ? 0 : Math.max(1, Math.ceil(chars / TOKEN_ESTIMATE_CHARS_PER_TOKEN));
}

function conversation(): LlmMessage[] {
	const out: LlmMessage[] = [{ role: "system", content: "sys" }, { role: "user", content: "pesquisa tudo" }];
	for (let i = 0; i < 12; i += 1) {
		out.push({ role: "assistant", content: null, tool_calls: [{ id: `c${i}`, type: "function", function: { name: "web_search", arguments: JSON.stringify({ query: `q${i}` }) } }] });
		out.push({ role: "tool", tool_call_id: `c${i}`, content: `resultado ${i} ${"x".repeat(500)}` });
	}
	out.push({ role: "user", content: [{ type: "text", text: "e isto?" }] });
	return out;
}

describe("estimateMessagesTokens memorizado", () => {
	it("mesmo resultado que a fórmula sem memo", () => {
		const messages = conversation();
		expect(estimateMessagesTokens(messages, 1234)).toBe(naiveTokens(messages, 1234));
		expect(estimateMessagesTokens(messages, 1234)).toBe(naiveTokens(messages, 1234));
	});

	it("a segunda estimativa da mesma conversa não serializa nada", () => {
		const messages = conversation();
		estimateMessagesTokens(messages);
		const spy = vi.spyOn(JSON, "stringify");
		estimateMessagesTokens(messages);
		estimateMessagesTokens(messages.slice(3));
		expect(spy).not.toHaveBeenCalled();
	});

	it("mensagem trocada (conteúdo novo) é medida de novo", () => {
		const messages = conversation();
		const before = estimateMessagesTokens(messages);
		const last = messages.length - 2;
		messages[last] = { ...messages[last]!, content: `${messages[last]!.content as string}${"y".repeat(4000)}` };
		const after = estimateMessagesTokens(messages);
		expect(after).toBe(naiveTokens(messages));
		expect(after).toBeGreaterThan(before);
	});

	it("applyPromptHygiene sobre a mesma conversa serializa as tool_calls no máximo uma vez por mensagem", () => {
		const messages = conversation();
		const toolCallMessages = messages.filter((message) => message.tool_calls).length;
		const spy = vi.spyOn(JSON, "stringify");
		applyPromptHygiene(messages, { contextLength: 128_000, toolsJsonChars: 5000 });
		const firstCalls = spy.mock.calls.filter(([value]) => Array.isArray(value) && (value as Array<{ type?: string }>)[0]?.type === "function").length;
		expect(firstCalls).toBeLessThanOrEqual(toolCallMessages);
		spy.mockClear();
		applyPromptHygiene(messages, { contextLength: 128_000, toolsJsonChars: 5000 });
		const secondCalls = spy.mock.calls.filter(([value]) => Array.isArray(value) && (value as Array<{ type?: string }>)[0]?.type === "function").length;
		expect(secondCalls).toBe(0);
	});
});
