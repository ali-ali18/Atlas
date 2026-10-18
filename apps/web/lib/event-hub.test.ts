import assert from "node:assert/strict";
import test from "node:test";
import type { Message } from "@/components/ui/templates/template-4/data";
import {
	EventHub,
	HubAuthError,
	HubUnsupportedError,
	affectsBotList,
	type HubEvent,
	type HubFrame,
	type HubStatus,
	type HubTransport,
} from "./event-hub";
import { DEGRADED_POLL_MS, createFetchHubTransport, hubEnabled, parseHubBlock, pollModeFor, shouldPollTick } from "./event-hub-client";
import { applyServerTail, createThreadSync } from "./thread-sync";

// ---- infraestrutura de teste -------------------------------------------------------------------------------

type Request = { cursor: number | null; signal: AbortSignal; onFrame: (frame: HubFrame) => void };

/** Transporte controlável: cada conexão fica pendente até o teste fechar, falhar ou abortar. */
class FakeTransport {
	requests: Request[] = [];
	private settle: Array<{ resolve: () => void; reject: (error: unknown) => void }> = [];
	/** Respostas roteirizadas para as próximas conexões (para simular 404/401/erros). */
	script: Array<"hang" | { throw: unknown }> = [];
	transport: HubTransport = (request) => {
		this.requests.push(request);
		const next = this.script.shift();
		if (next && next !== "hang") return Promise.reject(next.throw);
		return new Promise<void>((resolve, reject) => {
			this.settle[this.requests.length - 1] = { resolve, reject };
			request.signal.addEventListener("abort", () => resolve(), { once: true });
		});
	};
	get last(): Request {
		return this.requests[this.requests.length - 1]!;
	}
	push(frame: HubFrame) {
		this.last.onFrame(frame);
	}
	event(seq: number, type: string, payload: Record<string, unknown> = {}) {
		this.push({ kind: "event", event: { seq, type, payload } });
	}
	closeLast() {
		this.settle[this.requests.length - 1]?.resolve();
	}
}

/** Relógio e timers manuais. */
class Clock {
	time = 1_000_000;
	private timers: Array<{ id: number; at: number; fn: () => void }> = [];
	private nextId = 1;
	now = () => this.time;
	setTimeout = (fn: () => void, ms: number) => {
		const id = this.nextId++;
		this.timers.push({ id, at: this.time + ms, fn });
		return id;
	};
	clearTimeout = (handle: unknown) => {
		this.timers = this.timers.filter((timer) => timer.id !== handle);
	};
	async advance(ms: number) {
		const target = this.time + ms;
		while (true) {
			const due = this.timers.filter((timer) => timer.at <= target).sort((a, b) => a.at - b.at)[0];
			if (!due) break;
			this.timers = this.timers.filter((timer) => timer !== due);
			this.time = Math.max(this.time, due.at);
			due.fn();
			await flush();
		}
		this.time = target;
		await flush();
	}
}

const flush = async () => {
	for (let i = 0; i < 6; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
};

function makeHub(options: { watchdogMs?: number; gapTimeoutMs?: number } = {}) {
	const transport = new FakeTransport();
	const clock = new Clock();
	const hub = new EventHub({
		transport: transport.transport,
		now: clock.now,
		setTimeout: clock.setTimeout,
		clearTimeout: clock.clearTimeout,
		random: () => 0.5,
		...options,
	});
	const events: HubEvent[] = [];
	const resyncs: string[] = [];
	const statuses: HubStatus[] = [];
	hub.subscribe((event) => events.push(event));
	hub.onResync((reason) => resyncs.push(reason));
	hub.onStatus((status) => statuses.push(status));
	return { hub, transport, clock, events, resyncs, statuses };
}

const seqs = (events: HubEvent[]) => events.map((event) => event.seq);

// ---- conexão, ordem, duplicados ---------------------------------------------------------------------------

test("conecta, ready dispara o primeiro snapshot e os eventos chegam na ordem do cursor", async () => {
	const { hub, transport, events, resyncs, statuses } = makeHub();
	hub.start();
	await flush();
	assert.equal(transport.requests.length, 1);
	assert.equal(transport.last.cursor, null);
	transport.push({ kind: "ready", head: 10 });
	transport.event(11, "message", { conversationId: "c1" });
	transport.event(12, "run", { conversationId: "c1", runId: "r1", status: "running" });
	assert.deepEqual(resyncs, ["ready"]);
	assert.deepEqual(seqs(events), [11, 12]);
	assert.equal(hub.getCursor(), 12);
	assert.equal(hub.getStatus(), "connected");
	assert.deepEqual(statuses, ["connecting", "connected"]);
	hub.stop();
	assert.equal(hub.getStatus(), "idle");
});

test("reconexão retoma pelo cursor e descarta o que o servidor reenviar", async () => {
	const { hub, transport, clock, events } = makeHub();
	hub.start();
	await flush();
	transport.push({ kind: "ready", head: 0 });
	transport.event(1, "message");
	transport.event(2, "message");
	transport.closeLast(); // servidor fechou
	await flush();
	await clock.advance(600); // atraso curto depois de uma conexão que funcionou
	assert.equal(transport.requests.length, 2);
	assert.equal(transport.last.cursor, 2);
	// o servidor reenvia o 2 (borda) e entrega o 3
	transport.event(2, "message");
	transport.event(3, "message");
	assert.deepEqual(seqs(events), [1, 2, 3]);
	hub.stop();
});

test("dois eventos fora de ordem: o adiantado espera e sai depois, na ordem", async () => {
	const { hub, transport, events } = makeHub();
	hub.start();
	await flush();
	transport.push({ kind: "ready", head: 0 });
	transport.event(1, "message");
	transport.event(3, "run", { status: "completed" });
	assert.deepEqual(seqs(events), [1]);
	transport.event(2, "message");
	assert.deepEqual(seqs(events), [1, 2, 3]);
	hub.stop();
});

test("evento que falta e não chega: reconecta e o servidor repete pelo cursor", async () => {
	const { hub, transport, clock, events } = makeHub({ gapTimeoutMs: 2_000 });
	hub.start();
	await flush();
	transport.push({ kind: "ready", head: 0 });
	transport.event(1, "message");
	transport.event(3, "message");
	await clock.advance(2_100);
	await clock.advance(400);
	assert.equal(transport.requests.length, 2);
	assert.equal(transport.last.cursor, 1);
	transport.event(2, "message");
	transport.event(3, "message");
	assert.deepEqual(seqs(events), [1, 2, 3]);
	hub.stop();
});

test("resync do servidor: avisa os assinantes e segue do fim", async () => {
	const { hub, transport, clock, events, resyncs } = makeHub();
	hub.start();
	await flush();
	transport.push({ kind: "ready", head: 5 });
	transport.closeLast();
	await flush();
	await clock.advance(600);
	assert.equal(transport.last.cursor, 5);
	transport.push({ kind: "resync", head: 900 }); // desconexão longa: cursor velho demais
	assert.deepEqual(resyncs, ["ready", "resync"]);
	assert.equal(hub.getCursor(), 900);
	transport.event(901, "message");
	assert.deepEqual(seqs(events), [901]);
	hub.stop();
});

// ---- watchdog, backoff, poke, suporte ---------------------------------------------------------------------

test("watchdog: conexão muda por 40 s é derrubada e reaberta pelo cursor", async () => {
	const { hub, transport, clock } = makeHub();
	hub.start();
	await flush();
	transport.push({ kind: "ready", head: 7 });
	await clock.advance(35_000);
	assert.equal(transport.requests.length, 1);
	await clock.advance(10_000);
	await clock.advance(500);
	assert.equal(transport.requests.length, 2);
	assert.equal(transport.last.cursor, 7);
	hub.stop();
});

test("keepalive (activity) mantém a conexão viva", async () => {
	const { hub, transport, clock } = makeHub();
	hub.start();
	await flush();
	transport.push({ kind: "ready", head: 1 });
	for (let i = 0; i < 6; i += 1) {
		await clock.advance(15_000);
		transport.push({ kind: "activity" });
	}
	assert.equal(transport.requests.length, 1);
	hub.stop();
});

test("falhas seguidas usam backoff crescente e o primeiro byte zera", async () => {
	const { hub, transport, clock } = makeHub();
	transport.script = [{ throw: new Error("net") }, { throw: new Error("net") }, { throw: new Error("net") }];
	hub.start();
	await flush();
	assert.equal(transport.requests.length, 1);
	await clock.advance(1_000); // backoff 1 s (random 0.5 => fator 1)
	assert.equal(transport.requests.length, 2);
	await clock.advance(1_500);
	assert.equal(transport.requests.length, 2); // o segundo espera 2 s
	await clock.advance(600);
	assert.equal(transport.requests.length, 3);
	await clock.advance(4_000);
	assert.equal(transport.requests.length, 4); // quarta conexão fica aberta
	transport.push({ kind: "ready", head: 1 });
	transport.closeLast();
	await flush();
	await clock.advance(600);
	assert.equal(transport.requests.length, 5); // voltou rápido: falhas zeradas
	hub.stop();
});

test("404 do endpoint: status unsupported, sem laço de tentativas", async () => {
	const { hub, transport, clock, statuses } = makeHub();
	transport.script = [{ throw: new HubUnsupportedError() }];
	hub.start();
	await flush();
	await clock.advance(120_000);
	assert.equal(hub.getStatus(), "unsupported");
	assert.equal(transport.requests.length, 1);
	assert.equal(statuses.at(-1), "unsupported");
	hub.poke();
	await flush();
	assert.equal(transport.requests.length, 1);
});

test("401: espera bem mais antes de tentar de novo", async () => {
	const { hub, transport, clock } = makeHub();
	transport.script = [{ throw: new HubAuthError() }];
	hub.start();
	await flush();
	await clock.advance(10_000);
	assert.equal(transport.requests.length, 1);
	await clock.advance(21_000);
	assert.equal(transport.requests.length, 2);
	hub.stop();
});

test("poke (voltou ao app): reconecta já se a conexão está parada; ignora se há atividade recente", async () => {
	const { hub, transport, clock } = makeHub();
	hub.start();
	await flush();
	transport.push({ kind: "ready", head: 3 });
	hub.poke();
	await flush();
	assert.equal(transport.requests.length, 1); // atividade agora há pouco
	await clock.advance(20_000);
	hub.poke();
	await flush();
	assert.equal(transport.requests.length, 2);
	assert.equal(transport.last.cursor, 3);
	hub.stop();
});

test("poke durante a espera do backoff acorda e conecta sem esperar", async () => {
	const { hub, transport, clock } = makeHub();
	transport.script = [{ throw: new Error("net") }];
	hub.start();
	await flush();
	assert.equal(transport.requests.length, 1);
	hub.poke();
	await flush();
	assert.equal(transport.requests.length, 2);
	await clock.advance(0);
	hub.stop();
});

// ---- roteamento --------------------------------------------------------------------------------------------

test("roteia por conversa e para a lista de bots; guarda o estado por conversa", async () => {
	const { hub, transport } = makeHub();
	const c1: HubEvent[] = [];
	const c2: HubEvent[] = [];
	const bots: HubEvent[] = [];
	hub.subscribeConversation("c1", (event) => c1.push(event));
	const offC2 = hub.subscribeConversation("c2", (event) => c2.push(event));
	hub.subscribeBots((event) => bots.push(event));
	hub.start();
	await flush();
	transport.push({ kind: "ready", head: 0 });
	transport.event(1, "message", { conversationId: "c1", messageId: "m1" });
	transport.event(2, "run", { conversationId: "c2", runId: "r2", botId: "b2", status: "running" });
	transport.event(3, "run-activity", { conversationId: "c2", runId: "r2" });
	transport.event(4, "dev-session", { conversationId: "c1" });
	transport.event(5, "bot", { botId: "b9" });
	offC2();
	transport.event(6, "run", { conversationId: "c2", runId: "r2", botId: "b2", status: "completed" });
	assert.deepEqual(seqs(c1), [1, 4]);
	assert.deepEqual(seqs(c2), [2, 3]);
	assert.deepEqual(seqs(bots), [1, 2, 5, 6]); // run-activity e dev-session não mexem na lista
	assert.deepEqual(hub.getConversationState("c1"), { lastMessageSeq: 1, run: null });
	assert.deepEqual(hub.getConversationState("c2")?.run, { runId: "r2", status: "completed", botId: "b2" });
	assert.equal(affectsBotList({ seq: 1, type: "dev-job", payload: {} }), false);
	// Run que começa/termina (rotina, evento, delegação) refaz a lista, de onde vem o `working` de cada bot.
	assert.equal(affectsBotList({ seq: 2, type: "run", payload: { botId: "b1", status: "running" } }), true);
	hub.stop();
});

test("assinante com defeito não derruba os outros nem a conexão", async () => {
	const { hub, transport, events } = makeHub();
	hub.subscribe(() => {
		throw new Error("boom");
	});
	const warn = console.warn;
	console.warn = () => undefined;
	try {
		hub.start();
		await flush();
		transport.push({ kind: "ready", head: 0 });
		transport.event(1, "message");
		transport.event(2, "message");
	} finally {
		console.warn = warn;
	}
	assert.deepEqual(seqs(events), [1, 2]);
	hub.stop();
});

// ---- cenários ponta a ponta com thread-sync ---------------------------------------------------------------

const assistant = (id: string, text: string): Message => ({ id, kind: "assistant", text });
const confirm = (id: string): Message => ({ id, kind: "confirm", title: "Executar create_event?", status: "pending", confirmId: "cf-1" });

/** Servidor falso: mensagens persistidas por conversa. */
class FakeServer {
	messages = new Map<string, Message[]>();
	persist(conversationId: string, ...items: Message[]) {
		this.messages.set(conversationId, [...(this.messages.get(conversationId) ?? []), ...items]);
	}
	tail(conversationId: string) {
		return [...(this.messages.get(conversationId) ?? [])];
	}
}

/** O "chat" de uma conversa: abre lendo do servidor e depois só reage ao hub (como o hook). */
function openChat(hub: EventHub, server: FakeServer, conversationId: string) {
	let thread: Message[] = server.tail(conversationId);
	let open = true;
	const sync = createThreadSync({
		fetchTail: async () => server.tail(conversationId),
		apply: (update) => {
			thread = update(thread);
		},
		isCurrent: () => open,
	});
	const off = hub.subscribeConversation(conversationId, (event) => {
		if (event.type === "message" || event.type === "run") void sync.sync({ runLive: false });
	});
	const offResync = hub.onResync(() => void sync.sync({ runLive: false }));
	return {
		get thread() {
			return thread;
		},
		close() {
			open = false;
			off();
			offResync();
		},
	};
}

test("run termina com o usuário em outra conversa: mensagem final e card aparecem ao voltar", async () => {
	const { hub, transport } = makeHub();
	const server = new FakeServer();
	const refreshes: string[] = [];
	hub.subscribeBots((event) => refreshes.push(`${event.type}:${event.payload.conversationId ?? ""}`));
	hub.start();
	await flush();
	transport.push({ kind: "ready", head: 0 });

	// Usuário está na conversa A; o run da B termina e deixa um card de aprovação + a resposta.
	const chatA = openChat(hub, server, "A");
	server.persist("B", confirm("card-1"));
	transport.event(1, "message", { conversationId: "B", messageId: "card-1", role: "confirm" });
	server.persist("B", assistant("m-final", "Pronto, agendei."));
	transport.event(2, "message", { conversationId: "B", messageId: "m-final", role: "assistant" });
	transport.event(3, "run", { conversationId: "B", runId: "rB", status: "completed" });
	await flush();

	assert.deepEqual(chatA.thread, []); // A não é afetada
	assert.deepEqual(refreshes, ["message:B", "message:B", "run:B"]); // a lista de bots foi avisada
	assert.equal(hub.getConversationState("B")?.run?.status, "completed");

	// Volta para B: abre lendo o servidor e fica em dia sem perder o card nem a resposta.
	const chatB = openChat(hub, server, "B");
	assert.deepEqual(chatB.thread.map((m) => m.id), ["card-1", "m-final"]);
	chatA.close();
	chatB.close();
	hub.stop();
});

test("conversa aberta recebe o card e a resposta por evento, sem duplicar nem reordenar", async () => {
	const { hub, transport } = makeHub();
	const server = new FakeServer();
	hub.start();
	await flush();
	transport.push({ kind: "ready", head: 0 });
	const chat = openChat(hub, server, "A");
	server.persist("A", confirm("card-1"));
	transport.event(1, "message", { conversationId: "A", messageId: "card-1" });
	server.persist("A", assistant("m1", "feito"));
	transport.event(2, "message", { conversationId: "A", messageId: "m1" });
	transport.event(2, "message", { conversationId: "A", messageId: "m1" }); // reenvio
	await flush();
	assert.deepEqual(chat.thread.map((m) => m.id), ["card-1", "m1"]);
	chat.close();
	hub.stop();
});

test("desconexão longa: o resync refaz o snapshot e recupera o que ficou para trás", async () => {
	const { hub, transport, clock } = makeHub();
	const server = new FakeServer();
	hub.start();
	await flush();
	transport.push({ kind: "ready", head: 3 });
	const chat = openChat(hub, server, "A");
	transport.closeLast();
	await flush();
	// enquanto offline: card e resposta ficam no servidor, e o log foi podado
	server.persist("A", confirm("card-1"), assistant("m1", "feito"));
	await clock.advance(600);
	transport.push({ kind: "resync", head: 4000 });
	await flush();
	assert.deepEqual(chat.thread.map((m) => m.id), ["card-1", "m1"]);
	chat.close();
	hub.stop();
});

test("applyServerTail continua sendo a reconciliação: balão local sai quando o persistido chega", () => {
	const live: Message[] = [assistant("local-1", "Pronto, agendei.")];
	const merged = applyServerTail(live, [assistant("srv-1", "Pronto, agendei.")], { runLive: false });
	assert.deepEqual(merged.map((m) => m.id), ["srv-1"]);
});

// ---- cliente: bloco SSE, transporte, modo de consulta ------------------------------------------------------

test("parseHubBlock lê ready/resync/evento e ignora keepalive e lixo", () => {
	assert.deepEqual(parseHubBlock('id: 5\nevent: ready\ndata: {"head":5}'), { kind: "ready", head: 5 });
	assert.deepEqual(parseHubBlock('id: 9\nevent: resync\ndata: {"head":9}'), { kind: "resync", head: 9 });
	assert.deepEqual(parseHubBlock('id: 6\nevent: message\ndata: {"seq":6,"type":"message","payload":{"conversationId":"c"},"at":"t"}'), {
		kind: "event",
		event: { seq: 6, type: "message", payload: { conversationId: "c" }, at: "t" },
	});
	assert.equal(parseHubBlock(": keepalive"), null);
	assert.equal(parseHubBlock("data: {nope"), null);
	assert.equal(parseHubBlock('data: {"seq":"x"}'), null);
});

function sseResponse(chunks: string[], init: { status?: number; contentType?: string } = {}): Response {
	const encoder = new TextEncoder();
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
			controller.close();
		},
	});
	return new Response(body, { status: init.status ?? 200, headers: { "content-type": init.contentType ?? "text/event-stream" } });
}

test("transporte fetch: junta blocos cortados no meio, manda Last-Event-ID e marca atividade", async () => {
	const seen: Array<{ url: string; headers: Record<string, string> }> = [];
	const transport = createFetchHubTransport("", (async (url: string, init: RequestInit) => {
		seen.push({ url, headers: init.headers as Record<string, string> });
		return sseResponse(['retry: 2000\n\nid: 5\nevent: ready\nda', 'ta: {"head":5}\n\n: keepalive\n\nid: 6\nevent: message\ndata: {"seq":6,"type":"message","payload":{}}\n\n']);
	}) as unknown as typeof fetch);
	const frames: HubFrame[] = [];
	await transport({ cursor: 5, signal: new AbortController().signal, onFrame: (frame) => frames.push(frame) });
	assert.equal(seen[0]!.url, "/v1/events");
	assert.equal(seen[0]!.headers["Last-Event-ID"], "5");
	assert.deepEqual(frames.filter((f) => f.kind !== "activity").map((f) => f.kind), ["ready", "event"]);
	assert.ok(frames.some((f) => f.kind === "activity"));
});

test("transporte fetch: 404 e resposta que não é SSE viram unsupported; 401 vira auth", async () => {
	const run = (response: Response) =>
		createFetchHubTransport("", (async () => response) as unknown as typeof fetch)({ cursor: null, signal: new AbortController().signal, onFrame: () => undefined });
	await assert.rejects(run(new Response("nf", { status: 404 })), HubUnsupportedError);
	await assert.rejects(run(new Response("<html>", { status: 200, headers: { "content-type": "text/html" } })), HubUnsupportedError);
	await assert.rejects(run(new Response("no", { status: 401 })), HubAuthError);
	await assert.rejects(run(new Response("err", { status: 500 })), /events http 500/);
});

test("modo de consulta: hub conectado não consulta; degradado só a cada 60 s; sem hub é o comportamento antigo", () => {
	assert.equal(pollModeFor("connected"), "hub");
	assert.equal(pollModeFor("connecting"), "degraded");
	assert.equal(pollModeFor("disconnected"), "degraded");
	assert.equal(pollModeFor("unsupported"), "legacy");
	assert.equal(pollModeFor("idle"), "legacy");
	assert.equal(pollModeFor(null), "legacy");
	assert.equal(shouldPollTick("legacy", 1, 1), true);
	assert.equal(shouldPollTick("hub", 10_000_000, 0), false);
	assert.equal(shouldPollTick("degraded", DEGRADED_POLL_MS - 1, 0), false);
	assert.equal(shouldPollTick("degraded", DEGRADED_POLL_MS, 0), true);
	assert.equal(hubEnabled({}), true);
	assert.equal(hubEnabled({ NEXT_PUBLIC_REALTIME_HUB: "0" }), false);
});
