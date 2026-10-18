import { describe, expect, it } from "vitest";
import {
	AUTOMATED_OUTPUT_LABEL,
	CARD_PROTOCOL_NOTE,
	labelCardProtocolMessage,
	buildConversationTaskNote,
	foldAutomatedMessages,
	isAutomatedOrigin,
	isCardConfirmToken,
} from "./conversation-task.js";
import { buildSummaryPrompt } from "./summary.js";

describe("isAutomatedOrigin", () => {
	it("só rotina e webhook são automatizados", () => {
		expect(isAutomatedOrigin("routine")).toBe(true);
		expect(isAutomatedOrigin("webhook")).toBe(true);
		expect(isAutomatedOrigin("chat")).toBe(false);
		expect(isAutomatedOrigin(null)).toBe(false);
		expect(isAutomatedOrigin(undefined)).toBe(false);
	});
});

describe("isCardConfirmToken", () => {
	it("reconhece o aval da UI e não uma tarefa", () => {
		expect(isCardConfirmToken('confirmado: Google Planilhas: executar "update_range"?')).toBe(true);
		expect(isCardConfirmToken("confirmado sempre: x")).toBe(true);
		expect(isCardConfirmToken("os graficos e estilizar ela")).toBe(false);
	});
});

describe("foldAutomatedMessages", () => {
	it("agrupa saída automatizada consecutiva sob um rótulo e preserva o resto", () => {
		const out = foldAutomatedMessages([
			{ role: "user", content: "u1" },
			{ role: "assistant", content: "a1" },
			{ role: "assistant", content: "r1", origin: "routine" },
			{ role: "assistant", content: "r2", origin: "routine" },
			{ role: "user", content: "u2" },
		]);
		expect(out.map((m) => m.role)).toEqual(["user", "assistant", "assistant", "user"]);
		expect(out[2]!.content).toBe(`${AUTOMATED_OUTPUT_LABEL}\nr1\n\nr2`);
		expect(out[1]!.content).toBe("a1");
	});

	it("saída automatizada separada por fala do usuário vira dois grupos", () => {
		const out = foldAutomatedMessages([
			{ role: "assistant", content: "r1", origin: "routine" },
			{ role: "user", content: "u" },
			{ role: "assistant", content: "r2", origin: "routine" },
		]);
		expect(out.filter((m) => m.content.startsWith(AUTOMATED_OUTPUT_LABEL))).toHaveLength(2);
	});

	it("vazio devolve vazio", () => {
		expect(foldAutomatedMessages([])).toEqual([]);
	});
});

describe("buildConversationTaskNote", () => {
	const context = {
		tasks: [
			{ objective: "os graficos e estilizar ela", status: "completed", outcome: "stopped early" },
			{ objective: "Faz ele em tabela", status: "budget_exhausted" },
			{ objective: "t3", status: "completed" },
			{ objective: "t4 fora do teto", status: "completed" },
		],
		effects: [{ tool: "create_spreadsheet", summary: "spreadsheetId: ABC123\nlink: https://example.test/ABC123" }],
	};

	it("lista as tarefas do usuário (mais recente primeiro) e os recursos com id", () => {
		const note = buildConversationTaskNote(context)!;
		expect(note).toContain('1. "os graficos e estilizar ela"');
		expect(note).toContain('2. "Faz ele em tabela" (did not finish)');
		expect(note).not.toContain("t4 fora do teto");
		expect(note).toContain("create_spreadsheet: spreadsheetId: ABC123 link: https://example.test/ABC123");
		expect(note).toContain("never to scheduled-run or webhook output");
	});

	it("sem tarefa não há nota", () => {
		expect(buildConversationTaskNote(null)).toBeNull();
		expect(buildConversationTaskNote({ tasks: [], effects: [] })).toBeNull();
		expect(buildConversationTaskNote({ tasks: [{ objective: "  ", status: "completed" }], effects: [] })).toBeNull();
	});
});

describe("buildSummaryPrompt (bug #80)", () => {
	it("pede a tarefa aberta no topo e trata linhas AUTOMATED como não-usuário", () => {
		const prompt = buildSummaryPrompt(["USUÁRIO: gráficos na planilha", "AUTOMATED: resumo das 7h"]);
		expect(prompt).toContain("Open the prose with the user's current open task");
		expect(prompt).toContain("Lines marked AUTOMATED");
		expect(prompt).not.toContain("Current user task recorded by the system");
	});

	it("inclui a tarefa ativa do banco quando existe", () => {
		const prompt = buildSummaryPrompt(["USUÁRIO: oi"], null, { activeTask: "spreadsheetId: ABC123" });
		expect(prompt).toContain("Current user task recorded by the system");
		expect(prompt).toContain("spreadsheetId: ABC123");
	});
});

describe("protocolo do cartão no histórico do modelo", () => {
	it("clique de cartão ganha a nota; fala normal passa intacta", () => {
		const out = foldAutomatedMessages([
			{ role: "user", content: "confirmado: Executar este comando?" },
			{ role: "user", content: "cancela isso" },
			{ role: "user", content: "recusado: usa pnpm" },
			{ role: "user", content: "pode confirmar o pedido do cliente?" },
			{ role: "assistant", content: "confirmado: x" },
		]);
		expect(out[0]!.content).toContain(CARD_PROTOCOL_NOTE);
		expect(out[0]!.content.startsWith("confirmado: Executar")).toBe(true);
		expect(out[1]!.content).toContain(CARD_PROTOCOL_NOTE);
		expect(out[2]!.content).toContain(CARD_PROTOCOL_NOTE);
		expect(out[3]!.content).toBe("pode confirmar o pedido do cliente?");
		expect(out[4]!.content).toBe("confirmado: x");
	});

	it("não duplica a nota", () => {
		const once = labelCardProtocolMessage("confirmado: x");
		expect(labelCardProtocolMessage(once)).toBe(once);
	});
});
