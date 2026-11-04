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

function setup(overrides: { api?: Partial<ChatApi>; follow?: Script; conversationId?: string | null; cache?: ChatDeps["cacheFor"]; deps?: Partial<ChatDeps>; connect?: ChatDeps["connect"] } = {}) {
	let runCount = 0;
	const calls = { createRun: [] as unknown[], createRunInput: [] as Array<[string, string]>, cancelRun: [] as string[], submit: [] as unknown[], reaction: [] as string[], unread: [] as string[], inputReplies: [] as Array<string | undefined>, resume: [] as Array<[string, unknown]>, proposal: [] as unknown[], profile: [] as unknown[], created: [] as unknown[], applied: [] as unknown[], fetchPage: [] as string[], createConversation: 0, unauthorized: 0 };
	const api: ChatApi = {
		fetchPage: async (conversationId) => (calls.fetchPage.push(conversationId), { messages: [row("m1", "user", "oi"), row("m2", "assistant", "olá, tudo bem por aí?", 1)], hasMore: false }),
		createConversation: async () => (calls.createConversation++, "c-new"),
		createRun: async (input) => (calls.createRun.push(input), { runId: `r${++runCount}`, status: "queued" }),
		createRunInput: async (runId, content, _key, replyToMessageId) => void (calls.createRunInput.push([runId, content]), calls.inputReplies.push(replyToMessageId)),
		cancelRun: async (runId) => void calls.cancelRun.push(runId),
		getRunStatus: async () => "running",
		listActiveRuns: async () => [],
		submitQuestionnaire: async (input) => (calls.submit.push(input), { runId: `r${++runCount}` }),
		setReaction: async (messageId, emoji) => void calls.reaction.push(`PUT ${messageId} ${emoji}`),
		clearReaction: async (messageId) => void calls.reaction.push(`DELETE ${messageId}`),
		markConversationUnread: async (conversationId) => void calls.unread.push(conversationId),
		compactConversation: async () => ({ status: "noop", reason: "too_small", message: "Conversa curta." }),
		resolveBotProposal: async (input) => (calls.proposal.push(input), { status: input.decision, name: "Estoquinho", botId: input.decision === "approved" ? "bot-new" : null, unchanged: false, warnings: [] }),
		resolveBotProfile: async (input) => (calls.profile.push(input), { status: input.decision, fields: ["name"] }),
		resumeRun: async (runId, options) => (calls.resume.push([runId, options]), { enqueued: true }),
		...overrides.api,
	};
	let seq = 0;
	const deps: ChatDeps = {
		api,
		openRunStream: () => async () => Promise.reject(new Error("não usado")),
		cacheFor: overrides.cache ?? (() => null),
		onUnauthorized: () => void calls.unauthorized++,
		...(overrides.connect ? { connect: overrides.connect } : {}),
		follow: ((options: FollowOptions) => (overrides.follow ?? (async (opts) => (opts.onEvent(done), "boundary" as const)))(options, "?")) as never,
		sleep: async () => undefined,
		clientKey: () => `k${++seq}`,
		throttleMs: 0,
		onBotCreated: (bot) => void calls.created.push(bot),
		onProfileApplied: (botId, patch) => void calls.applied.push([botId, patch]),
		...overrides.deps,
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

describe("modelo do run (seletor do composer)", () => {
	it("o envio leva os campos de modelo da escolha de agora; sem escolha o run não diz nada de modelo", async () => {
		let fields: Record<string, unknown> = {};
		const { controller, calls } = setup({ deps: { modelFields: () => fields } });
		await controller.open();
		controller.send("sem escolha");
		await flush();
		expect(calls.createRun[0]).toMatchObject({ model: {} });
		fields = { model: "x/y", reasoningEffort: "high" };
		controller.send("com escolha");
		await flush();
		expect(calls.createRun[1]).toMatchObject({ model: { model: "x/y", reasoningEffort: "high" } });
	});
	it("chat novo: a conversa criada pelo envio é avisada (a escolha feita antes passa a ser salva nela)", async () => {
		const created: string[] = [];
		const { controller, calls } = setup({ conversationId: null, deps: { modelFields: () => ({ modelAuto: true }), onConversationCreated: (id) => void created.push(id) } });
		await controller.open();
		controller.send("primeira");
		await flush();
		expect(created).toEqual(["c-new"]);
		expect(calls.createRun[0]).toMatchObject({ conversationId: "c-new", model: { modelAuto: true } });
	});
	it("modelo recusado pelo servidor: apaga a escolha, avisa e NÃO reenvia com outro modelo", async () => {
		let rejected = 0;
		let attempts = 0;
		const { controller } = setup({
			api: { createRun: async () => (attempts++, Promise.reject(new ChatApiError("Modelo ChatGPT indisponível nesta conta", 400))) },
			deps: { modelFields: () => ({ model: "chatgpt/luna" }), onModelRejected: () => void rejected++ },
		});
		await controller.open();
		controller.send("oi");
		await flush();
		expect(rejected).toBe(1);
		expect(attempts).toBe(1);
		expect(controller.getSnapshot().error).toContain("voltei ao modelo do bot");
	});
	it("recusa sem modelo enviado não mexe na escolha", async () => {
		let rejected = 0;
		const { controller } = setup({
			api: { createRun: async () => Promise.reject(new ChatApiError("Modelo inválido", 400)) },
			deps: { modelFields: () => ({}), onModelRejected: () => void rejected++ },
		});
		await controller.open();
		controller.send("oi");
		await flush();
		expect(rejected).toBe(0);
	});
	it("conversa que já existe não dispara o aviso", async () => {
		const created: string[] = [];
		const { controller } = setup({ deps: { onConversationCreated: (id) => void created.push(id) } });
		await controller.open();
		controller.send("oi");
		await flush();
		expect(created).toEqual([]);
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

describe("cartões de pedido: login e segredo", () => {
	const login: Extract<ChatItem, { kind: "login" }> = { id: "l", kind: "login", loginId: "lg1", site: "github.com", url: "https://github.com/login", runId: "r9", status: "pending" };
	it("retoma o run parado uma vez só e já mostra o login como resolvido", async () => {
		const { controller, calls } = setup({ api: { getRunStatus: async () => "paused" }, follow: async () => new Promise<FollowResult>(() => undefined) });
		await controller.open();
		controller.resumeLogin(login);
		controller.resumeLogin(login, { via: "vault" });
		await flush();
		expect(calls.resume).toEqual([["r9", {}]]);
		expect(controller.getSnapshot().loginsDone).toEqual({ lg1: true });
	});
	it("o código segue ao servidor no resume (nunca vira fala nem input)", async () => {
		const { controller, calls } = setup({ api: { getRunStatus: async () => "paused" }, follow: async () => new Promise<FollowResult>(() => undefined) });
		await controller.open();
		controller.resumeLogin(login, { via: "code", code: "123456" });
		await flush();
		expect(calls.resume).toEqual([["r9", { via: "code", code: "123456" }]]);
		expect(calls.createRun).toHaveLength(0);
		expect(calls.createRunInput).toHaveLength(0);
	});
	it("o run que já voltou sozinho só é acompanhado, sem novo resume", async () => {
		const { controller, calls } = setup({ api: { getRunStatus: async () => "running" }, follow: async () => new Promise<FollowResult>(() => undefined) });
		await controller.open();
		controller.resumeLogin(login);
		await flush();
		expect(calls.resume).toEqual([]);
		expect(controller.getSnapshot().following).toBe(true);
	});
	it("falha ao retomar libera o cartão e avisa em palavras simples; 401 encerra a sessão", async () => {
		const { controller, calls } = setup({ api: { getRunStatus: async () => "paused", resumeRun: async () => { throw new ChatApiError("x", 401); } } });
		await controller.open();
		controller.resumeLogin(login);
		await flush();
		expect(controller.getSnapshot().loginsDone).toEqual({});
		expect(calls.unauthorized).toBe(1);
		expect(controller.getSnapshot().error).toMatch(/sessão/i);
	});
	it("sem o run do cartão e sem run seguido, não finge: avisa e libera", async () => {
		const { controller } = setup();
		await controller.open();
		controller.resumeLogin({ ...login, runId: undefined });
		await flush();
		expect(controller.getSnapshot().loginsDone).toEqual({});
		expect(controller.getSnapshot().error).toBeTruthy();
	});
	it("segredo salvo é aprovado pelo mesmo caminho da aprovação, sem balão do usuário", async () => {
		const { controller, calls } = setup({ follow: async () => new Promise<FollowResult>(() => undefined) });
		await controller.open();
		controller.decide({ confirmId: "s1", title: "Chave da API", status: "pending" }, true);
		await flush();
		expect(calls.createRun[0]).toMatchObject({ content: "confirmado: Chave da API", decisionConfirmId: "s1" });
	});
	it("o login e o segredo resolvidos aqui valem na hora na tela", async () => {
		const { controller } = setup({ api: { getRunStatus: async () => "paused" }, follow: async () => new Promise<FollowResult>(() => undefined) });
		await controller.open();
		controller.resumeLogin(login);
		controller.decide({ confirmId: "s1", title: "x", status: "pending" }, false);
		const snapshot = controller.getSnapshot();
		const items = deriveView({ ...snapshot, persisted: [login, { id: "s", kind: "secrets", confirmId: "s1", title: "x", names: ["A"], status: "pending" }] }).items;
		expect(items.find((item) => item.kind === "login")).toMatchObject({ status: "done" });
		expect(items.find((item) => item.kind === "secrets")).toMatchObject({ status: "rejected" });
	});
});

describe("conectar app: o fluxo é do controller, não do cartão", () => {
	const connector = { kind: "composio", id: "gmail", name: "Gmail", description: "", icon: null } as const;
	const login: Extract<ChatItem, { kind: "login" }> = { id: "l", kind: "login", loginId: "lg1", site: "Gmail", url: "https://x.com", runId: "r9", status: "pending", connector };
	const paused = { getRunStatus: async () => "paused" };
	it("conectou: retoma o run sem nenhum cartão montado (nada na tela chama o resume)", async () => {
		const gate = deferred<{ outcome: "connected" }>();
		const { controller, calls } = setup({ api: paused, connect: () => gate.promise, follow: async () => new Promise<FollowResult>(() => undefined) });
		await controller.open();
		controller.connectLogin(login);
		controller.connectLogin(login);
		expect(controller.getSnapshot().connects.lg1).toEqual({ busy: true, message: null });
		// o cartão pode desmontar aqui: o fluxo segue
		gate.resolve({ outcome: "connected" });
		await flush();
		expect(calls.resume).toEqual([["r9", {}]]);
		expect(controller.getSnapshot().connects).toEqual({});
		expect(controller.getSnapshot().loginsDone).toEqual({ lg1: true });
	});
	it("navegador fechado ou tempo esgotado: libera o botão com aviso simples e não retoma", async () => {
		const { controller, calls } = setup({ api: paused, connect: async () => ({ outcome: "closed" }) });
		await controller.open();
		controller.connectLogin(login);
		await flush();
		expect(calls.resume).toEqual([]);
		expect(controller.getSnapshot().connects.lg1).toMatchObject({ busy: false, message: expect.stringContaining("Autorizar") });
	});
	it("erro de conexão vira a frase dada; conector de API/MCP próprio não conecta aqui", async () => {
		const { controller } = setup({ connect: async () => ({ error: "Ative os apps nas Configurações do site." }) });
		await controller.open();
		controller.connectLogin(login);
		await flush();
		expect(controller.getSnapshot().connects.lg1).toEqual({ busy: false, message: "Ative os apps nas Configurações do site." });
		const calls: unknown[] = [];
		const other = setup({ connect: async () => (calls.push(1), { outcome: "connected" }) });
		await other.controller.open();
		other.controller.connectLogin({ ...login, connector: { ...connector, kind: "api" } });
		await flush();
		expect(calls).toEqual([]);
	});
	it("sair do chat aborta o fluxo (o sinal do navegador) e não retoma depois", async () => {
		const gate = deferred<{ outcome: "connected" }>();
		let seen: { aborted: boolean } | null = null;
		const { controller, calls } = setup({ api: paused, connect: (_connector, signal) => ((seen = signal), gate.promise) });
		await controller.open();
		controller.connectLogin(login);
		controller.dispose();
		expect(seen!.aborted).toBe(true);
		gate.resolve({ outcome: "connected" });
		await flush();
		expect(calls.resume).toEqual([]);
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

describe("/compact", () => {
	const compacted = { status: "compacted" as const, before: 48_200, after: 6_100, percent: 87, messageId: "cmp-1", card: { v: 1 as const, kind: "compaction" as const, before: 48_200, after: 6_100, summary: "resumo" } };
	it("compacta a conversa atual e põe o marcador no fim do fio (uma vez, mesmo com toque duplo)", async () => {
		const asked: Array<[string, string | undefined]> = [];
		const { controller } = setup({ api: { compactConversation: async (id, focus) => (asked.push([id, focus]), compacted) } });
		await controller.open();
		const [first, second] = await Promise.all([controller.compact("foco"), controller.compact("foco")]);
		expect([first, second]).toEqual([true, false]);
		expect(asked).toEqual([["c1", "foco"]]);
		const items = controller.getSnapshot().persisted;
		expect(items[items.length - 1]).toMatchObject({ id: "cmp-1", kind: "marker", text: "Conversa compactada · 48,2 mil → 6,1 mil" });
		await controller.compact();
		expect(controller.getSnapshot().persisted.filter((item) => item.id === "cmp-1")).toHaveLength(1);
	});
	it("enquanto o servidor compacta, o estado diz `compacting` (a tela mostra \"Compactando a conversa…\"); ao terminar, volta", async () => {
		let finish: (value: typeof compacted) => void = () => undefined;
		const { controller } = setup({ api: { compactConversation: () => new Promise((resolve) => (finish = resolve)) } });
		await controller.open();
		expect(controller.getSnapshot().compacting).toBe(false);
		const running = controller.compact();
		expect(controller.getSnapshot().compacting).toBe(true);
		finish(compacted);
		await running;
		expect(controller.getSnapshot().compacting).toBe(false);
	});
	it("conversa curta: aviso do servidor, sem marcador", async () => {
		const { controller } = setup();
		await controller.open();
		expect(await controller.compact()).toBe(false);
		expect(controller.getSnapshot().error).toBe("Conversa curta.");
		expect(controller.getSnapshot().persisted.some((item) => item.kind === "marker")).toBe(false);
	});
	it("recusa do servidor: mensagem dele; proxy ou rede: aviso amigável", async () => {
		const busy = setup({ api: { compactConversation: async () => Promise.reject(new ChatApiError("Há uma execução em andamento.", 409, true)) } });
		await busy.controller.open();
		await busy.controller.compact();
		expect(busy.controller.getSnapshot().error).toBe("Há uma execução em andamento.");
		const proxy = setup({ api: { compactConversation: async () => Promise.reject(new ChatApiError("Bad Gateway", 502)) } });
		await proxy.controller.open();
		await proxy.controller.compact();
		expect(proxy.controller.getSnapshot().error).toBe("Não consegui compactar a conversa agora. Tente de novo em instantes.");
	});
	it("sem conversa ainda: aviso, sem chamar o servidor", async () => {
		let called = 0;
		const { controller } = setup({ conversationId: null, api: { compactConversation: async () => (called++, compacted) } });
		await controller.open();
		expect(await controller.compact()).toBe(false);
		expect(called).toBe(0);
		expect(controller.getSnapshot().error).toBe("Ainda não há o que compactar nesta conversa.");
	});
});

describe("cartões de proposta (criar agente e perfil)", () => {
	const proposal: Extract<ChatItem, { kind: "bot-proposal" }> = { id: "m9", kind: "bot-proposal", proposalId: "p1", status: "pending", name: "Estoquinho", description: "Cuida do estoque", color: "#1084FE", shape: "blob", model: null, skills: [], firstTask: null };
	const profile: Extract<ChatItem, { kind: "bot-profile" }> = { id: "m8", kind: "bot-profile", proposalId: "pf1", botId: "bot1", status: "pending", fields: ["name"], before: { name: "Cookie", snippet: "", description: null, openRouterModel: null }, after: { name: "Biscoito" } };
	const cardOf = (controller: ChatController, kind: string) => view(controller).items.find((item) => item.kind === kind) as never as Record<string, unknown>;
	// a proposta ao vivo entra pelo estado ao vivo; aqui basta o gravado, que o deriveView já mostra
	const withCards = (api: Partial<ChatApi> = {}, deps: Partial<ChatDeps> = {}) =>
		setup({ api: { fetchPage: async () => ({ messages: [row("m9", "bot-proposal", JSON.stringify({ v: 1, kind: "bot-proposal", proposalId: "p1", status: "pending", name: "Estoquinho", description: "Cuida do estoque", color: "#1084FE", shape: "blob", model: null, skills: [], firstTask: null })), row("m8", "bot-profile", JSON.stringify({ v: 1, kind: "bot-profile", proposalId: "pf1", botId: "bot1", status: "pending", fields: ["name"], before: { name: "Cookie", snippet: "", description: null, openRouterModel: null }, after: { name: "Biscoito" } }), 1)], hasMore: false }), ...api }, deps });

	it("aprovar chama a rota uma vez só (toque duplo), mostra Criado e entrega o bot novo à home", async () => {
		const { controller, calls } = withCards();
		await controller.open();
		controller.resolveProposal(proposal, "approved");
		controller.resolveProposal(proposal, "approved");
		expect(cardOf(controller, "bot-proposal")).toMatchObject({ status: "pending", applying: true });
		await flush();
		expect(calls.proposal).toEqual([{ conversationId: "c1", proposalId: "p1", decision: "approved" }]);
		expect(cardOf(controller, "bot-proposal")).toMatchObject({ status: "approved", botId: "bot-new" });
		expect(calls.created).toEqual([expect.objectContaining({ id: "bot-new", name: "Estoquinho", color: "#1084FE", shape: "blob", conversationId: null })]);
		// depois de decidido, tocar de novo não faz nada
		controller.resolveProposal({ ...proposal, status: "approved" }, "approved");
		await flush();
		expect(calls.proposal).toHaveLength(1);
	});
	it("repetir a aprovação (unchanged) mostra Criado e ainda garante o bot na home", async () => {
		const { controller, calls } = withCards({ resolveBotProposal: async () => ({ status: "approved", name: "Estoquinho", botId: "bot-new", unchanged: true, warnings: [] }) });
		await controller.open();
		controller.resolveProposal(proposal, "approved");
		await flush();
		expect(cardOf(controller, "bot-proposal")).toMatchObject({ status: "approved", botId: "bot-new" });
		// o bot pode não estar na home (outro aparelho, atualização perdida): quem recebe garante (idempotente)
		expect(calls.created).toEqual([expect.objectContaining({ id: "bot-new" })]);
	});
	it("Agora não dispensa sem criar bot", async () => {
		const { controller, calls } = withCards();
		await controller.open();
		controller.resolveProposal(proposal, "rejected");
		await flush();
		expect(calls.proposal).toEqual([{ conversationId: "c1", proposalId: "p1", decision: "rejected" }]);
		expect(cardOf(controller, "bot-proposal")).toMatchObject({ status: "rejected" });
		expect(calls.created).toEqual([]);
	});
	it("404 e 409 travam os botões e recarregam o fio; rede e 503 deixam tentar de novo", async () => {
		for (const [error, text] of [
			[new ChatApiError("Proposta não encontrada.", 404), "Esta proposta não existe mais."],
			[new ChatApiError("x", 409), "Esta proposta já foi recusada."],
			[new Error("Network request failed"), "Sem conexão com o seu servidor. Tente de novo."],
			[new ChatApiError("x", 503), "Não consegui criar o agente. Tente de novo."],
		] as const) {
			let fail = true;
			let taps = 0;
			const { controller, calls } = withCards({ resolveBotProposal: async () => (taps++, fail ? Promise.reject(error) : { status: "approved", name: "Estoquinho", botId: "bot-new", unchanged: false, warnings: [] }) });
			await controller.open();
			controller.resolveProposal(proposal, "approved");
			await flush();
			expect(cardOf(controller, "bot-proposal")).toMatchObject({ status: "pending", error: text });
			expect(cardOf(controller, "bot-proposal").applying).toBeUndefined();
			expect(calls.created).toEqual([]);
			const stale = error instanceof ChatApiError && (error.status === 404 || error.status === 409);
			expect(cardOf(controller, "bot-proposal").locked === true).toBe(stale);
			fail = false;
			controller.resolveProposal(proposal, "approved");
			await flush();
			// travado (404/409): o toque não chama a rota de novo; os outros erros deixam tentar
			expect(cardOf(controller, "bot-proposal")).toMatchObject({ status: stale ? "pending" : "approved" });
			expect(taps).toBe(stale ? 1 : 2);
		}
	});
	it("404 e 409 recarregam o fio: o estado gravado (já decidido) substitui o cartão travado", async () => {
		let decided = false;
		const stored = (status: string) => row("m9", "bot-proposal", JSON.stringify({ v: 1, kind: "bot-proposal", proposalId: "p1", status, name: "Estoquinho", description: "Cuida do estoque", color: "#1084FE", shape: "blob", model: null, skills: [], firstTask: null, botId: "bot-9" }));
		const { controller } = setup({ api: { fetchPage: async () => ({ messages: [stored(decided ? "approved" : "pending")], hasMore: false }), resolveBotProposal: async () => Promise.reject(new ChatApiError("x", 409)) } });
		await controller.open();
		decided = true;
		controller.resolveProposal(proposal, "approved");
		await flush();
		expect(cardOf(controller, "bot-proposal")).toMatchObject({ status: "approved", botId: "bot-9" });
	});
	it("perfil: 404 (já resolvida) também trava", async () => {
		const failing = withCards({ resolveBotProfile: async () => Promise.reject(new ChatApiError("Proposal not found or already resolved", 404)) });
		await failing.controller.open();
		failing.controller.resolveProposal(profile, "approved");
		await flush();
		expect(cardOf(failing.controller, "bot-profile")).toMatchObject({ error: "Esta proposta não existe mais.", locked: true });
	});
	it("401 encerra a sessão", async () => {
		const { controller, calls } = withCards({ resolveBotProposal: async () => Promise.reject(new ChatApiError("x", 401)) });
		await controller.open();
		controller.resolveProposal(proposal, "approved");
		await flush();
		expect(calls.unauthorized).toBe(1);
	});
	it("sem conversa, avisa em vez de chamar a rota", async () => {
		const { controller, calls } = setup({ conversationId: null });
		await controller.open();
		controller.resolveProposal(proposal, "approved");
		expect(calls.proposal).toEqual([]);
	});
	it("perfil: Aplicar chama a rota do perfil e a home recebe o nome novo", async () => {
		const { controller, calls } = withCards();
		await controller.open();
		controller.resolveProposal(profile, "approved");
		controller.resolveProposal(profile, "approved");
		await flush();
		expect(calls.profile).toEqual([{ conversationId: "c1", proposalId: "pf1", decision: "approved" }]);
		expect(cardOf(controller, "bot-profile")).toMatchObject({ status: "approved" });
		expect(calls.applied).toEqual([["bot1", { name: "Biscoito" }]]);
	});
	it("perfil dispensado não muda a home; erro 404 usa a mesma frase", async () => {
		const { controller, calls } = withCards();
		await controller.open();
		controller.resolveProposal(profile, "rejected");
		await flush();
		expect(cardOf(controller, "bot-profile")).toMatchObject({ status: "rejected" });
		expect(calls.applied).toEqual([]);
		const failing = withCards({ resolveBotProfile: async () => Promise.reject(new ChatApiError("Proposal not found or already resolved", 404)) });
		await failing.controller.open();
		failing.controller.resolveProposal(profile, "approved");
		await flush();
		expect(cardOf(failing.controller, "bot-profile")).toMatchObject({ status: "pending", error: "Esta proposta não existe mais." });
	});
	it("o resultado local sobrevive a reabrir o fio (o gravado ainda pode chegar pendente)", async () => {
		const { controller } = withCards();
		await controller.open();
		controller.resolveProposal(proposal, "approved");
		await flush();
		await controller.open();
		expect(cardOf(controller, "bot-proposal")).toMatchObject({ status: "approved", botId: "bot-new" });
	});
});
