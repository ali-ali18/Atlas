import { describe, expect, it, vi } from "vitest";
import type { SandboxManager } from "@workspace/sandbox";
import type { CompleteChatWithToolsResult, LlmMessage } from "@workspace/llm";
import { renderTaskListNote } from "@workspace/shared";
import { upsertTaskListCard } from "@workspace/db";
import { runComputerUse } from "./computer-use.js";
import { devTodosToTaskList, executeUpdateTaskList, shouldExposeTaskList } from "./tools/task-list.js";

vi.mock("@workspace/db", async (original) => ({
	...(await original<typeof import("@workspace/db")>()),
	searchMemoryEntries: vi.fn(async () => []),
	getBotProfile: vi.fn(async () => null),
	listBotSkills: vi.fn(async () => []),
	searchSkillVersions: vi.fn(async () => []),
	listRoutines: vi.fn(async () => []),
	persistConversationCardFromEvent: vi.fn(async () => undefined),
	upsertTaskListCard: vi.fn(async () => undefined),
}));

let callSeq = 0;
const toolCall = (name: string, args: unknown): CompleteChatWithToolsResult => ({
	model: "m",
	message: { role: "assistant", content: null, tool_calls: [{ id: `t${++callSeq}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] },
	finishReason: "tool_calls",
});
const say = (text: string): CompleteChatWithToolsResult => ({ model: "m", message: { role: "assistant", content: text }, finishReason: "stop" });

const LIST = [
	{ content: "Ler o relatorio", status: "completed" },
	{ content: "Montar a planilha", status: "in_progress" },
	{ content: "Enviar o resumo", status: "pending" },
];

async function run(input: { calls: CompleteChatWithToolsResult[]; origin?: string; priorTaskList?: unknown }) {
	const requests: Array<{ messages: LlmMessage[]; tools: string[] }> = [];
	const checkpoints: Array<{ taskState?: { taskList?: unknown } }> = [];
	const events: Array<Record<string, unknown>> = [];
	const queue = [...input.calls];
	await runComputerUse({
		manager: {} as SandboxManager,
		getSessionId: async () => "unused",
		sandboxEnabled: false,
		apiKey: "test",
		model: "m",
		runId: "run-tl",
		userId: "user-a",
		conversationId: "conv-tl",
		origin: input.origin ?? "chat",
		priorTaskList: input.priorTaskList,
		messages: [{ role: "user", content: "faca o relatorio completo" }],
		onEvent: (event) => { events.push(event as never); },
		onCheckpoint: async (checkpoint) => { checkpoints.push(checkpoint as never); },
		streamChat: async (params) => {
			requests.push({ messages: JSON.parse(JSON.stringify(params.messages)), tools: params.tools.map((tool) => tool.function.name) });
			const next = queue.shift();
			if (!next) throw new Error("LLM extra");
			return next;
		},
	});
	const systemTexts = (index: number) => requests[index]!.messages.filter((m) => m.role === "system").map((m) => String(m.content));
	return { requests, checkpoints, events, systemTexts };
}

describe("update_task_list: validacao", () => {
	const store = () => {
		let current: unknown;
		return { get: () => current as never, set: (next: unknown) => { current = next; }, read: () => current };
	};

	it("substitui a lista inteira e normaliza o texto", () => {
		const s = store();
		const out = executeUpdateTaskList({ items: [{ content: "  a   b ", status: "pending" }, { content: "c", status: "in_progress" }] }, { taskListStore: s });
		expect(out.summary).toContain("0/2");
		expect(s.read()).toEqual([{ content: "a b", status: "pending" }, { content: "c", status: "in_progress" }]);
	});

	it("rejeita mais de um in_progress, status invalido, conteudo vazio e lista grande", () => {
		const s = store();
		const call = (items: unknown) => () => executeUpdateTaskList({ items }, { taskListStore: s });
		expect(call([{ content: "a", status: "in_progress" }, { content: "b", status: "in_progress" }])).toThrow(/At most one/);
		expect(call([{ content: "a", status: "feito" }])).toThrow(/status/);
		expect(call([{ content: " ", status: "pending" }])).toThrow(/content/);
		expect(call(Array.from({ length: 21 }, (_, i) => ({ content: `p${i}`, status: "pending" })))).toThrow(/max 20/);
		expect(call("x")).toThrow(/list/);
		expect(s.read()).toBeUndefined();
	});

	it("tudo concluido ou lista vazia encerra a lista", () => {
		const s = store();
		executeUpdateTaskList({ items: [{ content: "a", status: "pending" }] }, { taskListStore: s });
		const done = executeUpdateTaskList({ items: [{ content: "a", status: "completed" }] }, { taskListStore: s });
		expect(done.summary).toContain("closed");
		expect(s.read()).toBeUndefined();
		executeUpdateTaskList({ items: [{ content: "a", status: "pending" }] }, { taskListStore: s });
		executeUpdateTaskList({ items: [] }, { taskListStore: s });
		expect(s.read()).toBeUndefined();
	});

	it("a nota some quando tudo esta concluido", () => {
		expect(renderTaskListNote(undefined)).toBeNull();
		expect(renderTaskListNote([{ content: "a", status: "completed" }])).toBeNull();
		expect(renderTaskListNote([{ content: "a", status: "pending" }])).toContain("1. [ ] a");
	});
});

describe("update_task_list no loop", () => {
	it("e tool do nucleo no chat, nao em rotina", async () => {
		const chat = await run({ calls: [say("ok")] });
		expect(chat.requests[0]!.tools).toContain("update_task_list");
		const routine = await run({ calls: [say("ok")], origin: "routine" });
		expect(routine.requests[0]!.tools).not.toContain("update_task_list");
	});

	it("fica por origem: chat e bot atendendo outro bot (com humano na conversa) recebem; rotina, webhook, proativo e subagente não", async () => {
		for (const origin of ["chat", "bot"]) {
			expect((await run({ calls: [say("ok")], origin })).requests[0]!.tools, origin).toContain("update_task_list");
		}
		for (const origin of ["routine", "webhook", "proactive", "subagent"]) {
			expect((await run({ calls: [say("ok")], origin })).requests[0]!.tools, origin).not.toContain("update_task_list");
		}
	});

	it("bot atendendo outro bot persiste o cartão na conversa dele e emite o evento da doca", async () => {
		const { events } = await run({ origin: "bot", calls: [toolCall("update_task_list", { items: LIST }), say("feito")] });
		expect(events.filter((e) => e.type === "task_list")).toHaveLength(1);
		expect(upsertTaskListCard).toHaveBeenLastCalledWith("conv-tl", "run-tl", LIST);
	});

	it("salva no checkpoint e reinjeta a nota no passo seguinte", async () => {
		const { requests, checkpoints, systemTexts } = await run({ calls: [toolCall("update_task_list", { items: LIST }), say("feito")] });
		expect(systemTexts(0).some((t) => t.includes("Current task list"))).toBe(false);
		expect(systemTexts(1).some((t) => t.includes("2. [>] Montar a planilha"))).toBe(true);
		expect(requests).toHaveLength(2);
		expect(checkpoints.at(-1)?.taskState?.taskList).toEqual(LIST);
	});

	it("o run seguinte da conversa herda a lista e a nota aparece desde o primeiro passo", async () => {
		const { systemTexts, checkpoints } = await run({ calls: [say("continuando")], priorTaskList: LIST });
		expect(systemTexts(0).some((t) => t.includes("3. [ ] Enviar o resumo"))).toBe(true);
		expect(checkpoints.at(-1)?.taskState?.taskList).toEqual(LIST);
	});

	it("lista concluida limpa o checkpoint e a nota", async () => {
		const done = LIST.map((item) => ({ ...item, status: "completed" }));
		const { systemTexts, checkpoints } = await run({ calls: [toolCall("update_task_list", { items: done }), say("pronto")], priorTaskList: LIST });
		expect(systemTexts(1).some((t) => t.includes("Current task list"))).toBe(false);
		expect(checkpoints.at(-1)?.taskState?.taskList).toBeUndefined();
	});

	it("emite o evento task_list e grava o cartao do run a cada atualizacao", async () => {
		const done = LIST.map((item) => ({ ...item, status: "completed" }));
		const { events } = await run({ calls: [toolCall("update_task_list", { items: LIST }), toolCall("update_task_list", { items: done }), say("pronto")] });
		const emitted = events.filter((e) => e.type === "task_list") as Array<{ items: unknown; runId?: string }>;
		expect(emitted).toHaveLength(2);
		expect(emitted[0]).toMatchObject({ items: LIST, runId: "run-tl" });
		expect(emitted[1]!.items).toEqual(done);
		expect(upsertTaskListCard).toHaveBeenLastCalledWith("conv-tl", "run-tl", done);
	});

	it("entrada invalida volta como erro da tool sem alterar a lista", async () => {
		const bad = [{ content: "a", status: "in_progress" }, { content: "b", status: "in_progress" }];
		const { events, checkpoints } = await run({ calls: [toolCall("update_task_list", { items: bad }), say("ok")], priorTaskList: LIST });
		const result = events.find((e) => e.type === "tool_result" && e.name === "update_task_list") as { ok?: boolean } | undefined;
		expect(result?.ok).toBe(false);
		expect(events.some((e) => e.type === "task_list")).toBe(false);
		expect(checkpoints.at(-1)?.taskState?.taskList).toEqual(LIST);
	});
});

describe("quem recebe a lista (função pura)", () => {
	it("só o agente principal em chat ou bot", () => {
		expect(shouldExposeTaskList({ origin: "chat", isSubagent: false })).toBe(true);
		expect(shouldExposeTaskList({ origin: "bot", isSubagent: false })).toBe(true);
		expect(shouldExposeTaskList({ origin: "bot", isSubagent: true })).toBe(false);
		for (const origin of ["routine", "webhook", "proactive", "subagent", "email", undefined]) {
			expect(shouldExposeTaskList({ origin, isSubagent: false })).toBe(false);
		}
	});
});

describe("todo_write da sessão de código alimenta a mesma lista", () => {
	it("converte: cancelados saem e só um item fica em andamento", () => {
		expect(
			devTodosToTaskList([
				{ content: "a", status: "completed" },
				{ content: "b", status: "in_progress" },
				{ content: "c", status: "in_progress" },
				{ content: "d", status: "cancelled" },
				{ content: "e", status: "pending" },
			]),
		).toEqual([
			{ content: "a", status: "completed" },
			{ content: "b", status: "in_progress" },
			{ content: "c", status: "pending" },
			{ content: "e", status: "pending" },
		]);
		expect(devTodosToTaskList([])).toEqual([]);
	});
});

describe("todo_write dentro do run de chat", () => {
	it("a lista do todo_write chega à doca (evento task_list + cartão) e fica no estado do run", async () => {
		const updates: unknown[] = [];
		const session = { id: "sess-1", todos: [] as unknown[], status: "ready", tier: "small", containerId: "c1" };
		const events: Array<Record<string, unknown>> = [];
		const queue = [
			toolCall("todo_write", { items: [
				{ id: "1", content: "Ler o codigo", status: "completed" },
				{ id: "2", content: "Corrigir o teste", status: "in_progress" },
				{ id: "3", content: "Descartado", status: "cancelled" },
			] }),
			say("feito"),
		];
		await runComputerUse({
			manager: {} as SandboxManager,
			getSessionId: async () => "unused",
			sandboxEnabled: false,
			apiKey: "test",
			model: "m",
			runId: "run-dev-tl",
			userId: "user-a",
			conversationId: "conv-dev",
			origin: "chat",
			messages: [{ role: "user", content: "corrige o teste que esta falhando no repo" }],
			devSession: {
				config: { enabled: true },
				store: { findForConversation: async () => session, get: async () => session, update: async (_id: string, patch: unknown) => { updates.push(patch); } },
				provider: {},
				getGithubToken: async () => ({ ok: false }),
			} as never,
			onEvent: (event) => { events.push(event as never); },
			streamChat: async () => queue.shift() ?? say("fim"),
		});
		const todoEvent = events.find((e) => e.type === "todo_updated");
		expect(todoEvent).toBeDefined();
		const lists = events.filter((e) => e.type === "task_list") as Array<{ items: unknown; runId?: string }>;
		expect(lists).toHaveLength(1);
		expect(lists[0]).toMatchObject({ runId: "run-dev-tl", items: [{ content: "Ler o codigo", status: "completed" }, { content: "Corrigir o teste", status: "in_progress" }] });
		expect(upsertTaskListCard).toHaveBeenLastCalledWith("conv-dev", "run-dev-tl", lists[0]!.items);
	});
});
