import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CompleteChatWithToolsResult } from "@workspace/llm";
import type { SandboxManager } from "@workspace/sandbox";
import { createRoutine, listRoutines, updateRoutine } from "@workspace/db";
import { runComputerUse } from "./computer-use.js";
import { PAGE_TOOLS, type PagesStore } from "./tools/pages.js";

/** propose_routine com page_id: a rotina atualiza uma página do mesmo bot no lugar; página alheia nunca liga. */

vi.mock("@workspace/db", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@workspace/db")>();
	return {
		...actual,
		getBotProfile: vi.fn(async () => null),
		listBotSkills: vi.fn(async () => []),
		searchSkillVersions: vi.fn(async () => []),
		persistConversationCardFromEvent: vi.fn(async () => undefined),
		listRoutines: vi.fn(async () => []),
		createRoutine: vi.fn(),
		updateRoutine: vi.fn(),
		deleteRoutine: vi.fn(async () => true),
	};
});

const toolCall = (id: string, name: string, args: Record<string, unknown>): CompleteChatWithToolsResult => ({
	model: "test-model",
	message: { role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }] },
});

function pageRow(id: string, userId: string, botId: string) {
	return { id, userId, botId };
}

/** Só a leitura importa aqui; a regra de dono é a do db (outro usuário = não existe). */
function store(rows: Array<{ id: string; userId: string; botId: string }>): PagesStore {
	return {
		get: async (id, userId) => (rows.find((row) => row.id === id && row.userId === userId) ?? null) as never,
		create: async () => null,
		list: async () => [],
		update: async () => ({ ok: false, error: "not_found" }),
	};
}

function cronRoutine(pageId: string | null) {
	return {
		id: "routine-1", userId: "user-1", botId: "bot-1", conversationId: null, name: "Painel semanal", prompt: "Rebuild the page.", model: "", enabled: true,
		triggerType: "cron" as const, schedule: "0 8 * * 1", timezone: "America/Sao_Paulo", lastRunAt: null, createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(), pageId,
	};
}

async function run(calls: CompleteChatWithToolsResult[], pages: PagesStore) {
	const toolResults: Array<{ name: string; ok: boolean; summary: string }> = [];
	const routines: Array<{ action: string; triggerType?: string }> = [];
	const queue = [...calls, { model: "test-model", message: { role: "assistant" as const, content: "ok" } }];
	await runComputerUse({
		manager: {} as unknown as SandboxManager,
		getSessionId: async () => "s",
		model: "test-model",
		apiKey: "test",
		messages: [{ role: "user", content: "atualiza o painel toda segunda às 8h" }],
		runId: "run-rp", conversationId: "conv-rp", botId: "bot-1", userId: "user-1", maxSteps: 6, pagesStore: pages,
		onEvent: (event) => {
			if (event.type === "tool_result") toolResults.push(event);
			if (event.type === "routine") routines.push(event);
		},
		streamChat: async () => {
			const next = queue.shift();
			if (!next) throw new Error("LLM extra");
			return next;
		},
	});
	return { toolResults, routines };
}

const create = { action: "create", title: "Painel semanal", detail: "Rebuild the page with fresh data.", trigger_type: "cron", schedule: "0 8 * * 1" };

describe("propose_routine com page_id", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(listRoutines).mockResolvedValue([]);
	});

	it("a descrição da tool ensina a passar page_id e o parâmetro existe", async () => {
		const { COMPUTER_USE_TOOLS } = await import("./computer-use.js");
		const tool = COMPUTER_USE_TOOLS.find((item) => item.function.name === "propose_routine")!;
		expect(tool.function.description).toMatch(/pass page_id/);
		expect(JSON.stringify(tool.function.parameters)).toContain("page_id");
		expect(PAGE_TOOLS.length).toBe(4);
	});

	it("create com page_id da página do bot liga a rotina e emite o card de criação", async () => {
		vi.mocked(createRoutine).mockResolvedValueOnce({ routine: cronRoutine("page-1") } as never);
		const { toolResults, routines } = await run([toolCall("c1", "propose_routine", { ...create, page_id: "page-1" })], store([pageRow("page-1", "user-1", "bot-1")]));
		expect(createRoutine).toHaveBeenCalledWith("user-1", expect.objectContaining({ pageId: "page-1", triggerType: "cron", schedule: "0 8 * * 1" }));
		expect(toolResults[0]?.ok).toBe(true);
		expect(routines[0]).toEqual(expect.objectContaining({ action: "created", triggerType: "cron" }));
	});

	it("sem page_id a rotina nasce sem página (nada de pageId no create)", async () => {
		vi.mocked(createRoutine).mockResolvedValueOnce({ routine: cronRoutine(null) } as never);
		await run([toolCall("c1", "propose_routine", create)], store([]));
		expect(vi.mocked(createRoutine).mock.calls[0]![1]).not.toHaveProperty("pageId");
	});

	it("page_id de outro usuário, de outro bot ou inexistente: erro acionável e nenhuma rotina criada", async () => {
		const pages = store([pageRow("page-x", "user-2", "bot-9"), pageRow("page-y", "user-1", "bot-2")]);
		for (const pageId of ["page-x", "page-y", "nao-existe"]) {
			const { toolResults } = await run([toolCall("c1", "propose_routine", { ...create, page_id: pageId })], pages);
			expect(toolResults[0]).toMatchObject({ ok: false });
			expect(toolResults[0]!.summary).toMatch(/not found for this bot\. Use page_list/);
		}
		expect(createRoutine).not.toHaveBeenCalled();
	});

	it("edit liga a página, e page_id vazio a desliga", async () => {
		vi.mocked(listRoutines).mockResolvedValue([cronRoutine(null)] as never);
		vi.mocked(updateRoutine).mockResolvedValue(cronRoutine("page-1") as never);
		await run([toolCall("c1", "propose_routine", { ...create, action: "edit", target: "Painel semanal", page_id: "page-1" })], store([pageRow("page-1", "user-1", "bot-1")]));
		expect(updateRoutine).toHaveBeenCalledWith("user-1", "bot-1", "routine-1", { pageId: "page-1" });
		vi.mocked(updateRoutine).mockClear();
		await run([toolCall("c1", "propose_routine", { ...create, action: "edit", target: "Painel semanal", page_id: "" })], store([]));
		expect(updateRoutine).toHaveBeenCalledWith("user-1", "bot-1", "routine-1", { pageId: null });
	});
});
