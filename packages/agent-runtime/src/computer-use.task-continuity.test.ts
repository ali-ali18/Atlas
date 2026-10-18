import { describe, expect, it, vi } from "vitest";
import type { SandboxManager } from "@workspace/sandbox";
import type { CompleteChatWithToolsResult, LlmMessage } from "@workspace/llm";
import { buildConversationTaskNote, foldAutomatedMessages, selectCompactTail } from "@workspace/shared";
import { insertBeforeLastUser } from "./conversation-artifacts-note.js";
import { runComputerUse } from "./computer-use.js";

vi.mock("@workspace/db", async (original) => ({
	...(await original<typeof import("@workspace/db")>()),
	searchMemoryEntries: vi.fn(async () => []),
	getBotProfile: vi.fn(async () => null),
	listBotSkills: vi.fn(async () => []),
	searchSkillVersions: vi.fn(async () => []),
	listRoutines: vi.fn(async () => []),
	persistConversationCardFromEvent: vi.fn(async () => undefined),
}));

/**
 * Replay do bug #80 com LLM mockado: tarefa de planilha -> conversa compactada
 * (resumo só com pendências de rotina + cauda de 6 mensagens) -> rotina entrega
 * sua saída -> "tente dnv". O "modelo" só enxerga o que o worker monta: ele
 * continua a planilha se (e somente se) a tarefa ativa chegou no prompt.
 */
const SHEET_ID = "1z_RqTZgSPpSvjOvAWxwrAlmRrMZskL65G1q0105U2Q0";

const taskNote = buildConversationTaskNote({
	tasks: [
		{ objective: "os graficos e estilizar ela", status: "budget_exhausted" },
		{ objective: "Faz ela com filtros e graficos e afins", status: "completed" },
	],
	effects: [{ tool: "mcp__google_sheets__create_spreadsheet", summary: `Planilha criada: Monitor\nspreadsheetId: ${SHEET_ID}` }],
})!;

const fullHistory = [
	{ role: "user" as const, content: "veja o preço do mac" },
	{ role: "assistant" as const, content: "O melhor preço é R$ 17.499." },
	{ role: "user" as const, content: "Faz ela com filtros e graficos e afins" },
	{ role: "assistant" as const, content: "Vou ajustar a planilha." },
	{ role: "user" as const, content: "os graficos e estilizar ela" },
	{ role: "assistant" as const, content: "Não consegui terminar." },
	{ role: "assistant" as const, content: "Resumo das 20h: 25 e-mails", origin: "routine" },
	{ role: "assistant" as const, content: "Agenda da semana", origin: "routine" },
];

/** Um "modelo" que continua a tarefa do usuário a partir do que está no prompt. */
function scriptedModel(requests: LlmMessage[][]) {
	return async (params: { messages: LlmMessage[] }): Promise<CompleteChatWithToolsResult> => {
		requests.push(JSON.parse(JSON.stringify(params.messages)) as LlmMessage[]);
		const system = params.messages.filter((m) => m.role === "system").map((m) => String(m.content)).join("\n");
		const task = /1\. "([^"]+)"/.exec(system)?.[1];
		const sheet = /spreadsheetId: (\S+)/.exec(system)?.[1];
		return {
			model: "m",
			message: { role: "assistant", content: task && sheet ? `Continuing "${task}" on spreadsheet ${sheet}.` : "I do not know what to retry." },
			finishReason: "stop",
		};
	};
}

async function replay(messages: Array<{ role: "system" | "user" | "assistant"; content: string }>) {
	const requests: LlmMessage[][] = [];
	const result = await runComputerUse({
		manager: {} as SandboxManager,
		getSessionId: async () => "unused",
		sandboxEnabled: false,
		apiKey: "test",
		model: "m",
		runId: "run-continuity",
		userId: "user-a",
		origin: "chat",
		messages,
		onEvent: () => undefined,
		streamChat: scriptedModel(requests),
	});
	return { result, requests };
}

describe("bug #80: continuidade da tarefa depois da compactação", () => {
	it("conversa compactada + saída de rotina + 'tente dnv': continua a planilha do usuário", async () => {
		// Ciclo limpo: resumo defasado (só pendências de rotina) + cauda mínima do histórico.
		const tail = foldAutomatedMessages(selectCompactTail(fullHistory, 6)).map(({ role, content }) => ({ role, content }));
		const summary = { role: "system" as const, content: "CONVERSATION SUMMARY: pendings: email sweep, bills." };
		const withNote = insertBeforeLastUser([summary, ...tail, { role: "user", content: "tente dnv" }], { role: "system", content: taskNote });

		const { result, requests } = await replay(withNote);

		expect(result.text).toBe(`Continuing "os graficos e estilizar ela" on spreadsheet ${SHEET_ID}.`);
		// A saída da rotina chega rotulada como automatizada, nunca como pedido do usuário.
		const sent = requests[0]!.map((m) => String(m.content));
		expect(sent.some((text) => text.startsWith("[Automated run - not a user request]") && text.includes("25 e-mails"))).toBe(true);
		expect(requests[0]!.filter((m) => m.role === "user").map((m) => String(m.content)).at(-1)).toBe("tente dnv");
	});

	it("sem a tarefa ativa o modelo não tem de onde continuar (o que quebrava)", async () => {
		const tail = foldAutomatedMessages(selectCompactTail(fullHistory, 2)).map(({ role, content }) => ({ role, content }));
		const { result } = await replay([...tail, { role: "user", content: "tente dnv" }]);
		expect(result.text).toBe("I do not know what to retry.");
	});
});
