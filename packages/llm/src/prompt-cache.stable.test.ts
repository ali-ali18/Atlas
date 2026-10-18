import { describe, expect, it } from "vitest";
import { chatRequestBody } from "./chat-tools.js";
import type { LlmMessage } from "./chat-tools.js";
import { applyCacheBreakpoints } from "./prompt-cache.js";

const conversation: LlmMessage[] = [
	{ role: "system", content: "sys" },
	{ role: "user", content: "task" },
	{ role: "assistant", content: null, tool_calls: [] },
	{ role: "tool", tool_call_id: "a", content: "[collapsed a]" },
	{ role: "assistant", content: null, tool_calls: [] },
	{ role: "tool", tool_call_id: "b", content: "full b" },
	{ role: "assistant", content: null, tool_calls: [] },
	{ role: "tool", tool_call_id: "c", content: "full c" },
];

const marked = (messages: LlmMessage[]) =>
	messages.flatMap((m, i) =>
		Array.isArray(m.content) && m.content.some((p) => p.type === "text" && p.cache_control) ? [i] : [],
	);

describe("breakpoint do fim do prefixo estável (L4)", () => {
	it("marca o fim do trecho estável além de sistema, anterior e última", () => {
		expect(marked(applyCacheBreakpoints(conversation, undefined, { stableIndex: 3 }))).toEqual([0, 3, 5, 7]);
	});
	it("sem stableIndex nada muda", () => {
		expect(marked(applyCacheBreakpoints(conversation))).toEqual([0, 5, 7]);
	});
	it("índice inválido, repetido ou na última mensagem é ignorado", () => {
		for (const stableIndex of [-1, 99, 1.5, 7, 5, 0]) {
			expect(marked(applyCacheBreakpoints(conversation, undefined, { stableIndex }))).toEqual([0, 5, 7]);
		}
	});
	it("respeita o teto de 4 breakpoints e não muta a entrada", () => {
		const copy = JSON.stringify(conversation);
		expect(marked(applyCacheBreakpoints(conversation, 4, { stableIndex: 3 }))).toHaveLength(4);
		expect(marked(applyCacheBreakpoints(conversation, 3, { stableIndex: 3 }))).toEqual([0, 5, 7]);
		expect(JSON.stringify(conversation)).toBe(copy);
	});
	it("o corpo da request só usa o índice em provider com cache explícito", () => {
		const params = { apiKey: "k", messages: conversation, tools: [], cacheStableIndex: 3 };
		const anthropic = chatRequestBody({ ...params, model: "anthropic/claude-sonnet-5.5" }, false);
		expect(marked(anthropic.messages as LlmMessage[])).toEqual([0, 3, 5, 7]);
		const automatic = chatRequestBody({ ...params, model: "openai/gpt-5" }, false);
		expect(marked(automatic.messages as LlmMessage[])).toEqual([]);
	});
});
