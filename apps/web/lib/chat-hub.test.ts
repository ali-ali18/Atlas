import assert from "node:assert/strict";
import test from "node:test";
import { EventHub, type HubEvent, type HubFrame, type HubTransport } from "./event-hub";
import { hubEnabled, pollModeFor, shouldPollTick, DEGRADED_POLL_MS } from "./event-hub-client";
import { rng, shuffle, SimClient, SimServer } from "./chat-sim.testkit";
import { createThreadSync } from "./thread-sync";

/**
 * O hub real (EventHub) ligado ao chat simulado: eventos embaralhados, repetidos, perdidos e reentregues
 * na reconexão; o chat só confia no que o servidor tem (busca o fim a cada aviso) e tem que ficar igual a ele.
 */

type Request = { cursor: number | null; signal: AbortSignal; onFrame: (frame: HubFrame) => void };

class Transport {
	requests: Request[] = [];
	private closers: Array<() => void> = [];
	transport: HubTransport = (request) => {
		this.requests.push(request);
		return new Promise<void>((resolve) => {
			this.closers[this.requests.length - 1] = resolve;
			request.signal.addEventListener("abort", () => resolve(), { once: true });
		});
	};
	get last(): Request {
		return this.requests[this.requests.length - 1]!;
	}
	event(seq: number) {
		this.last.onFrame({ kind: "event", event: { seq, type: "message", payload: { conversationId: "c" } } });
	}
	close() {
		this.closers[this.requests.length - 1]?.();
	}
}

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

test("hub + chat: eventos fora de ordem, repetidos e perdidos (com reconexão) terminam iguais ao servidor", async () => {
	for (let seed = 1; seed <= 60; seed += 1) {
		const random = rng(seed);
		const transport = new Transport();
		const clock = new Clock();
		const hub = new EventHub({ transport: transport.transport, now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, random: () => 0.5 });
		const server = new SimServer();
		const client = new SimClient();
		const delivered: number[] = [];
		const sync = createThreadSync({
			fetchTail: async () => server.head,
			apply: (update) => {
				client.screen = update(client.screen);
			},
			isCurrent: () => true,
			wait: async () => undefined,
		});
		hub.subscribeConversation("c", (event: HubEvent) => {
			delivered.push(event.seq);
			void sync.sync({ runLive: true, retries: 0 });
		});
		hub.onResync(() => void sync.sync({ runLive: true, retries: 0 }));
		hub.start();
		await flush();
		transport.last.onFrame({ kind: "ready", head: 0 });

		// o servidor grava N mensagens (usuário e bot alternados) e emite um evento por gravação
		const total = 4 + Math.floor(random() * 8);
		const log: number[] = [];
		client.send("pergunta");
		for (let i = 1; i <= total; i += 1) {
			if (i === 1) server.user("pergunta");
			else server.assistant(`Resposta número ${i} do assistente.`);
			log.push(i);
		}
		// conexão 1: uma janela embaralhada, com repetições e uma perda (o evento `lost` nunca chega)
		// (perda silenciosa só é possível com eventos depois dela; sem eles a queda da conexão é o que denuncia)
		const lost = random() < 0.6 ? 1 + Math.floor(random() * (total - 1)) : -1;
		const firstBatch = shuffle(log.filter((seq) => seq !== lost), random).flatMap((seq) => (random() < 0.3 ? [seq, seq] : [seq]));
		for (const seq of firstBatch) transport.event(seq);
		await flush();
		if (lost !== -1) {
			// o evento que falta nunca chegou: o hub desiste de esperar, reconecta pelo cursor e o servidor repete
			await clock.advance(2_600);
			assert.ok(transport.requests.length >= 2, `seed=${seed}: não reconectou`);
			const from = transport.last.cursor ?? 0;
			for (const seq of log.filter((s) => s > from)) transport.event(seq);
			await flush();
		}
		// conexão que cai no fim: a reconexão retoma pelo cursor e o servidor reenvia a borda
		if (random() < 0.5) {
			transport.close();
			await flush();
			await clock.advance(600);
			const from = transport.last.cursor ?? 0;
			for (const seq of log.filter((s) => s >= from)) transport.event(seq);
			await flush();
		}
		// cada evento chegou aos assinantes UMA vez e na ordem do servidor
		assert.deepEqual(delivered, log, `seed=${seed}: entrega ${delivered.join(",")}`);
		await sync.sync({ runLive: false, retries: 0 });
		assert.deepEqual(client.ids, server.head.map((m) => m.id), `seed=${seed}: tela ${client.summary.join(" | ")}`);
		hub.stop();
	}
});

test("hub desligado (NEXT_PUBLIC_REALTIME_HUB=0): só consulta periódica, e ela basta para convergir", async () => {
	assert.equal(hubEnabled({ NEXT_PUBLIC_REALTIME_HUB: "0" }), false);
	assert.equal(hubEnabled({ NEXT_PUBLIC_REALTIME_HUB: "off" }), false);
	assert.equal(hubEnabled({}), true);
	// sem hub não há status: modo legado, consulta a cada tick de 1 s
	const mode = pollModeFor(undefined);
	assert.equal(mode, "legacy");
	const server = new SimServer();
	const client = new SimClient();
	client.send("pergunta");
	const sync = createThreadSync({
		fetchTail: async () => server.head,
		apply: (update) => {
			client.screen = update(client.screen);
		},
		isCurrent: () => true,
		wait: async () => undefined,
	});
	let polls = 0;
	let lastRunAt = 0;
	for (let second = 1; second <= 12; second += 1) {
		if (second === 2) server.user("pergunta");
		if (second === 5) server.assistant("Resposta chegando enquanto só há consulta periódica.");
		if (second === 9) server.assistant("Segunda fala do bot, também só por consulta.");
		if (!shouldPollTick(mode, second * 1000, lastRunAt)) continue;
		lastRunAt = second * 1000;
		polls += 1;
		await sync.sync({ runLive: second < 10 });
	}
	assert.equal(polls, 12);
	assert.deepEqual(client.ids, server.head.map((m) => m.id));
	// com o hub conectado a consulta periódica não roda; degradado, só uma vez por minuto
	assert.equal(shouldPollTick(pollModeFor("connected"), 5_000, 0), false);
	assert.equal(shouldPollTick(pollModeFor("disconnected"), DEGRADED_POLL_MS - 1, 0), false);
	assert.equal(shouldPollTick(pollModeFor("disconnected"), DEGRADED_POLL_MS, 0), true);
});
