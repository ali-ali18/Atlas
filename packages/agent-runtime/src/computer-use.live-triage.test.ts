import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CompleteChatWithToolsParams, CompleteChatWithToolsResult, LlmMessage } from "@workspace/llm";
import type { SandboxManager } from "@workspace/sandbox";
import type { AgentRunCheckpoint } from "@workspace/shared";
import { createSubagentRun } from "@workspace/db";
import { AgentRunCancelledError, runComputerUse } from "./computer-use.js";
import { ACK_CONTINUE_PROMPT } from "./loop/transcript.js";
import { JOIN_NOTE_HEADER, USER_MESSAGE_HEADER } from "./loop/inputs.js";
import { MESSAGE_TRIAGE_SYSTEM } from "./loop/message-triage.js";

/**
 * Mensagem do usuário com um subagente rodando: a triagem acontece na hora (balão antes do fim da
 * tool) e o histórico só recebe o veredito no ponto seguro, com tool_calls -> tool contíguo.
 */

vi.mock("@workspace/db", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@workspace/db")>();
	return {
		...actual,
		getBotProfile: vi.fn(async () => null),
		listBotSkills: vi.fn(async () => []),
		searchSkillVersions: vi.fn(async () => []),
		persistConversationCardFromEvent: vi.fn(async () => undefined),
		createSubagentRun: vi.fn(),
		finishSubagentRun: vi.fn(async () => true),
		failOrphanSubagentRuns: vi.fn(async () => 0),
		appendAgentStep: vi.fn(async () => undefined),
	};
});

type Ev = Record<string, unknown> & { type: string };
const POLL_MS = 15;

const say = (content: string): CompleteChatWithToolsResult => ({ model: "m", message: { role: "assistant", content }, finishReason: "stop" });
const delegate = (): CompleteChatWithToolsResult => ({
	model: "m",
	message: {
		role: "assistant",
		content: null,
		tool_calls: [{ id: "d1", type: "function", function: { name: "delegate_task", arguments: JSON.stringify({ tasks: [{ goal: "Pesquisar A" }] }) } }],
	},
});
const triageJson = (value: Record<string, unknown>) => say(JSON.stringify(value));
const isTriage = (params: CompleteChatWithToolsParams) => String(params.messages[0]?.content).startsWith(MESSAGE_TRIAGE_SYSTEM);
const isChild = (params: CompleteChatWithToolsParams) =>
	typeof params.messages[0]?.content === "string" && params.messages[0].content.includes("focused sub-agent");

function latch() {
	let open!: () => void;
	const promise = new Promise<void>((resolve) => {
		open = resolve;
	});
	return { promise, open };
}

/** Run com um subagente que só termina quando o teste libera (ou quando o sinal aborta, como o streamChat real). */
function setup(options: {
	triage?: (params: CompleteChatWithToolsParams) => CompleteChatWithToolsResult | Promise<CompleteChatWithToolsResult>;
	extra?: Partial<Parameters<typeof runComputerUse>[0]>;
}) {
	const release = latch();
	const events: Ev[] = [];
	const checkpoints: AgentRunCheckpoint[] = [];
	const parentRequests: LlmMessage[][] = [];
	const triageCalls: CompleteChatWithToolsParams[] = [];
	const inputs: Array<{ id: string; content: string; mode: string }> = [];
	let parentCalls = 0;
	const requestCancel = vi.fn(async () => undefined);
	const run = runComputerUse({
		manager: {} as SandboxManager,
		getSessionId: async () => {
			throw new Error("sem sandbox");
		},
		sandboxEnabled: true,
		model: "m",
		apiKey: "test",
		messages: [{ role: "user", content: "pesquise A" }],
		botId: "bot-1",
		userId: "user-1",
		runId: "run-live",
		origin: "chat",
		maxSteps: 8,
		interruptPollMs: POLL_MS,
		consumeSteerInputs: async () => inputs.map((item) => ({ ...item })),
		requestCancel,
		onEvent: (event) => void events.push(event as unknown as Ev),
		onCheckpoint: async (value) => void checkpoints.push(structuredClone(value)),
		streamChat: async (params) => {
			if (isTriage(params)) {
				triageCalls.push(params);
				if (!options.triage) throw new Error("triagem indisponivel");
				return options.triage(params);
			}
			if (isChild(params)) {
				await new Promise<void>((resolve, reject) => {
					void release.promise.then(resolve);
					params.signal?.addEventListener("abort", () => reject(params.signal?.reason ?? new Error("aborted")), { once: true });
				});
				return say("A: resultado");
			}
			parentCalls += 1;
			parentRequests.push(structuredClone(params.messages));
			return parentCalls === 1 ? delegate() : say("Pronto: A pesquisado.");
		},
		...options.extra,
	} as never);
	// Evita unhandled rejection quando o teste só observa o erro depois.
	run.catch(() => undefined);
	const toolDone = () => events.some((event) => event.type === "tool_result" && event.name === "delegate_task");
	const replies = () => events.filter((event) => event.type === "assistant_delta" && String(event.id).includes("-reply"));
	const subagentRunning = () => vi.waitFor(() => expect(events.some((event) => event.type === "subagent_started")).toBe(true));
	return { run, release, events, checkpoints, parentRequests, triageCalls, inputs, requestCancel, toolDone, replies, subagentRunning };
}

describe("triagem ao vivo durante tool longa", () => {
	let intervals: Array<{ id: unknown; ms: unknown }>;
	let cleared: unknown[];
	beforeEach(() => {
		vi.clearAllMocks();
		let counter = 0;
		vi.mocked(createSubagentRun).mockImplementation(async () => ({ id: `child-${++counter}` }));
		intervals = [];
		cleared = [];
		const realSet = globalThis.setInterval;
		const realClear = globalThis.clearInterval;
		vi.spyOn(globalThis, "setInterval").mockImplementation(((fn: () => void, ms?: number, ...rest: unknown[]) => {
			const id = realSet(fn, ms, ...(rest as []));
			intervals.push({ id, ms });
			return id;
		}) as never);
		vi.spyOn(globalThis, "clearInterval").mockImplementation(((id: never) => {
			cleared.push(id);
			return realClear(id);
		}) as never);
	});
	afterEach(() => vi.restoreAllMocks());

	/** Todo timer de polling criado pelo run foi limpo (nenhum vazamento em nenhum caminho de saída). */
	const noTimerLeak = () => {
		const mine = intervals.filter((item) => item.ms === POLL_MS);
		expect(mine.length).toBeGreaterThan(0);
		for (const item of mine) expect(cleared).toContain(item.id);
	};

	it("chat: o balão sai antes do fim do subagente; a nota e o ack entram depois dos tool results; triada uma vez", async () => {
		const t = setup({ triage: () => triageJson({ kind: "chat", cancel: false, reply: "Em andamento, já te falo.", instruction: "" }) });
		await t.subagentRunning();
		t.inputs.push({ id: "in-1", content: "como está indo?", mode: "join" });

		await vi.waitFor(() => expect(t.replies()).toHaveLength(1));
		expect(t.replies()[0]).toMatchObject({ delta: "Em andamento, já te falo." });
		// Balão saiu com o subagente ainda rodando.
		expect(t.toolDone()).toBe(false);

		t.release.open();
		const result = await t.run;
		expect(result.text).toContain("Pronto");

		// 2ª chamada do pai: assistant(tool_calls) -> tool -> nota -> ack -> continuação.
		const second = t.parentRequests[1]!;
		const callIndex = second.findIndex((m) => m.role === "assistant" && m.tool_calls?.length);
		expect(second[callIndex + 1]).toMatchObject({ role: "tool", tool_call_id: expect.stringMatching(/_d1$/) });
		expect(second[callIndex + 2]).toMatchObject({ role: "user" });
		expect(String(second[callIndex + 2]!.content)).toContain(JOIN_NOTE_HEADER);
		expect(String(second[callIndex + 2]!.content)).toContain("como está indo?");
		expect(second[callIndex + 3]).toMatchObject({ role: "assistant", content: "Em andamento, já te falo." });
		expect(second[callIndex + 4]).toMatchObject({ role: "user", content: ACK_CONTINUE_PROMPT });

		// Triada uma vez só, balão uma vez só, consumida uma vez só.
		expect(t.triageCalls).toHaveLength(1);
		expect(t.replies()).toHaveLength(1);
		expect(t.events.filter((e) => e.type === "input_consumed" && e.inputId === "in-1")).toHaveLength(1);
		const last = t.checkpoints[t.checkpoints.length - 1]!;
		expect(last.consumedInputIds).toContain("in-1");
		expect(last.triagedInputs ?? []).toHaveLength(0);
		noTimerLeak();
	});

	it("later e change: balão na hora, follow-up na hora, objetivo revisado só no ponto seguro", async () => {
		const queued: Array<[string, string]> = [];
		const t = setup({
			triage: (params) =>
				String(params.messages[1]?.content).split("User message:").at(-1)!.includes("depois")
					? triageJson({ kind: "later", cancel: false, reply: "Faço depois.", instruction: "Resumir em tabela" })
					: triageJson({ kind: "change", cancel: false, reply: "Mudei o foco.", instruction: "Pesquisar B em vez de A" }),
			extra: { queueFollowUp: async (instruction: string, key: string) => void queued.push([instruction, key]) },
		});
		await t.subagentRunning();
		t.inputs.push({ id: "in-later", content: "depois faz uma tabela", mode: "join" });
		await vi.waitFor(() => expect(t.replies()).toHaveLength(1));
		expect(queued).toEqual([["Resumir em tabela", "later:in-later"]]);
		expect(t.toolDone()).toBe(false);

		t.inputs.push({ id: "in-change", content: "melhor pesquisar B", mode: "join" });
		await vi.waitFor(() => expect(t.replies()).toHaveLength(2));
		expect(t.toolDone()).toBe(false);
		// Efeito do change só no ponto seguro: ainda sem revisão no checkpoint.
		expect(t.checkpoints.some((c) => (c.objectiveRevisions ?? []).length > 0)).toBe(false);

		t.release.open();
		await t.run;
		const last = t.checkpoints[t.checkpoints.length - 1]!;
		expect(last.objectiveRevisions?.map((r) => r.newText)).toEqual(["Pesquisar B em vez de A"]);
		expect(queued).toHaveLength(1);
		expect(t.triageCalls).toHaveLength(2);
		expect(t.replies()).toHaveLength(2);
		noTimerLeak();
	});

	it("cancel: balão, cancelamento pedido e o run termina cancelado sem esperar o subagente", async () => {
		const t = setup({ triage: () => triageJson({ kind: "change", cancel: true, reply: "Parei.", instruction: "" }) });
		await t.subagentRunning();
		t.inputs.push({ id: "in-stop", content: "para tudo", mode: "join" });

		// O subagente nunca é liberado: o abort do run chega até a chamada dele.
		await expect(t.run).rejects.toBeInstanceOf(AgentRunCancelledError);
		expect(t.replies()).toHaveLength(1);
		expect(t.requestCancel).toHaveBeenCalledTimes(1);
		expect(t.toolDone()).toBe(false);
		noTimerLeak();
	});

	it("triagem falha: sem balão antecipado; o ponto seguro trata a entrada com o cabeçalho neutro", async () => {
		const t = setup({});
		await t.subagentRunning();
		t.inputs.push({ id: "in-x", content: "alguma novidade?", mode: "join" });
		await vi.waitFor(() => expect(t.triageCalls.length).toBeGreaterThanOrEqual(1));
		expect(t.replies()).toHaveLength(0);

		t.release.open();
		const result = await t.run;
		expect(result.text).toContain("Pronto");
		const second = t.parentRequests[1]!;
		const note = second.find((m) => m.role === "user" && String(m.content).includes("alguma novidade?"));
		expect(String(note?.content)).toContain(USER_MESSAGE_HEADER);
		expect(t.replies()).toHaveLength(0);
		expect(t.events.filter((e) => e.type === "input_consumed")).toHaveLength(1);
		noTimerLeak();
	});

	it("entrada `queue` não passa pela triagem ao vivo", async () => {
		const t = setup({ triage: () => triageJson({ kind: "chat", cancel: false, reply: "x", instruction: "" }) });
		await t.subagentRunning();
		t.inputs.push({ id: "in-q", content: "depois", mode: "queue" });
		await new Promise((resolve) => setTimeout(resolve, POLL_MS * 4));
		expect(t.triageCalls).toHaveLength(0);
		t.release.open();
		await t.run;
		expect(t.triageCalls).toHaveLength(0);
		noTimerLeak();
	});

	it("run filho (sem consumeSteerInputs) não cria vigia de entradas", async () => {
		await runComputerUse({
			manager: {} as SandboxManager,
			getSessionId: async () => {
				throw new Error("sem sandbox");
			},
			sandboxEnabled: false,
			model: "m",
			apiKey: "test",
			messages: [{ role: "user", content: "oi" }],
			botId: "bot-1",
			userId: "user-1",
			runId: "run-child",
			origin: "subagent",
			maxSteps: 2,
			interruptPollMs: POLL_MS,
			onEvent: () => undefined,
			streamChat: async () => say("feito"),
		} as never);
		expect(intervals.filter((item) => item.ms === POLL_MS)).toHaveLength(0);
	});
});

describe("triagem ao vivo guiada por sinais (sem consulta de 750 ms)", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		let counter = 0;
		vi.mocked(createSubagentRun).mockImplementation(async () => ({ id: `child-${++counter}` }));
	});
	afterEach(() => vi.restoreAllMocks());

	/** Fonte de sinais falsa + contador de leituras do db (`consumeSteerInputs`). */
	function withSignals(inputs: Array<{ id: string; content: string; mode: string }>) {
		const listeners = new Set<(kind: string) => void>();
		let subscribed = 0;
		let unsubscribed = 0;
		const reads = { count: 0 };
		return {
			listeners,
			reads,
			get subscribed() {
				return subscribed;
			},
			get unsubscribed() {
				return unsubscribed;
			},
			emit: (kind: string) => listeners.forEach((listener) => listener(kind)),
			extra: {
				interruptPollMs: undefined,
				onRunSignal: (listener: (kind: string) => void) => {
					subscribed += 1;
					listeners.add(listener);
					return () => {
						if (listeners.delete(listener)) unsubscribed += 1;
					};
				},
				consumeSteerInputs: async () => {
					reads.count += 1;
					return inputs.map((item) => ({ ...item }));
				},
			},
		};
	}

	it("sinal input: UMA leitura, o balão sai e nenhuma outra consulta acontece depois", async () => {
		const shared: Array<{ id: string; content: string; mode: string }> = [];
		const bus = withSignals(shared);
		const t = setup({
			triage: () => triageJson({ kind: "chat", cancel: false, reply: "Em andamento.", instruction: "" }),
			extra: bus.extra as never,
		});
		await t.subagentRunning();
		// Antes do sinal o db é lido só no início do vigia (cobre novidade anterior à inscrição).
		const baseline = bus.reads.count;
		shared.push({ id: "in-1", content: "como está indo?", mode: "join" });
		await new Promise((resolve) => setTimeout(resolve, 900));
		expect(bus.reads.count).toBe(baseline);
		expect(t.replies()).toHaveLength(0);

		bus.emit("input");
		await vi.waitFor(() => expect(t.replies()).toHaveLength(1));
		expect(bus.reads.count).toBe(baseline + 1);
		// Passou mais de um período do polling antigo (750 ms): continua sem consultar.
		await new Promise((resolve) => setTimeout(resolve, 900));
		expect(bus.reads.count).toBe(baseline + 1);
		expect(t.toolDone()).toBe(false);

		t.release.open();
		await t.run;
		expect(bus.listeners.size).toBe(0);
		expect(bus.subscribed).toBe(bus.unsubscribed);
	});

	it("cancel pedido pela triagem aborta o run e solta todas as inscrições", async () => {
		const shared: Array<{ id: string; content: string; mode: string }> = [];
		const bus = withSignals(shared);
		const t = setup({ triage: () => triageJson({ kind: "change", cancel: true, reply: "Parei.", instruction: "" }), extra: bus.extra as never });
		await t.subagentRunning();
		shared.push({ id: "in-stop", content: "para tudo", mode: "join" });
		bus.emit("input");
		await expect(t.run).rejects.toBeInstanceOf(AgentRunCancelledError);
		expect(bus.listeners.size).toBe(0);
		expect(bus.subscribed).toBeGreaterThan(0);
		expect(bus.subscribed).toBe(bus.unsubscribed);
	});

	it("erro do run também solta as inscrições", async () => {
		const bus = withSignals([]);
		const controller = new AbortController();
		const t = setup({ extra: { ...bus.extra, abortSignal: controller.signal } as never });
		await t.subagentRunning();
		controller.abort(new Error("lease perdido"));
		await expect(t.run).rejects.toThrow();
		expect(bus.listeners.size).toBe(0);
		expect(bus.subscribed).toBe(bus.unsubscribed);
	});
});
