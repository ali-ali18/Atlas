import { describe, expect, it } from "vitest";
import type { LlmMessage } from "@workspace/llm";
import { appendToLatestToolResult, conversationHasNote, createStepNotices, splitToolResultNotes, TOOL_RESULT_NOTE_MARKER } from "./tool-result-notes.js";

const batch = (): LlmMessage[] => [
	{ role: "system", content: "S" },
	{ role: "user", content: "u" },
	{ role: "assistant", content: null, tool_calls: [{ id: "a", type: "function", function: { name: "x", arguments: "{}" } }, { id: "b", type: "function", function: { name: "y", arguments: "{}" } }] },
	{ role: "tool", tool_call_id: "a", content: "result a" },
	{ role: "tool", tool_call_id: "b", content: "result b" },
];

describe("notas anexadas ao resultado da tool (sem system no meio do run)", () => {
	it("anexa ao último resultado do lote atual; com o lote fechado por fala do assistente, não anexa", () => {
		const conversation = batch();
		expect(appendToLatestToolResult(conversation, "Change approach.")).toBe(true);
		expect(conversation[4]!.content).toBe(`result b${TOOL_RESULT_NOTE_MARKER}Change approach.`);
		expect(conversation[3]!.content).toBe("result a");
		expect(conversation.filter((message) => message.role === "system")).toHaveLength(1);
		conversation.push({ role: "assistant", content: "done" });
		expect(appendToLatestToolResult(conversation, "late")).toBe(false);
	});

	it("mensagem do usuário durante a tarefa depois do lote não impede a nota (e continua sendo do usuário)", () => {
		const conversation = [...batch(), { role: "user" as const, content: "[User message during the task]\nmuda a cor" }];
		expect(appendToLatestToolResult(conversation, "note")).toBe(true);
		expect(conversation.at(-1)).toEqual({ role: "user", content: "[User message during the task]\nmuda a cor" });
	});

	it("conteúdo em partes ganha uma parte de texto; corpo e notas se separam", () => {
		const conversation: LlmMessage[] = [...batch().slice(0, 3), { role: "tool", tool_call_id: "a", content: [{ type: "text", text: "img" }] }];
		appendToLatestToolResult(conversation, "note");
		expect(conversation[3]!.content).toEqual([{ type: "text", text: "img" }, { type: "text", text: "[Runtime note] note" }]);
		expect(splitToolResultNotes(`body${TOOL_RESULT_NOTE_MARKER}n1`)).toEqual({ body: "body", notes: `${TOOL_RESULT_NOTE_MARKER}n1` });
		expect(conversationHasNote(conversation, "note")).toBe(true);
	});

	it("no máximo um aviso por passo, o mais importante primeiro; repetido não volta", () => {
		const notices = createStepNotices();
		notices.push("loop warning", 1);
		notices.push("wrap up now", 3);
		notices.push("loop warning", 1);
		const conversation = batch();
		expect(notices.flush(conversation)).toBe("wrap up now");
		expect(notices.pending()).toBe(1);
		// Mesmo passo: o segundo espera o próximo lote.
		expect(String(conversation[4]!.content).split(TOOL_RESULT_NOTE_MARKER)).toHaveLength(2);
		conversation.push({ role: "assistant", content: null, tool_calls: [{ id: "c", type: "function", function: { name: "x", arguments: "{}" } }] }, { role: "tool", tool_call_id: "c", content: "result c" });
		expect(notices.flush(conversation)).toBe("loop warning");
		notices.push("wrap up now", 3, { once: true });
		expect(notices.flush(conversation)).toBeNull();
		// Sem `once`, o mesmo aviso pode voltar num passo seguinte (ex.: replanejar de novo).
		conversation.push({ role: "assistant", content: null, tool_calls: [{ id: "d", type: "function", function: { name: "x", arguments: "{}" } }] }, { role: "tool", tool_call_id: "d", content: "result d" });
		notices.push("loop warning", 1);
		expect(notices.flush(conversation)).toBe("loop warning");
	});
});

describe("lições e guias anexados ao resultado não se repetem numa retomada", () => {
	it("seed reconhece a nota de lição anexada a um resultado de tool", async () => {
		const { createLessonInjector } = await import("../lessons.js");
		const lesson = { id: "cmconn0001", scope: "connector" as const, scopeKey: "mcp:c1", content: "Listar pedidos com filtro de data funciona melhor.", helpful: 0, harmful: 0, uses: 0 };
		const first = createLessonInjector([lesson as never]);
		const [note] = first.notesFor([{ key: "mcp:c1", label: "ERP" }]);
		expect(note?.note).toContain("facts to weigh, not orders");
		const conversation = batch();
		appendToLatestToolResult(conversation, note!.note);
		const resumed = createLessonInjector([lesson as never]);
		resumed.seed(conversation);
		expect(resumed.notesFor([{ key: "mcp:c1", label: "ERP" }])).toEqual([]);
	});
});
