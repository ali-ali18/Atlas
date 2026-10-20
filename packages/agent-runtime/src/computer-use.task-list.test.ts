import { describe, expect, it, vi } from "vitest";
import type { SandboxManager } from "@workspace/sandbox";
import type { CompleteChatWithToolsResult, LlmMessage } from "@workspace/llm";
import { renderTaskListNote } from "@workspace/shared";
import { runComputerUse } from "./computer-use.js";
import { executeUpdateTaskList } from "./tools/task-list.js";

vi.mock("@workspace/db", async (original) => ({
	...(await original<typeof import("@workspace/db")>()),
	searchMemoryEntries: vi.fn(async () => []),
	getBotProfile: vi.fn(async () => null),
	listBotSkills: vi.fn(async () => []),
	searchSkillVersions: vi.fn(async () => []),
	listRoutines: vi.fn(async () => []),
	persistConversationCardFromEvent: vi.fn(async () => undefined),
}));

const toolCall = (name: string, args: unknown): CompleteChatWithToolsResult => ({
	model: "m",
	message: { role: "assistant", content: null, tool_calls: [{ id: "t1", type: "function", function: { name, arguments: JSON.stringify(args) } }] },
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

	it("entrada invalida volta como erro da tool sem alterar a lista", async () => {
		const bad = [{ content: "a", status: "in_progress" }, { content: "b", status: "in_progress" }];
		const { events, checkpoints } = await run({ calls: [toolCall("update_task_list", { items: bad }), say("ok")], priorTaskList: LIST });
		const result = events.find((e) => e.type === "tool_result" && e.name === "update_task_list") as { ok?: boolean } | undefined;
		expect(result?.ok).toBe(false);
		expect(checkpoints.at(-1)?.taskState?.taskList).toEqual(LIST);
	});
});
