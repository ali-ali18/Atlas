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
	const calls = { createRun: [] as unknown[], createRunInput: [] as Array<[string, string]>, cancelRun: [] as string[], submit: [] as unknown[], reaction: [] as string[], unread: [] as string[], inputReplies: [] as Array<string | undefined>, requests: [] as unknown[], cards: [] as unknown[], fetchPage: [] as string[], createConversation: 0, unauthorized: 0 };
	const api: ChatApi = {
		fetchPage: async (conversationId) => (calls.fetchPage.push(conversationId), { messages: [row("m1", "user", "oi"), row("m2", "assistant", "olá, tudo bem por aí?", 1)], hasMore: false }),
		createConversation: async () => (calls.createConversation++, "c-new"),
		createRun: async (input) => (calls.createRun.push(input), { runId: `r${++runCount}`, status: "queued" }),
		createRunInput: async (runId, content, _key, replyToMessageId) => void (calls.createRunInput.push([runId, content]), calls.inputReplies.push(replyToMessageId)),
		cancelRun: async (runId) => void calls.cancelRun.push(runId),
		getRunStatus: async () => "running",
		listActiveRuns: async () => [],
		submitQuestionnaire: async (input) => (calls.submit.push(input), { runId: `r${++runCount}` }),
		respondRequest: async (input) => (calls.requests.push(input), { ok: true, status: "recorded", resumed: true }),
		respondCard: async (cardId, response) => void calls.cards.push([cardId, response]),
		setReaction: async (messageId, emoji) => void calls.reaction.push(`PUT ${messageId} ${emoji}`),
		clearReaction: async (messageId) => void calls.reaction.push(`DELETE ${messageId}`),
		markConversationUnread: async (conversationId) => void calls.unread.push(conversationId),
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

describe("indicador e só reação", () => {
	it("enquanto o run é criado o chat conta como em andamento (Pensando e botão de parar)", async () => {
		const gate = deferred<{ runId: string; status: string }>();
		const { controller } = setup({ api: { createRun: () => gate.promise as never } });
		await controller.open();
		controller.send("bom dia");
		await flush();
		expect(view(controller).running).toBe(true);
		expect(controller.getSnapshot().live.phase).toBe("thinking");
		gate.resolve({ runId: "r1", status: "queued" });
		await flush();
		await flush();
	});
	it("parar tocado antes de o bot só reagir não cancela o run do envio seguinte", async () => {
		const first = deferred<{ runId: string | null; status: string }>();
		let runs = 0;
		const { controller, calls } = setup({
			api: { createRun: async () => (++runs === 1 ? (first.promise as never) : ({ runId: "r2", status: "queued" } as never)) },
			follow: async () => new Promise<never>(() => undefined),
		});
		await controller.open();
		controller.send("valeu!");
		await flush();
		controller.stop();
		first.resolve({ runId: null, status: "reacted" });
		await flush();
		await flush();
		await flush();
		controller.send("e a agenda de hoje?");
		await flush();
		await flush();
		expect(calls.cancelRun).toEqual([]);
	});
	it("o bot só reagiu (runId nulo): para o indicador e mostra a reação dele na fala", async () => {
		let pages = 0;
		const reacted = { ...row("m3", "user", "valeu!", 2), reactions: [{ actor: "bot", emoji: "❤️" }] } as SessionMessage;
		const { controller } = setup({
			api: {
				createRun: async () => ({ runId: null, status: "reacted" }) as never,
				fetchPage: async () => ((pages += 1), { messages: pages > 1 ? [row("m1", "user", "oi"), reacted] : [row("m1", "user", "oi")], hasMore: false }),
			},
		});
		await controller.open();
		controller.send("valeu!");
		await flush();
		await flush();
		await flush();
		const v = view(controller);
		expect(v.running).toBe(false);
		expect(v.items.find((item) => item.kind === "user" && item.text === "valeu!")).toMatchObject({ reactions: [{ actor: "bot", emoji: "❤️" }] });
	});
});

describe("replay do run e reações do avatar", () => {
	it("seguir de novo o mesmo run (replay after=0) não conta o fim de novo", async () => {
		const ended: ComputerUseEvent = { type: "error", error: "falhou" };
		let follows = 0;
		const { controller } = setup({
			follow: async (options) => {
				follows += 1;
				// o servidor reenvia tudo: evento 1 (erro) e, no segundo follow, nada novo
				options.onCursor?.(1);
				options.onEvent(ended);
				return follows === 1 ? ("boundary" as const) : new Promise<never>(() => undefined);
			},
		});
		await controller.open();
		await controller.follow("r9");
		expect(controller.getSnapshot().live.failures).toBe(1);
		void controller.follow("r9");
		await flush();
		expect(controller.getSnapshot().live.failures).toBe(1);
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

describe("menu da mensagem: reações e não lida", () => {
	const reactionsOf = (controller: ChatController, id: string) => {
		const item = controller.getSnapshot().persisted.find((candidate) => candidate.id === id);
		return item && (item.kind === "user" || item.kind === "assistant") ? item.reactions : undefined;
	};

	it("reagir aparece na hora e manda PUT; trocar manda PUT de novo; a mesma tira com DELETE", async () => {
		const gate = deferred<void>();
		const puts: string[] = [];
		const { controller, calls } = setup({
			api: {
				setReaction: async (id, emoji) => {
					puts.push(`PUT ${id} ${emoji}`);
					if (puts.length === 1) await gate.promise; // só a primeira espera
				},
				clearReaction: async (id) => void puts.push(`DELETE ${id}`),
			},
		});
		await controller.open();
		const pending = controller.react("m2", "🔥");
		expect(reactionsOf(controller, "m2")).toEqual([{ actor: "user", emoji: "🔥" }]); // antes do servidor responder
		gate.resolve();
		await pending;
		await controller.react("m2", "👍");
		expect(reactionsOf(controller, "m2")).toEqual([{ actor: "user", emoji: "👍" }]);
		await controller.react("m2", "👍");
		expect(reactionsOf(controller, "m2")).toBeUndefined();
		expect(puts).toEqual(["PUT m2 🔥", "PUT m2 👍", "DELETE m2"]);
		expect(calls.reaction).toEqual([]);
	});

	it("toques rápidos na mesma fala saem em ordem para o servidor", async () => {
		const gate = deferred<void>();
		const calls: string[] = [];
		const { controller } = setup({
			api: {
				setReaction: async (id, emoji) => {
					calls.push(`PUT ${id} ${emoji}`);
					if (calls.length === 1) await gate.promise; // o primeiro PUT demora
				},
				clearReaction: async (id) => void calls.push(`DELETE ${id}`),
			},
		});
		await controller.open();
		const first = controller.react("m2", "👍");
		const second = controller.react("m2", "👍"); // mesma reação de novo: tira
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(calls).toEqual(["PUT m2 👍"]); // o DELETE espera o PUT terminar
		gate.resolve();
		await Promise.all([first, second]);
		expect(calls).toEqual(["PUT m2 👍", "DELETE m2"]);
		expect(reactionsOf(controller, "m2")).toBeUndefined();
	});

	it("a falha de um toque antigo não apaga a reação de um toque mais novo", async () => {
		const gate = deferred<void>();
		let puts = 0;
		const { controller } = setup({
			api: {
				setReaction: async () => {
					puts += 1;
					if (puts === 1) {
						await gate.promise;
						throw new ChatApiError("fora do ar", 503);
					}
				},
			},
		});
		await controller.open();
		const first = controller.react("m2", "👍");
		const second = controller.react("m2", "❤️");
		gate.resolve();
		await Promise.all([first, second]);
		expect(reactionsOf(controller, "m2")).toEqual([{ actor: "user", emoji: "❤️" }]);
	});

	it("erro do servidor desfaz a reação, avisa em frase simples e não vaza o texto técnico", async () => {
		const { controller } = setup({ api: { setReaction: async () => Promise.reject(new ChatApiError("prisma boom", 500)) } });
		await controller.open();
		await controller.react("m2", "🔥");
		expect(reactionsOf(controller, "m2")).toBeUndefined();
		expect(controller.getSnapshot().error).toBe("Não consegui reagir agora. Tente de novo.");
	});

	it("erro ao tirar a reação a devolve; a do bot não é tocada", async () => {
		const fetchPage: ChatApi["fetchPage"] = async () => ({
			messages: [{ ...row("m1", "user", "valeu"), reactions: [{ actor: "bot", emoji: "❤️" }, { actor: "user", emoji: "👍" }] } as SessionMessage],
			hasMore: false,
		});
		const { controller } = setup({ api: { fetchPage, clearReaction: async () => Promise.reject(new ChatApiError("x", 503)) } });
		await controller.open();
		await controller.react("m1", "👍");
		expect(reactionsOf(controller, "m1")).toEqual([{ actor: "bot", emoji: "❤️" }, { actor: "user", emoji: "👍" }]);
	});

	it("sessão expirada ao reagir chama o logout", async () => {
		const { controller, calls } = setup({ api: { setReaction: async () => Promise.reject(new ChatApiError("no", 401)) } });
		await controller.open();
		await controller.react("m2", "🔥");
		expect(calls.unauthorized).toBe(1);
	});

	it("mensagem que não está na lista (ou ao vivo) não chama o servidor", async () => {
		const { controller, calls } = setup();
		await controller.open();
		await controller.react("msg-1-abc", "🔥");
		expect(calls.reaction).toEqual([]);
	});

	it("marcar como não lida chama a conversa e devolve true; erro devolve false com aviso", async () => {
		const ok = setup();
		await ok.controller.open();
		expect(await ok.controller.markUnread()).toBe(true);
		expect(ok.calls.unread).toEqual(["c1"]);
		const bad = setup({ api: { markConversationUnread: async () => Promise.reject(new ChatApiError("x", 500)) } });
		await bad.controller.open();
		expect(await bad.controller.markUnread()).toBe(false);
		expect(bad.controller.getSnapshot().error).toBe("Não consegui marcar como não lida agora. Tente de novo.");
	});

	it("sem conversa ainda não há o que marcar", async () => {
		const { controller, calls } = setup({ conversationId: null });
		await controller.open();
		expect(await controller.markUnread()).toBe(false);
		expect(calls.unread).toEqual([]);
	});
});

describe("responder (replyTo)", () => {
	const quote = { id: "m2", role: "assistant" as const, text: "olá, tudo bem por aí?" };
	const hang = async () => new Promise<FollowResult>(() => undefined);
	const bubbles = (controller: ChatController) => controller.getSnapshot().live.items.filter((item) => item.kind === "user");

	it("run novo: o createRun leva o id da mensagem e o balão otimista já mostra a citação", async () => {
		const { controller, calls } = setup({ follow: hang });
		await controller.open();
		controller.send("valeu", quote);
		expect(bubbles(controller)[0]).toMatchObject({ text: "valeu", replyTo: quote });
		await flush();
		expect(calls.createRun[0]).toMatchObject({ content: "valeu", replyToMessageId: "m2" });
	});

	it("sem citação o corpo do run fica idêntico ao de hoje (nem a chave aparece)", async () => {
		const { controller, calls } = setup({ follow: hang });
		await controller.open();
		controller.send("oi");
		await flush();
		expect(Object.keys(calls.createRun[0] as object)).not.toContain("replyToMessageId");
		expect(bubbles(controller)[0]).not.toHaveProperty("replyTo");
	});

	it("run vivo: entra nele (join) com o id da mensagem", async () => {
		const { controller, calls } = setup({ follow: hang });
		await controller.open();
		controller.send("primeiro");
		await flush();
		await flush();
		controller.send("e sobre isso?", quote);
		await flush();
		expect(calls.createRunInput).toEqual([["r1", "e sobre isso?"]]);
		expect(calls.inputReplies).toEqual(["m2"]);
	});

	it("o run terminou entre o toque e o envio (409 do join): cai no run novo e guarda a citação", async () => {
		const { controller, calls } = setup({ api: { createRunInput: async () => Promise.reject(new ChatApiError("run terminou", 409)) }, follow: hang });
		await controller.open();
		controller.send("primeiro");
		await flush();
		await flush();
		controller.send("segundo", quote);
		await flush();
		await flush();
		expect(calls.createRun).toHaveLength(2);
		expect(calls.createRun[1]).toMatchObject({ content: "segundo", replyToMessageId: "m2" });
		expect(Object.keys(calls.createRun[0] as object)).not.toContain("replyToMessageId");
	});

	it("conversa ocupada (409 ao criar): as tentativas repetem a citação", async () => {
		let attempt = 0;
		const seen: unknown[] = [];
		const { controller } = setup({
			api: {
				createRun: async (input) => {
					attempt += 1;
					seen.push(input);
					if (attempt < 3) throw new ChatApiError("A conversa já tem uma tarefa em andamento. Espere.", 409);
					return { runId: "r1", status: "queued" };
				},
			},
			follow: hang,
		});
		await controller.open();
		controller.send("oi", quote);
		await flush();
		await flush();
		expect(seen).toHaveLength(3);
		for (const input of seen) expect(input).toMatchObject({ replyToMessageId: "m2" });
	});

	it("fila: cada fala enfileirada mantém a própria citação (e a sem citação segue sem)", async () => {
		const gate = deferred<{ runId: string | null; status: string }>();
		const { controller, calls } = setup({ api: { createRun: () => gate.promise }, follow: hang });
		await controller.open();
		controller.send("um");
		await flush();
		controller.send("dois", quote);
		controller.send("três");
		controller.send("quatro", { id: "m1", role: "user", text: "oi" });
		gate.resolve({ runId: "r9", status: "queued" });
		await flush();
		await flush();
		expect(calls.createRunInput).toEqual([["r9", "dois"], ["r9", "três"], ["r9", "quatro"]]);
		expect(calls.inputReplies).toEqual(["m2", undefined, "m1"]);
	});

	it("fila sem run (o bot só reagiu): a primeira da fila vira envio normal com a citação", async () => {
		const gate = deferred<{ runId: string | null; status: string }>();
		let created = 0;
		const { controller, calls } = setup({
			api: {
				createRun: async (input) => {
					created += 1;
					calls.createRun.push(input);
					return created === 1 ? gate.promise : { runId: null, status: "done" };
				},
			},
			follow: hang,
		});
		await controller.open();
		controller.send("um");
		await flush();
		controller.send("dois", quote);
		gate.resolve({ runId: null, status: "done" });
		await flush();
		await flush();
		expect(calls.createRun[1]).toMatchObject({ content: "dois", replyToMessageId: "m2" });
	});

	it("falha no envio tira o balão com a citação da tela", async () => {
		const { controller } = setup({ api: { createRun: async () => Promise.reject(new ChatApiError("x", 500)) } });
		await controller.open();
		controller.send("oi", quote);
		await flush();
		await flush();
		expect(bubbles(controller)).toEqual([]);
	});
});

describe("cards do motor v4", () => {
	const approval = { type: "approval_request", requestId: "req-1", callId: "call-1", toolName: "checkout", effect: "money", args: {}, riskFacts: { amount: 109.8, currency: "BRL", merchant: "loja.test" }, ownerInput: "card_cvv", runId: "run-1" } as const;
	const approvalItem = (settled?: boolean): Extract<ChatItem, { kind: "agent-card" }> => ({ id: "c", kind: "agent-card", card: approval, ...(settled ? { settled } : {}) });
	const ask: Extract<ChatItem, { kind: "agent-card" }> = { id: "q", kind: "agent-card", card: { type: "ask_owner", cardId: "run-1:k1", question: "Qual capa?", runId: "run-1" } };

	it("aprovar com o CVV chama a API uma vez, com o código só no corpo, e segue o run retomado", async () => {
		const followed: string[] = [];
		const { controller, calls } = setup({ follow: async (_options, _id) => (followed.push("x"), new Promise<FollowResult>(() => undefined)) });
		await controller.open();
		controller.respondToRequest(approvalItem(), "approve", "123");
		controller.respondToRequest(approvalItem(), "approve", "123");
		await flush();
		expect(calls.requests).toEqual([{ runId: "run-1", key: "req-1", decision: "approve", cvv: "123" }]);
		expect(followed).toHaveLength(1);
		// o código não fica em estado, snapshot nem na visão que a tela lê
		expect(JSON.stringify(controller.getSnapshot())).not.toContain("123");
		expect(JSON.stringify(view(controller))).not.toContain("123");
		expect(controller.getSnapshot().agentDecisions).toEqual({ "approval_request|run-1|req-1": "approved" });
	});

	it("falha ao enviar libera o card e avisa em linguagem simples; pedido vencido fecha o card", async () => {
		let attempt = 0;
		const { controller } = setup({
			api: {
				respondRequest: async () => {
					attempt += 1;
					if (attempt === 1) throw new ChatApiError("payment_unavailable", 503);
					if (attempt === 2) throw new ChatApiError("expired", 410);
					return { ok: true, status: "recorded", resumed: false, pending: 1 };
				},
			},
		});
		await controller.open();
		controller.respondToRequest(approvalItem(), "approve", "123");
		await flush();
		expect(controller.getSnapshot().agentDecisions).toEqual({});
		expect(controller.getSnapshot().error).toBe("O envio não está disponível agora. Nada foi aprovado nem cobrado.");
		controller.respondToRequest(approvalItem(), "approve", "123");
		await flush();
		expect(controller.getSnapshot().error).toBe("O pedido passou do prazo. Peça de novo ao bot.");
		expect(Object.values(controller.getSnapshot().agentDecisions)).toEqual(["dismissed"]);
	});

	it("com o CVV, falha passageira NÃO repete o envio: libera o card e pede para digitar o código de novo", async () => {
		const sent: Array<string | undefined> = [];
		let attempt = 0;
		const { controller } = setup({
			api: {
				respondRequest: async (input) => {
					sent.push(input.cvv);
					attempt += 1;
					if (attempt === 1) throw new ChatApiError("run_not_paused", 409);
					if (attempt === 2) throw new TypeError("Network request failed");
					return { ok: true, status: "recorded", resumed: true };
				},
			},
			follow: async () => new Promise<FollowResult>(() => undefined),
		});
		await controller.open();
		controller.respondToRequest(approvalItem(), "approve", "123");
		await flush();
		await flush();
		expect(sent).toEqual(["123"]);
		expect(controller.getSnapshot().agentDecisions).toEqual({});
		expect(controller.getSnapshot().error).toBe("Não deu para enviar o código agora. Nada foi cobrado. Digite o código de novo.");
		// Falha de rede: também uma tentativa só; o código foi digitado de novo pelo dono na segunda.
		controller.respondToRequest(approvalItem(), "approve", "456");
		await flush();
		expect(sent).toEqual(["123", "456"]);
		expect(controller.getSnapshot().error).toBe("Não deu para enviar o código agora. Nada foi cobrado. Digite o código de novo.");
		expect(JSON.stringify(controller.getSnapshot())).not.toMatch(/123|456/);
		// Na terceira, o dono digita de novo e vai.
		controller.respondToRequest(approvalItem(), "approve", "789");
		await flush();
		expect(sent).toEqual(["123", "456", "789"]);
		expect(controller.getSnapshot().error).toBeNull();
	});

	it("run que ainda não estacionou (409 run_not_paused) repete o mesmo pedido (sem CVV)", async () => {
		let attempt = 0;
		const { controller } = setup({
			api: {
				respondRequest: async () => {
					attempt += 1;
					if (attempt < 3) throw new ChatApiError("run_not_paused", 409);
					return { ok: true, status: "recorded", resumed: true };
				},
			},
			follow: async () => new Promise<FollowResult>(() => undefined),
		});
		await controller.open();
		controller.respondToRequest(approvalItem(), "deny");
		await flush();
		await flush();
		expect(attempt).toBe(3);
		expect(controller.getSnapshot().error).toBeNull();
	});

	it("com outros pedidos pendentes (pending) o run não é seguido de novo", async () => {
		const followed: string[] = [];
		const { controller } = setup({ api: { respondRequest: async () => ({ ok: true, status: "recorded", resumed: false, pending: 1 }) }, follow: async () => (followed.push("x"), new Promise<FollowResult>(() => undefined)) });
		await controller.open();
		controller.respondToRequest(approvalItem(), "deny");
		await flush();
		expect(followed).toHaveLength(0);
	});

	it("card já resolvido, ou de outro tipo, não envia nada", async () => {
		const { controller, calls } = setup();
		await controller.open();
		controller.respondToRequest(approvalItem(true), "approve", "123");
		controller.respondToRequest(ask, "approve");
		await flush();
		expect(calls.requests).toEqual([]);
	});

	it("o card só pede o dono com o run dele parado esperando", async () => {
		const { controller } = setup({ follow: async (options) => (options.onEvent({ type: "run", runId: "run-1", status: "running" }), options.onEvent(approval as never), options.onEvent({ type: "paused" }), "boundary" as const) });
		await controller.open();
		await controller.follow("run-1");
		await flush();
		const card = view(controller).items.find((item) => item.kind === "agent-card");
		expect(card).toMatchObject({ kind: "agent-card", settled: false });
		controller.respondToRequest(card as never, "deny");
		await flush();
		expect(view(controller).items.find((item) => item.kind === "agent-card")).toMatchObject({ decision: "denied" });
		// card de um run que não está parado (histórico): sem botões
		expect(view(setup().controller).items).toEqual([]);
	});

	it("pergunta do bot: marca o card respondido e o texto segue como fala da conversa", async () => {
		const { controller, calls } = setup({ follow: async () => new Promise<FollowResult>(() => undefined) });
		await controller.open();
		controller.answerAgentCard(ask, "  Capa dura  ");
		controller.answerAgentCard(ask, "Capa dura");
		await flush();
		await flush();
		expect(calls.cards).toEqual([["run-1:k1", "answered"]]);
		expect(calls.createRun).toHaveLength(1);
		expect(calls.createRun[0]).toMatchObject({ content: "Capa dura" });
	});

	it("pergunta: se o servidor recusar, a fala não é enviada e o card volta a pedir", async () => {
		const { controller, calls } = setup({ api: { respondCard: async () => Promise.reject(new ChatApiError("conflict", 409)) } });
		await controller.open();
		controller.answerAgentCard(ask, "Capa dura");
		await flush();
		expect(calls.createRun).toHaveLength(0);
		expect(controller.getSnapshot().agentDecisions).toEqual({});
		expect(controller.getSnapshot().error).toBe("Este pedido já foi respondido.");
	});

	it("pergunta: 'Agora não' só marca dispensada; resposta vazia ou longa demais é ignorada", async () => {
		const { controller, calls } = setup();
		await controller.open();
		controller.dismissAgentCard(ask);
		controller.answerAgentCard({ ...ask, id: "q2", card: { ...ask.card, cardId: "run-1:k2" } as never }, "   ");
		controller.answerAgentCard({ ...ask, id: "q3", card: { ...ask.card, cardId: "run-1:k3" } as never }, "x".repeat(8_001));
		await flush();
		expect(calls.cards).toEqual([["run-1:k1", "dismissed"]]);
		expect(calls.createRun).toHaveLength(0);
	});

	it("pergunta antiga (o dono já falou depois) não pede mais", async () => {
		const { controller } = setup({ api: { fetchPage: async () => ({ messages: [row("a", "ask_owner", JSON.stringify({ type: "ask_owner", cardId: "run-1:k1", question: "Qual?", runId: "run-1" })), row("u", "user", "outra coisa", 1)], hasMore: false }) } });
		await controller.open();
		expect(view(controller).items.find((item) => item.kind === "agent-card")).toMatchObject({ settled: true });
	});
});
