import { describe, expect, it } from "vitest";
import { anthropicRequestBody } from "./anthropic/convert.js";
import { chatRequestBody } from "./chat-tools.js";
import type { LlmMessage } from "./chat-tools.js";
import { applyCacheBreakpoints } from "./prompt-cache.js";
import { responsesRequestBody } from "./responses/request.js";
import { canonicalMessage, demoteSystemNotes, EPHEMERAL_CONTEXT_MARK, remapStableIndex } from "./system-notes.js";

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
		expect(messages.map((m) => m.role)).toEqual(["system", "system", "user", "user", "assistant", "tool", "tool", "user"]);
		expect(texts(messages)[3]).toContain("<system-reminder>");
		expect(texts(messages)[3]).toContain("nota do turno");
		expect(texts(messages)[7]).toContain("aviso no meio da rodada");
		expect(positions).toEqual([0, 1, 2, 3, 4, 5, 7, 6]);
		expect(remapStableIndex(6, positions)).toBe(7);
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

	it("nota de gate persistida depois do assistente continua turno de usuário próprio, na posição original", () => {
		const gate = demoteSystemNotes([
			{ role: "system", content: "prompt" },
			{ role: "user", content: "pedido" },
			{ role: "assistant", content: "rascunho" },
			{ role: "system", content: "Revise: a resposta foi cortada" },
		]).messages;
		expect(gate.map((m) => m.role)).toEqual(["system", "user", "assistant", "user"]);
		expect(texts(gate)[3]).toContain("Revise: a resposta foi cortada");
	});

	describe("camada efêmera de hora", () => {
		const time = (t: string) => ({ role: "system" as const, content: `${EPHEMERAL_CONTEXT_MARK} ignore. Now is ${t}` });
		const history: LlmMessage[] = [{ role: "system", content: "prompt" }, { role: "user", content: "oi" }];

		it("depois da fala do usuário cola no mesmo turno; o prefixo cacheado é idêntico entre minutos", () => {
			const a = demoteSystemNotes([...history, time("17:37")]).messages;
			expect(a.map((m) => m.role)).toEqual(["system", "user"]);
			expect(texts(a)[1]).toContain("oi");
			expect(texts(a)[1]).toContain("Now is 17:37");
			const prefix = (t: string) => {
				const d = demoteSystemNotes([...history, time(t)]);
				const marked = applyCacheBreakpoints(d.messages, 4, { stableIndex: remapStableIndex(1, d.positions) });
				const parts = marked[1]!.content as Array<{ cache_control?: unknown }>;
				expect(parts[0]!.cache_control).toBeDefined();
				expect(parts[1]!.cache_control).toBeUndefined();
				return JSON.stringify([marked[0], parts[0]]);
			};
			expect(prefix("17:37")).toBe(prefix("17:41"));
		});

		it("depois de assistente ou de resultado de ferramenta (ou rodada aberta) é omitida, nunca vira turno só de contexto", () => {
			const afterAssistant = demoteSystemNotes([...history, { role: "assistant", content: "feito" }, time("17:40")]);
			expect(afterAssistant.messages.map((m) => m.role)).toEqual(["system", "user", "assistant"]);
			expect(JSON.stringify(afterAssistant.messages)).not.toContain("Now is");
			const round = demoteSystemNotes([...history, { role: "assistant", content: null, tool_calls: [call("a")] }, { role: "tool", tool_call_id: "a", content: "r" }, time("17:40")]);
			expect(round.messages.map((m) => m.role)).toEqual(["system", "user", "assistant", "tool"]);
			expect(JSON.stringify(round.messages)).not.toContain("Now is");
			const open = demoteSystemNotes([...history, { role: "assistant", content: null, tool_calls: [call("a")] }, time("17:40")]);
			expect(JSON.stringify(open.messages)).not.toContain("Now is");
		});

		it("depois de nota de gate (user próprio após o rascunho) cola na nota, que já é turno de usuário", () => {
			const out = demoteSystemNotes([...history, { role: "assistant", content: "rascunho" }, { role: "system", content: "Revise" }, time("17:40")]).messages;
			expect(out.map((m) => m.role)).toEqual(["system", "user", "assistant", "user"]);
			expect(texts(out)[3]).toContain("Revise");
			expect(texts(out)[3]).toContain("Now is 17:40");
		});
	});
});
