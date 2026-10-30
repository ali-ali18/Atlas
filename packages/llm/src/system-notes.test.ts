import { describe, expect, it } from "vitest";
import { anthropicRequestBody } from "./anthropic/convert.js";
import { chatRequestBody } from "./chat-tools.js";
import type { LlmMessage } from "./chat-tools.js";
import { applyCacheBreakpoints } from "./prompt-cache.js";
import { responsesRequestBody } from "./responses/request.js";
import { canonicalMessage, demoteSystemNotes, remapStableIndex } from "./system-notes.js";

const call = (id: string) => ({ id, type: "function" as const, function: { name: "t", arguments: "{}" } });
const texts = (messages: LlmMessage[]) => messages.map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)));

describe("notas de sistema no meio da conversa", () => {
	const conversation: LlmMessage[] = [
		{ role: "system", content: "prompt" },
		{ role: "system", content: "identidade" },
		{ role: "user", content: "pedido" },
		{ role: "system", content: "nota do turno" },
		{ role: "assistant", content: null, tool_calls: [call("a"), call("b")] },
		{ role: "tool", tool_call_id: "a", content: "ra" },
		{ role: "system", content: "aviso no meio da rodada" },
		{ role: "tool", tool_call_id: "b", content: "rb" },
	];

	it("só o system do começo continua system; as notas viram texto delimitado e a de meio de rodada espera o fim dela", () => {
		const { messages, positions } = demoteSystemNotes(conversation);
		expect(messages.map((m) => m.role)).toEqual(["system", "system", "user", "assistant", "tool", "tool", "user"]);
		// A nota do turno cola na fala do usuário; a de meio de rodada espera o fim dela e fica depois do último resultado.
		expect(texts(messages)[2]).toContain("pedido");
		expect(texts(messages)[2]).toContain("<system-reminder>");
		expect(texts(messages)[2]).toContain("nota do turno");
		expect(texts(messages)[6]).toContain("aviso no meio da rodada");
		expect(positions).toEqual([0, 1, 2, 2, 3, 4, 6, 5]);
		expect(remapStableIndex(6, positions)).toBe(6);
		expect(remapStableIndex(99, positions)).toBeUndefined();
	});

	it("Anthropic: nenhuma nota entra em system, o prefixo não muda quando uma nota nova chega no fim", () => {
		const base = { apiKey: "k", model: "anthropic/claude-sonnet-5.5", tools: [] };
		const before = anthropicRequestBody({ ...base, messages: conversation.slice(0, 6) }, "claude");
		const after = anthropicRequestBody({ ...base, messages: [...conversation.slice(0, 6), { role: "tool", tool_call_id: "b", content: "rb" }, { role: "system", content: "outra nota" }] }, "claude");
		expect(after.system).toEqual(before.system);
		expect(JSON.stringify(before.system)).not.toContain("nota do turno");
		expect(JSON.stringify(after.messages.slice(0, 2))).toBe(JSON.stringify(before.messages.slice(0, 2)));
	});

	it("OpenRouter com Claude demove as notas; modelos sem cache explícito ficam como estão", () => {
		const claude = chatRequestBody({ apiKey: "k", model: "anthropic/claude-sonnet-5.5", messages: conversation, tools: [] }, true).messages as LlmMessage[];
		expect(claude.filter((m) => m.role === "system")).toHaveLength(2);
		const other = chatRequestBody({ apiKey: "k", model: "openai/gpt-5", messages: conversation, tools: [] }, true).messages as LlmMessage[];
		expect(other.filter((m) => m.role === "system")).toHaveLength(4);
	});

	it("Responses: instructions só com o system do começo, notas na entrada", () => {
		const body = responsesRequestBody({ apiKey: "k", model: "chatgpt/gpt-5", messages: conversation, tools: [] }, "gpt-5");
		expect(body.instructions).toBe("prompt\n\nidentidade");
		expect(JSON.stringify(body.input)).toContain("nota do turno");
	});

	it("a mesma mensagem tem os mesmos bytes venha do provedor ou do checkpoint", () => {
		const live = canonicalMessage({ role: "tool", tool_call_id: "a", content: "x" });
		const stored = canonicalMessage({ role: "tool", content: "x", tool_call_id: "a" });
		expect(JSON.stringify(live)).toBe(JSON.stringify(stored));
		const reordered = { role: "assistant", content: null, tool_calls: [{ type: "function", function: { arguments: "{}", name: "t" }, id: "a" }] } as LlmMessage;
		expect(JSON.stringify(canonicalMessage(reordered))).toBe(JSON.stringify(canonicalMessage({ role: "assistant", content: null, tool_calls: [call("a")] })));
	});
});

describe("breakpoint no fim do histórico com camadas efêmeras", () => {
	it("um stableIndex depois do fim do pedido anterior ganha do breakpoint antes do último assistant quando o teto aperta", () => {
		const messages: LlmMessage[] = [
			{ role: "system", content: "sys" },
			{ role: "user", content: "task" },
			{ role: "assistant", content: "a1" },
			{ role: "user", content: "r1" },
			{ role: "user", content: "r2" },
			{ role: "system", content: "camada" },
		];
		const marked = (list: LlmMessage[]) => list.flatMap((m, i) => (Array.isArray(m.content) && m.content.some((p) => p.type === "text" && p.cache_control) ? [i] : []));
		// teto 3 (Anthropic com tools): sistema, última e o fim do histórico (4), não o 1 antes do assistant
		expect(marked(applyCacheBreakpoints(messages, 3, { stableIndex: 4 }))).toEqual([0, 4, 5]);
		expect(marked(applyCacheBreakpoints(messages, 3))).toEqual([0, 1, 5]);
	});

	it("nota no fim cola na última fala do usuário (nunca turno só de contexto) e o prefixo cacheado não muda", () => {
		const history: LlmMessage[] = [{ role: "system", content: "prompt" }, { role: "user", content: "oi" }];
		const at = (time: string) => [...history, { role: "system" as const, content: `Now is ${time}` }];
		const a = demoteSystemNotes(at("17:37")).messages;
		expect(a.map((m) => m.role)).toEqual(["system", "user"]);
		expect(texts(a)[1]).toContain("oi");
		expect(texts(a)[1]).toContain("Now is 17:37");
		// Depois de uma resposta do assistente sem fala nova, a nota vai para a última fala do usuário.
		const cont = demoteSystemNotes([...history, { role: "assistant", content: "feito" }, { role: "system", content: "Now is 17:40" }]).messages;
		expect(cont.map((m) => m.role)).toEqual(["system", "user", "assistant"]);
		// Cache: o breakpoint fica no texto estável, antes da nota, e os bytes do prefixo são idênticos entre minutos.
		const prefix = (time: string) => {
			const d = demoteSystemNotes(at(time));
			const marked = applyCacheBreakpoints(d.messages, 4, { stableIndex: remapStableIndex(1, d.positions) });
			const parts = marked[1]!.content as Array<{ text: string; cache_control?: unknown }>;
			expect(parts[0]!.cache_control).toBeDefined();
			expect(parts[1]!.cache_control).toBeUndefined();
			return JSON.stringify([marked[0], parts[0]]);
		};
		expect(prefix("17:37")).toBe(prefix("17:41"));
	});
});
