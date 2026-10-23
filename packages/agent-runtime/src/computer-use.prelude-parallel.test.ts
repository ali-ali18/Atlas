import { describe, expect, it, vi } from "vitest";
import type { CompleteChatWithToolsParams, CompleteChatWithToolsResult } from "@workspace/llm";
import type { SandboxManager } from "@workspace/sandbox";
import type { AgentRunCheckpoint } from "@workspace/shared";
import { searchMemoryEntries } from "@workspace/db";
import { runComputerUse, type RuntimeStepRecord } from "./computer-use.js";
import type { JevAsk, JevRuntime } from "./jev/decide.js";
import type { ModelTiersRuntime } from "./model-tiers.js";

/**
 * Início do run sem esperas em série: perfil, intenção (Jev), dificuldade (revisor) e lista de bots
 * começam juntos; o checkpoint do 1º passo e o registro das tools oferecidas correm junto da chamada
 * ao modelo, com barreira antes de qualquer tool. LLM, Jev e db mockados.
 */

vi.mock("@workspace/db", async (original) => ({
	...(await original<typeof import("@workspace/db")>()),
	getBotProfile: vi.fn(async () => ({ description: "Bot configurado." })),
	listBotSkills: vi.fn(async () => []),
	searchSkillVersions: vi.fn(async () => []),
	listRoutines: vi.fn(async () => []),
	persistConversationCardFromEvent: vi.fn(async () => undefined),
	searchMemoryEntries: vi.fn(async () => []),
	loadAutonomyContext: vi.fn(async () => ({ accountRaw: null, botRaw: null, botName: "Taldo" })),
}));

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
const say = (content: string): CompleteChatWithToolsResult => ({ model: "m", message: { role: "assistant", content }, finishReason: "stop" });
const toolTurn = (id: string, name: string, args: Record<string, unknown>): CompleteChatWithToolsResult => ({
	model: "m",
	message: { role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }] },
});
const TIERS: ModelTiersRuntime = {
	tiers: { easy: ["easy/main"], medium: ["med/main"], hard: ["hard/main"] },
	classifyWithReviewer: true,
};

type Params = Parameters<typeof runComputerUse>[0];

function baseParams(overrides: Partial<Params> & { script: CompleteChatWithToolsResult[] }): { params: Params; models: string[] } {
	const models: string[] = [];
	const queue = [...overrides.script];
	const params = {
		manager: {} as SandboxManager,
		getSessionId: async () => "unused",
		sandboxEnabled: false,
		contextEconomy: false,
		apiKey: "test",
		model: "base/model",
		runId: "run-prelude",
		userId: "user-a",
		botId: "bot-a",
		conversationId: "conv-prelude",
		origin: "chat",
		messages: [{ role: "user", content: "me ajuda com isso" }],
		maxSteps: 10,
		onEvent: () => {},
		streamChat: async (input: CompleteChatWithToolsParams) => {
			models.push(input.model);
			const next = queue.shift();
			if (!next) throw new Error("LLM extra");
			return next;
		},
		...overrides,
	} as unknown as Params;
	return { params, models };
}

describe("runComputerUse: leituras do início em paralelo", () => {
	it("perfil, intenção, dificuldade e lista de bots começam antes de qualquer uma terminar", async () => {
		const started: string[] = [];
		const profile = deferred<{ description: string } | null>();
		const roster = deferred<Array<{ id: string; isPrimary?: boolean }>>();
		const intent = deferred<Record<string, number>>();
		const difficulty = deferred<Record<string, number>>();
		const ask: JevAsk = vi.fn(async ({ questions }) => {
			const kind = "hard" in questions ? "difficulty" : "profile_change" in questions ? "intent" : "other";
			started.push(kind);
			const answers = kind === "difficulty" ? await difficulty.promise : kind === "intent" ? await intent.promise : Object.fromEntries(Object.keys(questions).map((key) => [key, 0]));
			return { model: "jev", answers: Object.fromEntries(Object.keys(questions).map((key) => [key, answers[key] ?? 0])), durationMs: 1 };
		});
		const jev: JevRuntime = { ask, modes: { intent: "on" } };
		const { params, models } = baseParams({
			script: [say("Pronto.")],
			jev,
			modelTiers: TIERS,
			loadBotProfile: (async () => {
				started.push("profile");
				return profile.promise;
			}) as never,
			listBotRoster: async () => {
				started.push("roster");
				return roster.promise;
			},
		});
		const running = runComputerUse(params);
		await tick();
		expect(new Set(started)).toEqual(new Set(["profile", "intent", "difficulty", "roster"]));
		expect(models).toEqual([]);
		// Termina em qualquer ordem; o resultado é o mesmo de antes.
		roster.resolve([{ id: "bot-a" }]);
		difficulty.resolve({ hard: 0.95, medium: 0.9 });
		intent.resolve({});
		profile.resolve({ description: "Bot configurado." });
		const result = await running;
		expect(result.text).toBe("Pronto.");
		expect(models).toEqual(["hard/main"]);
	});

	it("abort durante as leituras não deixa rejeição sem dono", async () => {
		const controller = new AbortController();
		const ask: JevAsk = ({ signal }) =>
			new Promise((_, reject) => {
				signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
			});
		const profile = deferred<null>();
		const { params } = baseParams({
			script: [say("nunca")],
			jev: { ask, modes: { intent: "on" } },
			modelTiers: TIERS,
			abortSignal: controller.signal,
			loadBotProfile: (async () => profile.promise) as never,
		});
		const running = runComputerUse(params);
		await tick();
		controller.abort();
		await expect(running).rejects.toThrow();
		profile.resolve(null);
		await tick();
	});
});

describe("runComputerUse: escrita do 1º passo fora do caminho do modelo", () => {
	it("o checkpoint do 1º passo corre junto da chamada ao modelo; nenhuma tool roda antes dele gravar", async () => {
		const firstWrite = deferred<void>();
		const checkpoints: number[] = [];
		const order: string[] = [];
		let writes = 0;
		vi.mocked(searchMemoryEntries).mockImplementation((async () => {
			order.push("tool");
			return [];
		}) as never);
		const { params } = baseParams({
			script: [toolTurn("c1", "memory_search", { query: "x" }), say("Pronto.")],
			onCheckpoint: async (checkpoint: AgentRunCheckpoint) => {
				writes += 1;
				if (writes === 1) {
					order.push("checkpoint:start");
					await firstWrite.promise;
				}
				order.push(`checkpoint:${checkpoint.nextStepIndex}`);
				checkpoints.push(checkpoint.nextStepIndex);
			},
			streamChat: undefined,
		});
		const queue = [toolTurn("c1", "memory_search", { query: "x" }), say("Pronto.")];
		params.streamChat = (async () => {
			order.push("model");
			return queue.shift()!;
		}) as never;
		const running = runComputerUse(params);
		await tick();
		// O modelo já foi chamado com o checkpoint ainda gravando; a tool espera a barreira.
		expect(order).toEqual(["checkpoint:start", "model"]);
		firstWrite.resolve();
		const result = await running;
		expect(result.text).toBe("Pronto.");
		expect(order.indexOf("checkpoint:0")).toBeLessThan(order.indexOf("tool"));
		// A ordem das gravações não muda.
		expect(checkpoints).toEqual([...checkpoints].sort((a, b) => a - b));
		expect(checkpoints[0]).toBe(0);
	});

	it("falha do checkpoint do 1º passo ainda derruba o run antes de qualquer tool", async () => {
		let toolRan = false;
		vi.mocked(searchMemoryEntries).mockImplementation((async () => {
			toolRan = true;
			return [];
		}) as never);
		const { params } = baseParams({
			script: [toolTurn("c1", "memory_search", { query: "x" }), say("Pronto.")],
			onCheckpoint: async () => {
				throw new Error("db fora");
			},
		});
		await expect(runComputerUse(params)).rejects.toThrow("db fora");
		expect(toolRan).toBe(false);
	});

	it("o registro das tools oferecidas não segura o modelo, mas o run só termina depois dele", async () => {
		const offered = deferred<void>();
		const steps: RuntimeStepRecord[] = [];
		let modelCalled = false;
		const { params } = baseParams({
			script: [say("Pronto.")],
			onStep: async (step: RuntimeStepRecord) => {
				steps.push(step);
				if (step.idempotencyKey === "run-prelude:offered-tools") await offered.promise;
			},
		});
		const original = params.streamChat!;
		params.streamChat = (async (input: CompleteChatWithToolsParams) => {
			modelCalled = true;
			return original(input);
		}) as never;
		let settled = false;
		const running = runComputerUse(params).finally(() => {
			settled = true;
		});
		await tick();
		expect(modelCalled).toBe(true);
		expect(settled).toBe(false);
		offered.resolve();
		const result = await running;
		expect(result.text).toBe("Pronto.");
		expect(steps.some((step) => step.idempotencyKey === "run-prelude:offered-tools")).toBe(true);
	});
});
