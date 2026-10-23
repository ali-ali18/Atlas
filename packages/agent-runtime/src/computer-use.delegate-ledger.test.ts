import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CompleteChatWithToolsParams, CompleteChatWithToolsResult, LlmToolCall } from "@workspace/llm";
import type { SandboxManager } from "@workspace/sandbox";
import type { AgentRunCheckpoint } from "@workspace/shared";
import { parseTaskState } from "@workspace/shared";
import { createSubagentRun } from "@workspace/db";
import { runComputerUse } from "./computer-use.js";
import { jevSaying } from "./jev/test-support.js";

/**
 * Replay (LLM mockado) do caso "a resposta some e é reescrita 3 vezes depois de delegar": o bot declara o
 * checklist, delega a Semana 2 a um subagente ("Bobinho") e responde. O portão de itens recusava a resposta
 * enquanto o item seguia pendente (o resultado do delegate_task só fechava item no modo navegador).
 */

vi.mock("@workspace/db", async (importOriginal) => ({
	...(await importOriginal<typeof import("@workspace/db")>()),
	getBotProfile: vi.fn(async () => ({ description: "A bot that is already configured." })),
	listBotSkills: vi.fn(async () => []),
	searchMemoryEntries: vi.fn(async () => []),
	searchSkillVersions: vi.fn(async () => []),
	listRoutines: vi.fn(async () => []),
	persistConversationCardFromEvent: vi.fn(async () => undefined),
	appendConversationCard: vi.fn(async () => undefined),
	createSubagentRun: vi.fn(),
	finishSubagentRun: vi.fn(async () => true),
	failOrphanSubagentRuns: vi.fn(async () => 0),
	appendAgentStep: vi.fn(async () => undefined),
}));

type Ev = Record<string, unknown> & { type: string };
type Message = CompleteChatWithToolsParams["messages"][number];

const call = (id: string, name: string, args: Record<string, unknown>): LlmToolCall => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });
const turn = (...calls: LlmToolCall[]): CompleteChatWithToolsResult => ({ model: "m", message: { role: "assistant", content: null, tool_calls: calls } });
const say = (content: string): CompleteChatWithToolsResult => ({ model: "m", message: { role: "assistant", content } });

const isChild = (params: CompleteChatWithToolsParams) => {
	const first = params.messages[0];
	return typeof first?.content === "string" && first.content.includes("focused sub-agent");
};

const FINAL = "Pronto, Ali: o resumo da Semana 2 está acima.";
const REPORT = "Semana 2: introdução a grafos, BFS e DFS, exercícios 1 a 5.";

async function run(input: {
	parent: (index: number, messages: Message[]) => CompleteChatWithToolsResult;
	child?: () => CompleteChatWithToolsResult;
	jev?: ReturnType<typeof jevSaying>;
	priorTaskLedger?: unknown;
	message?: string;
}) {
	const events: Ev[] = [];
	const checkpoints: AgentRunCheckpoint[] = [];
	const parentRequests: Message[][] = [];
	let error: unknown;
	let result: Awaited<ReturnType<typeof runComputerUse>> | undefined;
	try {
		result = await runComputerUse({
			manager: {} as SandboxManager,
			getSessionId: async () => {
				throw new Error("sem sandbox");
			},
			sandboxEnabled: false,
			model: "m",
			apiKey: "test",
			messages: [{ role: "user", content: input.message ?? "faz o resumo da Semana 2 da disciplina" }],
			botId: "bot-1",
			userId: "user-1",
			runId: "run-parent",
			conversationId: "conv-1",
			origin: "chat",
			contextEconomy: false,
			maxSteps: 12,
			jev: input.jev ?? jevSaying({}),
			priorTaskLedger: input.priorTaskLedger,
			onCheckpoint: async (checkpoint: AgentRunCheckpoint) => {
				checkpoints.push(JSON.parse(JSON.stringify(checkpoint)));
			},
			onEvent: (event) => {
				events.push(event as never);
			},
			streamChat: async (params, handlers) => {
				const reply = isChild(params)
					? (input.child ?? (() => say(REPORT)))()
					: (() => {
							const messages = JSON.parse(JSON.stringify(params.messages)) as Message[];
							parentRequests.push(messages);
							return input.parent(parentRequests.length - 1, messages);
						})();
				if (reply.message.content) handlers?.onDelta?.(reply.message.content);
				return { ...reply, usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } };
			},
		} as never);
	} catch (caught) {
		error = caught;
	}
	const ledger = parseTaskState(checkpoints.at(-1)?.taskState)?.ledger;
	const discards = events.filter((e) => e.type === "assistant_discard");
	return { result, error, events, ledger, discards, parentRequests };
}

const setItems = (labels: string[]) => call("set", "track_items", { action: "set", items: labels.map((label) => ({ label })) });
const delegate = (task: Record<string, unknown>) => call("dg", "delegate_task", { tasks: [{ title: "Bobinho", ...task }] });
const toolResult = (events: Ev[], name: string) => events.find((e) => e.type === "tool_result" && e.name === name) as (Ev & { ok: boolean; summary: string }) | undefined;

let childCounter = 0;
beforeEach(() => {
	vi.clearAllMocks();
	childCounter = 0;
	vi.mocked(createSubagentRun).mockImplementation(async () => ({ id: `child-${++childCounter}` }) as never);
});

describe("replay: checklist + delegate_task (cenário A)", () => {
	it("o resultado do subagente fecha o item pelo rótulo no objetivo: a resposta final sai sem descarte", async () => {
		const { result, error, ledger, discards, events } = await run({
			parent: (index) => {
				if (index === 0) return turn(setItems(["Semana 2"]));
				if (index === 1) return turn(delegate({ goal: "Escreva o resumo da Semana 2 da disciplina de Algoritmos." }));
				return say(FINAL);
			},
		});
		expect(error).toBeUndefined();
		expect(toolResult(events, "delegate_task")).toMatchObject({ ok: true });
		expect(toolResult(events, "delegate_task")!.summary).toContain("Item 1: done.");
		expect(discards).toHaveLength(0);
		expect(result?.text).toBe(FINAL);
		expect(ledger?.items[0]).toMatchObject({ status: "done" });
		expect(ledger?.items[0]!.evidence).toContain("introdução a grafos");
	});

	it("com o arg item explícito, fecha o item mesmo sem o rótulo no objetivo", async () => {
		const { result, ledger, discards } = await run({
			parent: (index) => {
				if (index === 0) return turn(setItems(["Material da aula"]));
				if (index === 1) return turn(delegate({ goal: "Resuma o conteúdo do AVA desta semana.", item: "1" }));
				return say(FINAL);
			},
		});
		expect(discards).toHaveLength(0);
		expect(result?.text).toBe(FINAL);
		expect(ledger?.items[0]).toMatchObject({ status: "done" });
	});

	it("subagente que falha: o item fecha como failed com o motivo, e a resposta honesta sai sem descarte", async () => {
		const HONEST = "Não consegui o resumo da Semana 2: o subagente falhou ao ler o material.";
		const { result, ledger, discards, events } = await run({
			child: () => {
				throw new Error("provider down");
			},
			parent: (index) => {
				if (index === 0) return turn(setItems(["Semana 2"]));
				if (index === 1) return turn(delegate({ goal: "Escreva o resumo da Semana 2." }));
				return say(HONEST);
			},
		});
		expect(toolResult(events, "delegate_task")).toMatchObject({ ok: false });
		expect(discards).toHaveLength(0);
		expect(result?.text).toBe(HONEST);
		expect(ledger?.items[0]).toMatchObject({ status: "failed", reason: "subagent" });
	});

	it("tarefa delegada sem relação com o item não o fecha (nunca marca item alheio)", async () => {
		const { ledger } = await run({
			parent: (index) => {
				if (index === 0) return turn(setItems(["Semana 2", "Semana 3"]));
				if (index === 1) return turn(delegate({ goal: "Pesquise o preço da canela em 3 fornecedores." }));
				if (index === 2) return turn(call("u2", "track_items", { action: "update", id: "1", status: "done", evidence: "x" }), call("u3", "track_items", { action: "update", id: "2", status: "done", evidence: "y" }));
				return say(FINAL);
			},
		});
		// os dois só fecharam pelo track_items do modelo, com a evidência dele
		expect(ledger?.items.map((item) => item.evidence)).toEqual(["x", "y"]);
	});
});

describe("replay: portão de itens refaz a resposta no máximo uma vez", () => {
	it("delegação sem item mapeado (cenário A sem rótulo): uma revisão, e a resposta seguinte sai", async () => {
		const SECOND = "Pedi ao Bobinho o resumo; o item 'Resumo' segue aberto porque não confirmei o conteúdo.";
		const { result, discards, parentRequests } = await run({
			parent: (index) => {
				if (index === 0) return turn(setItems(["Resumo"]));
				if (index === 1) return turn(delegate({ goal: "Leia o material do AVA desta semana." }));
				if (index === 2) return say(FINAL);
				return say(SECOND);
			},
		});
		expect(discards).toHaveLength(1);
		expect(discards[0]).toMatchObject({ reason: "items_open" });
		const note = parentRequests[3]!.filter((m) => m.role === "system").map((m) => String(m.content)).find((t) => t.includes("Continue with the next open item"));
		expect(note).toContain("This is the only reminder");
		expect(result?.text).toBe(SECOND);
	});

	it("tarefa de vários itens sem track_items (cenário C): uma revisão, depois a resposta sai", async () => {
		const { result, discards } = await run({
			jev: jevSaying({ multi_item: 0.95 }),
			parent: (index) => {
				if (index === 0) return turn(delegate({ goal: "Escreva o resumo da Semana 2." }));
				if (index === 1) return say(FINAL);
				return say("Resumo da Semana 2 feito pelo subagente; as outras semanas não foram pedidas.");
			},
		});
		expect(discards).toHaveLength(1);
		expect(discards[0]).toMatchObject({ reason: "items_open" });
		expect(result?.text).toBe("Resumo da Semana 2 feito pelo subagente; as outras semanas não foram pedidas.");
	});

	it("controle: item fechado como failed com motivo pelo modelo passa sem descarte", async () => {
		const HONEST = "A Semana 2 não está publicada no AVA, então não há resumo.";
		const { result, discards } = await run({
			parent: (index) => {
				if (index === 0) return turn(setItems(["Semana 2"]));
				if (index === 1) return turn(call("f", "track_items", { action: "update", id: "1", status: "failed", reason: "not_found", detail: "week not published" }));
				return say(HONEST);
			},
		});
		expect(discards).toHaveLength(0);
		expect(result?.text).toBe(HONEST);
	});

	it("arquivo pedido + delegação que falhou: o portão revisa uma vez e a cobrança do arquivo não reescreve de novo", async () => {
		const GAP = "Ali, ainda não há arquivo: o subagente falhou ao ler o material, e o item 'Resumo' ficou sem conteúdo.";
		const { result, discards, error } = await run({
			jev: jevSaying({ wants_file: 0.95 }),
			child: () => {
				throw new Error("provider down");
			},
			parent: (index) => {
				if (index === 0) return turn(setItems(["Resumo"]));
				if (index === 1) return turn(delegate({ goal: "Leia o material do AVA desta semana." }));
				if (index === 2) return say("Pedi ao Bobinho o PDF, te aviso.");
				return say(GAP);
			},
		});
		expect(error).toBeUndefined();
		expect(discards).toHaveLength(1);
		expect(discards.map((d) => d.reason)).toEqual(["items_open"]);
		expect(result?.text).toBe(GAP);
	});
});
