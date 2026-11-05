import type { ComputerUseEvent, SessionMessage } from "@workspace/shared";
import { describe, expect, it } from "vitest";
import { ChatController, type ChatApi, type ChatDeps } from "./chat-controller";
import type { FollowOptions, FollowResult } from "./chat-stream";

const row = (id: string, role: string, content: string, minute = 0): SessionMessage => ({ id, conversationId: "c1", role, content, createdAt: `2026-11-01T10:0${minute}:00.000Z` }) as SessionMessage;
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Controlador com timers manuais (o debounce do canal) e um servidor cujas mensagens o teste controla. */
function setup(options: { follow?: (options: FollowOptions) => Promise<FollowResult>; createRunId?: string } = {}) {
	const server = { messages: [row("m1", "user", "oi"), row("m2", "assistant", "olá, tudo bem por aí?", 1)] };
	const calls = { fetchPage: 0, follows: [] as string[], activeRuns: 0 };
	let active: { id: string; status: string }[] = [];
	const timers: { id: number; fn: () => void; ms: number }[] = [];
	let nextTimer = 1;
	const api = {
		fetchPage: async () => (calls.fetchPage++, { messages: [...server.messages], hasMore: false }),
		createRun: async () => ({ runId: options.createRunId ?? "r-local", status: "queued" }),
		createRunInput: async () => undefined,
		cancelRun: async () => undefined,
		getRunStatus: async () => "running",
		listActiveRuns: async () => (calls.activeRuns++, active),
	} as unknown as ChatApi;
	const deps: ChatDeps = {
		api,
		openRunStream: (runId) => {
			calls.follows.push(runId);
			return async () => Promise.reject(new Error("não usado"));
		},
		cacheFor: () => null,
		onUnauthorized: () => undefined,
		follow: (options.follow ?? (() => new Promise<FollowResult>(() => undefined))) as never,
		sleep: async () => undefined,
		throttleMs: 0,
		setTimer: (fn, ms) => {
			const id = nextTimer++;
			timers.push({ id, fn, ms });
			return id;
		},
		clearTimer: (handle) => {
			const index = timers.findIndex((t) => t.id === handle);
			if (index >= 0) timers.splice(index, 1);
		},
	};
	const controller = new ChatController(deps, { id: "bot1", conversationId: "c1" });
	const fire = async () => {
		for (const t of timers.splice(0)) t.fn();
		await flush();
	};
	return {
		controller,
		calls,
		timers,
		fire,
		server,
		setActive: (runs: { id: string; status: string }[]) => {
			active = runs;
		},
	};
}

const message = (conversationId: unknown = "c1") => ({ type: "message", payload: { conversationId, messageId: "m3", role: "assistant", op: "created" } });
const run = (status: string, runId = "r-hub", extra: Record<string, unknown> = {}) => ({ type: "run", payload: { conversationId: "c1", runId, botId: "bot1", status, origin: "chat", ...extra } });

describe("ChatController: canal de eventos", () => {
	it("evento de outra conversa ou com id estranho é ignorado", async () => {
		const { controller, calls, timers } = setup();
		await controller.open();
		const before = calls.fetchPage;
		controller.onHubEvent(message("outra"));
		controller.onHubEvent(message(42));
		controller.onHubEvent(message("c1\n<script>"));
		controller.onHubEvent({ type: "run", payload: { conversationId: "outra", runId: "r9", status: "running" } });
		controller.onHubEvent({ type: "read", payload: { conversationId: "c1" } });
		expect(timers).toHaveLength(0);
		expect(calls.fetchPage).toBe(before);
		expect(calls.follows).toEqual([]);
	});

	it("message agenda uma conferência quieta (debounce) e mostra a mensagem nova sem acender o aviso", async () => {
		const { controller, calls, timers, fire, server } = setup();
		await controller.open();
		const before = calls.fetchPage;
		server.messages.push(row("m3", "assistant", "mensagem vinda de outro aparelho", 2));
		controller.onHubEvent(message());
		controller.onHubEvent(message());
		controller.onHubEvent(message());
		expect(timers).toHaveLength(1);
		expect(timers[0]!.ms).toBe(300);
		const phases: string[] = [];
		controller.subscribe(() => phases.push(controller.getSnapshot().sync.phase));
		await fire();
		expect(calls.fetchPage).toBe(before + 1);
		expect(controller.getSnapshot().persisted.map((item) => item.id)).toEqual(["m1", "m2", "m3"]);
		expect(phases.every((phase) => phase === "idle")).toBe(true);
	});

	it("não duplica: a mesma mensagem avisada duas vezes continua uma só", async () => {
		const { controller, fire, server } = setup();
		await controller.open();
		server.messages.push(row("m3", "assistant", "só uma vez", 2));
		controller.onHubEvent(message());
		await fire();
		controller.onHubEvent(message());
		await fire();
		expect(controller.getSnapshot().persisted.filter((item) => item.id === "m3")).toHaveLength(1);
	});

	it("run ativo de outra origem: segue o run uma vez só, mesmo com eventos repetidos", async () => {
		const { controller, calls } = setup();
		await controller.open();
		controller.onHubEvent(run("running"));
		controller.onHubEvent(run("running"));
		controller.onHubEvent(run("retrying"));
		await flush();
		expect(calls.follows).toEqual(["r-hub"]);
		expect(controller.getSnapshot().following).toBe(true);
	});

	it("run de subagente e status parado/terminal não abrem stream; terminal confere o fio", async () => {
		const { controller, calls, timers } = setup();
		await controller.open();
		controller.onHubEvent(run("running", "r-sub", { origin: "subagent" }));
		expect(calls.follows).toEqual([]);
		expect(timers).toHaveLength(0);
		controller.onHubEvent(run("waiting_user"));
		controller.onHubEvent(run("completed"));
		expect(calls.follows).toEqual([]);
		expect(timers).toHaveLength(1);
	});

	it("com stream local em curso o canal não confere nem abre outro stream (o finishRun cobre o fim)", async () => {
		const { controller, calls, timers } = setup({ follow: () => new Promise<FollowResult>(() => undefined) });
		await controller.open();
		controller.send("oi, bot");
		await flush();
		expect(calls.follows).toEqual(["r-local"]);
		const before = calls.fetchPage;
		controller.onHubEvent(run("running", "r-local"));
		controller.onHubEvent(run("running", "r-outro"));
		controller.onHubEvent(message());
		expect(timers).toHaveLength(0);
		expect(calls.follows).toEqual(["r-local"]);
		expect(calls.fetchPage).toBe(before);
	});

	it("durante o envio (criando o run) o aviso do run não abre stream paralelo", async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const { controller, calls } = setup();
		// o createRun do cenário responde na hora; aqui basta um envio em andamento
		(controller as unknown as { state: { creating: boolean } }).state.creating = true;
		controller.onHubEvent(run("queued", "r-local"));
		release();
		await gate;
		expect(calls.follows).toEqual([]);
	});

	it("fechar o chat cancela a conferência marcada", async () => {
		const { controller, calls, timers, fire } = setup();
		await controller.open();
		const before = calls.fetchPage;
		controller.onHubEvent(message());
		controller.dispose();
		expect(timers).toHaveLength(0);
		await fire();
		expect(calls.fetchPage).toBe(before);
	});

	it("ready/resync (ou o poll do plano B) refaz o fio e segue run ativo que não estava sendo seguido", async () => {
		const { controller, calls, server, setActive } = setup();
		await controller.open();
		server.messages.push(row("m3", "assistant", "chegou enquanto o app dormia", 2));
		setActive([{ id: "r-ativo", status: "running" }]);
		await controller.onHubResync();
		await flush();
		expect(controller.getSnapshot().persisted.map((item) => item.id)).toEqual(["m1", "m2", "m3"]);
		expect(calls.follows).toEqual(["r-ativo"]);
		// chamar de novo com o run já seguido não abre outro
		await controller.onHubResync();
		expect(calls.follows).toEqual(["r-ativo"]);
	});

	it("o fim do run seguido pelo canal confere o fio (finishRun) e solta o stream", async () => {
		const done: ComputerUseEvent = { type: "done", message: { role: "assistant", content: "" }, model: "m" };
		const { controller, calls, server } = setup({
			follow: async (options) => {
				options.onEvent(done);
				return "boundary";
			},
		});
		await controller.open();
		const before = calls.fetchPage;
		server.messages.push(row("m3", "assistant", "resposta final do run externo", 2));
		controller.onHubEvent(run("running"));
		await flush();
		await flush();
		expect(calls.fetchPage).toBeGreaterThan(before);
		expect(controller.getSnapshot().following).toBe(false);
		expect(controller.getSnapshot().persisted.map((item) => item.id)).toContain("m3");
	});
});
