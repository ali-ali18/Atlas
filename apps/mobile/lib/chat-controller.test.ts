import type { ComputerUseEvent, SessionMessage } from "@workspace/shared";
import { describe, expect, it, vi } from "vitest";
import { ChatApiError } from "./chat-api";
import { ChatController, deriveView, type ChatApi, type ChatDeps } from "./chat-controller";
import type { FollowOptions, FollowResult } from "./chat-stream";
import type { ChatItem } from "./chat-types";

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const row = (id: string, role: string, content: string, minute = 0): SessionMessage => ({ id, conversationId: "c1", role, content, createdAt: `2026-11-01T10:0${minute}:00.000Z` }) as SessionMessage;
const deferred = <T>() => {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
};
const done: ComputerUseEvent = { type: "done", message: { role: "assistant", content: "" }, model: "m" };
const delta = (text: string): ComputerUseEvent => ({ type: "assistant_delta", id: "s1", delta: text });

type Script = (options: FollowOptions, runId: string) => Promise<FollowResult>;

function setup(overrides: { api?: Partial<ChatApi>; follow?: Script; conversationId?: string | null; cache?: ChatDeps["cacheFor"] } = {}) {
	let runCount = 0;
	const calls = { createRun: [] as unknown[], createRunInput: [] as Array<[string, string]>, cancelRun: [] as string[], submit: [] as unknown[], fetchPage: [] as string[], createConversation: 0, unauthorized: 0 };
	const api: ChatApi = {
		fetchPage: async (conversationId) => (calls.fetchPage.push(conversationId), { messages: [row("m1", "user", "oi"), row("m2", "assistant", "olá, tudo bem por aí?", 1)], hasMore: false }),
		createConversation: async () => (calls.createConversation++, "c-new"),
		createRun: async (input) => (calls.createRun.push(input), { runId: `r${++runCount}`, status: "queued" }),
		createRunInput: async (runId, content) => void calls.createRunInput.push([runId, content]),
		cancelRun: async (runId) => void calls.cancelRun.push(runId),
		getRunStatus: async () => "running",
		listActiveRuns: async () => [],
		submitQuestionnaire: async (input) => (calls.submit.push(input), { runId: `r${++runCount}` }),
		...overrides.api,
	};
	let seq = 0;
	const deps: ChatDeps = {
		api,
		openRunStream: () => async () => Promise.reject(new Error("não usado")),
		cacheFor: overrides.cache ?? (() => null),
		onUnauthorized: () => void calls.unauthorized++,
		follow: ((options: FollowOptions) => (overrides.follow ?? (async (opts) => (opts.onEvent(done), "boundary" as const)))(options, "?")) as never,
		sleep: async () => undefined,
		clientKey: () => `k${++seq}`,
		throttleMs: 0,
	};
	const controller = new ChatController(deps, { id: "bot1", conversationId: overrides.conversationId === undefined ? "c1" : overrides.conversationId });
	return { controller, calls };
}

const view = (controller: ChatController) => deriveView(controller.getSnapshot());

describe("abertura e conversa", () => {
	it("abre pelo cache, confere o servidor e troca pelo fim de verdade", async () => {
		const cached: ChatItem[] = [{ id: "m0", kind: "user", text: "do cache" }];
		const { controller } = setup({ cache: () => ({ load: async () => cached, save: async () => undefined }) });
		const seen: string[][] = [];
		controller.subscribe(() => seen.push(controller.getSnapshot().persisted.map((item) => item.id)));
		await controller.open();
		expect(seen).toContainEqual(["m0"]);
		expect(controller.getSnapshot().persisted.map((item) => item.id)).toEqual(["m1", "m2"]);
		expect(view(controller).line).toBeNull();
	});
	it("o bot ganha a conversa depois: reabre o fio e o primeiro envio não cria conversa paralela", async () => {
		const { controller, calls } = setup({ conversationId: null });
		await controller.open();
		expect(calls.fetchPage).toEqual([]);
		controller.update({ id: "bot1", conversationId: "c1" });
		await flush();
		expect(calls.fetchPage).toEqual(["c1"]);
		controller.send("oi de novo");
		await flush();
		expect(calls.createConversation).toBe(0);
		expect(calls.createRun[0]).toMatchObject({ conversationId: "c1", botId: "bot1" });
	});
	it("sem conversa nenhuma, o envio cria uma e a home atrasada com a mesma não reabre nada", async () => {
		const { controller, calls } = setup({ conversationId: null });
		await controller.open();
		controller.send("primeira");
		await flush();
		expect(calls.createConversation).toBe(1);
		expect(calls.createRun[0]).toMatchObject({ conversationId: "c-new" });
		controller.update({ id: "bot1", conversationId: "c-outra" });
		await flush();
		expect(calls.fetchPage.includes("c-outra")).toBe(false);
	});
});

describe("parar", () => {
	it("com o run pausado em aprovação (sem stream) o parar cancela o run e encerra", async () => {
		const { controller, calls } = setup({
			follow: async (options) => {
				options.onEvent({ type: "confirm", confirmId: "k", title: "Criar?" });
				options.onEvent({ type: "paused" });
				return "boundary";
			},
		});
		await controller.open();
		controller.send("cria a rotina");
		await flush();
		await flush();
		expect(controller.getSnapshot().live.paused).toBe(true);
		expect(view(controller).running).toBe(true);
		controller.stop();
		await flush();
		expect(calls.cancelRun).toEqual(["r1"]);
		expect(controller.getSnapshot().live.paused).toBe(false);
		expect(view(controller).running).toBe(false);
	});
	it("parar antes de o run existir: cancela assim que o runId chega", async () => {
		const gate = deferred<{ runId: string | null; status: string }>();
		const { controller, calls } = setup({ api: { createRun: () => gate.promise } });
		await controller.open();
		controller.send("pedido");
		await flush();
		controller.stop();
		expect(calls.cancelRun).toEqual([]);
		gate.resolve({ runId: "rX", status: "queued" });
		await flush();
		expect(calls.cancelRun).toEqual(["rX"]);
	});
});

describe("corridas de envio", () => {
	it("envio durante o syncTail do fim do run anterior: o fim antigo não apaga o run novo", async () => {
		const gate = deferred<void>();
		let pages = 0;
		const scripts: Script[] = [
			// a conexão do primeiro run caiu e o servidor já o deu por terminado: o fim dele é "terminal"
			async (options) => (options.onEvent(delta("resposta do primeiro run, bem longa")), "terminal" as const),
			async (options) => (options.onEvent(delta("resposta do SEGUNDO run em andamento")), new Promise<FollowResult>(() => undefined)),
		];
		const { controller } = setup({
			api: {
				fetchPage: async () => {
					pages += 1;
					if (pages === 2) await gate.promise; // o syncTail do fim do primeiro run fica pendurado
					return { messages: [row("m1", "user", "oi")], hasMore: false };
				},
			},
			follow: (options, runId) => scripts.shift()!(options, runId),
		});
		await controller.open();
		controller.send("primeiro");
		await flush();
		await flush();
		controller.send("segundo");
		await flush();
		await flush();
		const texts = () => controller.getSnapshot().live.items.filter((item) => item.kind === "assistant").map((item) => (item as { text: string }).text);
		expect(texts()).toEqual(["resposta do SEGUNDO run em andamento"]);
		gate.resolve();
		await flush();
		await flush();
		expect(texts()).toEqual(["resposta do SEGUNDO run em andamento"]);
		expect(controller.getSnapshot().following).toBe(true);
	});
	it("segundo envio enquanto o run ainda é criado entra na fila e vira input do run, sem perder o texto", async () => {
		const gate = deferred<{ runId: string | null; status: string }>();
		const { controller, calls } = setup({ api: { createRun: () => gate.promise }, follow: async () => new Promise<FollowResult>(() => undefined) });
		await controller.open();
		controller.send("um");
		await flush();
		controller.send("dois");
		controller.send("três");
		expect(calls.createRunInput).toEqual([]);
		expect(controller.getSnapshot().live.items.filter((item) => item.kind === "user").map((item) => (item as { text: string }).text)).toEqual(["um", "dois", "três"]);
		gate.resolve({ runId: "r9", status: "queued" });
		await flush();
		await flush();
		expect(calls.createRunInput).toEqual([["r9", "dois"], ["r9", "três"]]);
	});
	it("a criação do run falha: a fala sai da tela, o erro aparece e a fila segue como envio novo", async () => {
		let attempt = 0;
		const { controller, calls } = setup({
			api: {
				createRun: async (input) => {
					attempt += 1;
					if (attempt === 1) throw new ChatApiError("x", 500);
					calls.createRun.push(input);
					return { runId: "r2", status: "queued" };
				},
			},
			follow: async () => new Promise<FollowResult>(() => undefined),
		});
		await controller.open();
		controller.send("um");
		controller.send("dois"); // ainda criando o run do "um": entra na fila
		await flush();
		await flush();
		await flush();
		expect(controller.getSnapshot().error).toBeTruthy();
		const users = controller.getSnapshot().live.items.filter((item) => item.kind === "user").map((item) => (item as { text: string }).text);
		expect(users).toEqual(["dois"]);
		expect(calls.createRun).toHaveLength(1);
	});
	it("409 de conversa ocupada tenta de novo e passa", async () => {
		let attempt = 0;
		const { controller, calls } = setup({
			api: {
				createRun: async (input) => {
					attempt += 1;
					if (attempt < 3) throw new ChatApiError("A conversa já tem uma tarefa em andamento. Espere.", 409);
					calls.createRun.push(input);
					return { runId: "r1", status: "queued" };
				},
			},
			follow: async () => new Promise<FollowResult>(() => undefined),
		});
		await controller.open();
		controller.send("oi");
		await flush();
		await flush();
		expect(attempt).toBe(3);
		expect(controller.getSnapshot().error).toBeNull();
	});
});

describe("cartões: toque duplo", () => {
	const confirm: Extract<ChatItem, { kind: "confirm" }> = { id: "c", kind: "confirm", confirmId: "k1", title: "Criar?", status: "pending" };
	it("aprovação tocada duas vezes manda uma vez só (com o decisionConfirmId)", async () => {
		const gate = deferred<{ runId: string | null; status: string }>();
		const { controller, calls } = setup({ api: { createRun: (input) => (calls.createRun.push(input), gate.promise) }, follow: async () => new Promise<FollowResult>(() => undefined) });
		await controller.open();
		controller.decide(confirm, true);
		controller.decide(confirm, true);
		controller.decide(confirm, false);
		gate.resolve({ runId: "r1", status: "queued" });
		await flush();
		expect(calls.createRun).toHaveLength(1);
		expect(calls.createRun[0]).toMatchObject({ content: "confirmado: Criar?", decisionConfirmId: "k1" });
		// cartão que já não está pendente também é ignorado
		controller.decide({ ...confirm, confirmId: "k2", status: "approved" }, true);
		await flush();
		expect(calls.createRun).toHaveLength(1);
	});
	it("falha ao decidir libera o cartão para tentar de novo", async () => {
		let attempt = 0;
		const { controller, calls } = setup({
			api: {
				createRun: async (input) => {
					attempt += 1;
					if (attempt === 1) throw new ChatApiError("x", 500);
					calls.createRun.push(input);
					return { runId: "r1", status: "queued" };
				},
			},
			follow: async () => new Promise<FollowResult>(() => undefined),
		});
		await controller.open();
		controller.decide(confirm, true);
		await flush();
		expect(controller.getSnapshot().decisions).toEqual({});
		controller.decide(confirm, true);
		await flush();
		expect(calls.createRun).toHaveLength(1);
	});
	it("questionário respondido duas vezes envia uma vez só", async () => {
		const { controller, calls } = setup({ follow: async () => new Promise<FollowResult>(() => undefined) });
		await controller.open();
		const item: Extract<ChatItem, { kind: "questionnaire" }> = { id: "q", kind: "questionnaire", questionnaireId: "q1", title: "Qual?", items: [], status: "pending" };
		controller.answer(item, { a: "1" });
		controller.answer(item, { a: "2" });
		await flush();
		expect(calls.submit).toHaveLength(1);
		expect(deriveView(controller.getSnapshot()).items).toBeDefined();
	});
});

describe("sessão e erros", () => {
	it("401 do stream desloga e avisa sem texto técnico", async () => {
		const { controller, calls } = setup({
			follow: async () => {
				throw new (await import("./chat-stream")).StreamHttpError(401);
			},
		});
		await controller.open();
		controller.send("oi");
		await flush();
		await flush();
		expect(calls.unauthorized).toBeGreaterThan(0);
	});
	it("sem rede: o cache continua na tela e a linha vira 'Sem conexão'", async () => {
		const cached: ChatItem[] = [{ id: "m0", kind: "user", text: "do cache" }];
		const { controller } = setup({ cache: () => ({ load: async () => cached, save: async () => undefined }), api: { fetchPage: async () => Promise.reject(new TypeError("Network request failed")) } });
		await controller.open();
		expect(controller.getSnapshot().persisted.map((item) => item.id)).toEqual(["m0"]);
		expect(view(controller).line).toEqual({ kind: "offline", text: "Sem conexão" });
	});
	it("o que chega do servidor depois de dispose/reabertura (outra conta) não vai ao cache", async () => {
		const gate = deferred<{ messages: SessionMessage[]; hasMore: boolean }>();
		const save = vi.fn(async () => undefined);
		const { controller } = setup({ cache: () => ({ load: async () => null, save }), api: { fetchPage: () => gate.promise } });
		const opening = controller.open();
		await flush();
		controller.dispose();
		gate.resolve({ messages: [row("m1", "user", "oi")], hasMore: false });
		await opening;
		expect(save).not.toHaveBeenCalled();
	});
	it("o texto chegando é aplicado mesmo com os avisos à tela espaçados", async () => {
		const { controller } = setup({
			follow: async (options) => {
				for (const part of ["Olá, ", "tudo ", "bem?"]) options.onEvent(delta(part));
				return new Promise<FollowResult>(() => undefined);
			},
		});
		await controller.open();
		controller.send("oi");
		await flush();
		await flush();
		const bubble = controller.getSnapshot().live.items.find((item) => item.kind === "assistant");
		expect(bubble && "text" in bubble ? bubble.text : "").toBe("Olá, tudo bem?");
	});
});
