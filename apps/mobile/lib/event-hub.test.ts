import assert from "node:assert/strict";
import { test } from "vitest";
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


test("stop seguido de start na hora não deixa dois laços de conexão", async () => {
	const { hub, transport } = makeHub();
	hub.start();
	await flush();
	hub.stop();
	hub.start();
	await flush();
	assert.equal(transport.requests.length, 2);
	transport.push({ kind: "ready", head: 4 });
	transport.closeLast();
	await flush();
	assert.equal(transport.requests.length, 2); // a antiga não reabre; a nova espera o atraso curto
	hub.stop();
});

test("stop guarda o cursor: start depois reconecta com ele (volta do segundo plano)", async () => {
	const { hub, transport } = makeHub();
	hub.start();
	await flush();
	transport.push({ kind: "ready", head: 0 });
	transport.event(1, "message");
	transport.event(2, "message");
	hub.stop();
	assert.equal(hub.getStatus(), "idle");
	hub.start();
	await flush();
	assert.equal(transport.last.cursor, 2);
	hub.stop();
});
