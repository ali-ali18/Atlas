import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CompleteChatWithToolsResult } from "@workspace/llm";
import type { SandboxManager } from "@workspace/sandbox";
import {
	createRoutine,
	deleteRoutineGroup,
	findOrCreateRoutineGroup,
	listRoutineGroups,
	listRoutines,
	setRoutineGroupEnabled,
	updateRoutine,
	updateRoutineGroup,
} from "@workspace/db";
import { runComputerUse } from "./computer-use.js";

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
		findOrCreateRoutineGroup: vi.fn(),
		listRoutineGroups: vi.fn(async () => []),
		setRoutineGroupEnabled: vi.fn(),
		deleteRoutineGroup: vi.fn(),
		updateRoutineGroup: vi.fn(),
	};
});

vi.mock("./github/hook-sync.js", () => ({
	ensureGithubRepoHook: vi.fn(async () => ({ ok: true })),
}));

function toolCall(id: string, name: string, args: Record<string, unknown>): CompleteChatWithToolsResult {
	return {
		model: "test-model",
		message: {
			role: "assistant",
			content: null,
			tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }],
		},
	};
}

function fakeRoutine(overrides: Record<string, unknown> = {}) {
	return {
		id: "routine-1",
		userId: "user-real",
		botId: "bot-1",
		conversationId: null,
		groupId: null,
		group: null,
		name: "Relatório de vendas",
		prompt: "Monte o relatório.",
		model: "",
		enabled: true,
		triggerType: "cron" as const,
		schedule: "0 9 * * *",
		timezone: "America/Sao_Paulo",
		lastRunAt: null,
		createdAt: new Date(0).toISOString(),
		updatedAt: new Date(0).toISOString(),
		...overrides,
	};
}

const group = { id: "g1", botId: "bot-1", name: "Vendas", description: "", createdAt: "", updatedAt: "", routineCount: 2, enabledCount: 2 };

async function run(calls: CompleteChatWithToolsResult[]) {
	const toolResults: Array<{ name: string; ok: boolean; summary: string }> = [];
	const queue = [...calls, { model: "test-model", message: { role: "assistant" as const, content: "ok" } }];
	await runComputerUse({
		manager: {} as unknown as SandboxManager,
		getSessionId: async () => "session-groups",
		model: "test-model",
		apiKey: "test",
		messages: [{ role: "user", content: "organiza minhas rotinas" }],
		runId: "run-groups",
		conversationId: "conv-groups",
		botId: "bot-1",
		userId: "user-real",
		maxSteps: 6,
		onEvent: (event) => {
			if (event.type === "tool_result") toolResults.push(event);
		},
		streamChat: async () => {
			const next = queue.shift();
			if (!next) throw new Error("LLM extra");
			return next;
		},
	});
	return { toolResults };
}

describe("grupos de rotinas nas tools do bot", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(listRoutines).mockResolvedValue([]);
		vi.mocked(listRoutineGroups).mockResolvedValue([]);
	});

	it("create com group reaproveita/cria o grupo e passa o groupId ao createRoutine", async () => {
		vi.mocked(findOrCreateRoutineGroup).mockResolvedValueOnce({ group, created: true } as never);
		vi.mocked(createRoutine).mockResolvedValueOnce({ routine: fakeRoutine({ groupId: "g1" }) } as never);
		const { toolResults } = await run([
			toolCall("c1", "propose_routine", {
				action: "create",
				title: "Relatório de vendas",
				detail: "Monte o relatório.",
				trigger_type: "cron",
				schedule: "0 9 * * *",
				group: "  Vendas ",
			}),
		]);
		expect(findOrCreateRoutineGroup).toHaveBeenCalledWith("user-real", "bot-1", "Vendas");
		expect(createRoutine).toHaveBeenCalledWith("user-real", expect.objectContaining({ groupId: "g1" }));
		expect(toolResults[0]?.ok).toBe(true);
	});

	it("create sem group não toca em grupos", async () => {
		vi.mocked(createRoutine).mockResolvedValueOnce({ routine: fakeRoutine() } as never);
		await run([
			toolCall("c1", "propose_routine", {
				action: "create",
				title: "Relatório de vendas",
				detail: "Monte o relatório.",
				trigger_type: "cron",
				schedule: "0 9 * * *",
			}),
		]);
		expect(findOrCreateRoutineGroup).not.toHaveBeenCalled();
		expect(vi.mocked(createRoutine).mock.calls[0]?.[1]).not.toHaveProperty("groupId");
	});

	it("edit com group vazio tira a rotina do grupo", async () => {
		vi.mocked(listRoutines).mockResolvedValue([fakeRoutine({ groupId: "g1", group: { id: "g1", name: "Vendas" } })] as never);
		vi.mocked(updateRoutine).mockResolvedValue(fakeRoutine() as never);
		await run([
			toolCall("c1", "propose_routine", {
				action: "edit",
				target: "routine-1",
				detail: "Monte o relatório.",
				trigger_type: "cron",
				group: "",
			}),
		]);
		expect(updateRoutine).toHaveBeenCalledWith("user-real", "bot-1", "routine-1", { groupId: null });
	});

	it("list_routines mostra o nome do grupo", async () => {
		vi.mocked(listRoutines).mockResolvedValue([fakeRoutine({ groupId: "g1", group: { id: "g1", name: "Vendas" } })] as never);
		const { toolResults } = await run([toolCall("c1", "list_routines", {})]);
		expect(toolResults[0]?.summary).toContain("[grupo: Vendas]");
	});

	it("routine_group pause pausa todas as rotinas do grupo (nome sem caixa)", async () => {
		vi.mocked(listRoutineGroups).mockResolvedValue([group] as never);
		vi.mocked(setRoutineGroupEnabled).mockResolvedValueOnce([fakeRoutine({ enabled: false })] as never);
		const { toolResults } = await run([toolCall("c1", "routine_group", { action: "pause", group: " vendas " })]);
		expect(setRoutineGroupEnabled).toHaveBeenCalledWith("user-real", "bot-1", "g1", false);
		expect(toolResults[0]?.ok).toBe(true);
		expect(toolResults[0]?.summary).toContain("pausadas");
	});

	it("routine_group rename muda o nome do grupo do dono; sem new_name ou nome repetido dá erro honesto", async () => {
		vi.mocked(listRoutineGroups).mockResolvedValue([group] as never);
		vi.mocked(updateRoutineGroup).mockResolvedValueOnce({ ...group, name: "Vendas Loja Exemplo" } as never);
		vi.mocked(updateRoutineGroup).mockRejectedValueOnce(new Error("Já existe um grupo com esse nome"));
		const { toolResults } = await run([
			toolCall("c1", "routine_group", { action: "rename", group: "vendas", new_name: " Vendas   Loja Exemplo " }),
			toolCall("c2", "routine_group", { action: "rename", group: "g1" }),
			toolCall("c3", "routine_group", { action: "rename", group: "g1", new_name: "Outro" }),
		]);
		expect(updateRoutineGroup).toHaveBeenNthCalledWith(1, "user-real", "bot-1", "g1", { name: "Vendas Loja Exemplo" });
		expect(toolResults.map((r) => r.ok)).toEqual([true, false, false]);
		expect(toolResults[0]?.summary).toContain('renomeado para "Vendas Loja Exemplo"');
		expect(toolResults[1]?.summary).toContain("new_name");
		expect(toolResults[2]?.summary).toContain("Já existe um grupo");
	});

	it("routine_group delete só desfaz o grupo: as rotinas ficam", async () => {
		vi.mocked(listRoutineGroups).mockResolvedValue([group] as never);
		vi.mocked(deleteRoutineGroup).mockResolvedValueOnce({ routines: [fakeRoutine()], deletedRoutines: false } as never);
		const { toolResults } = await run([toolCall("c1", "routine_group", { action: "delete", group: "g1" })]);
		expect(deleteRoutineGroup).toHaveBeenCalledWith("user-real", "bot-1", "g1");
		expect(toolResults[0]?.summary).toContain("continuam");
	});

	it("routine_group com grupo inexistente não altera nada", async () => {
		const { toolResults } = await run([toolCall("c1", "routine_group", { action: "pause", group: "nada" })]);
		expect(setRoutineGroupEnabled).not.toHaveBeenCalled();
		expect(toolResults[0]?.summary).toContain("Não achei grupo");
	});
});
