import { describe, expect, it, vi } from "vitest";
import { createRunSignals, runEventsChannel, runSignalChannel, type RunSignalSubscriber } from "./run-signals.js";

/** Pub/sub em memória: publish entrega aos canais assinados, como o Redis. */
function fakeRedis() {
	const subscribed = new Set<string>();
	const messageListeners: Array<(channel: string, message: string) => void> = [];
	const connectionListeners: Record<"close" | "ready", Array<() => void>> = { close: [], ready: [] };
	const calls: string[] = [];
	let subscribersCreated = 0;
	const subscriber: RunSignalSubscriber = {
		subscribe: async (channel) => {
			calls.push(`sub:${channel}`);
			subscribed.add(channel);
		},
		unsubscribe: async (channel) => {
			calls.push(`unsub:${channel}`);
			subscribed.delete(channel);
		},
		on: (event, listener) => {
			if (event === "message") messageListeners.push(listener);
			else connectionListeners[event].push(listener);
		},
		quit: vi.fn(async () => undefined),
	};
	const publisher = {
		publish: vi.fn(async (channel: string, message: string) => {
			if (subscribed.has(channel)) for (const l of messageListeners) l(channel, message);
			return subscribed.has(channel) ? 1 : 0;
		}),
		quit: vi.fn(async () => undefined),
	};
	return {
		subscribed,
		calls,
		/** Simula a conexão do subscriber caindo ("close") e voltando ("ready"). */
		emit: (event: "close" | "ready") => {
			for (const listener of connectionListeners[event]) listener();
		},
		publisher,
		subscriber,
		get subscribersCreated() {
			return subscribersCreated;
		},
		signals: createRunSignals({
			createPublisher: () => publisher,
			createSubscriber: () => {
				subscribersCreated += 1;
				return subscriber;
			},
		}),
	};
}

describe("run-signals: canal de eventos do run (stream SSE)", () => {
	it("usa canal próprio e só aceita a mensagem \"events\" (o worker do run não acorda por delta)", async () => {
		const subscribed = new Set<string>();
		const listeners: Array<(c: string, m: string) => void> = [];
		const signals = createRunSignals({
			createPublisher: () => ({
				publish: async (channel: string, message: string) => {
					for (const l of listeners) l(channel, message);
					return 1;
				},
			}),
			createSubscriber: () => ({
				subscribe: async (c: string) => void subscribed.add(c),
				unsubscribe: async (c: string) => void subscribed.delete(c),
				on: (e, l) => void (e === "message" && listeners.push(l)),
			}),
			channel: runEventsChannel,
			kinds: new Set(["events"]),
		});
		const got = vi.fn();
		signals.subscribeRunSignals("r1", got);
		expect(runEventsChannel("r1")).toBe("atlas:run-events:r1");
		expect([...subscribed]).toEqual(["atlas:run-events:r1"]);
		await signals.publishRunSignal("r1", "events");
		expect(got).toHaveBeenCalledExactlyOnceWith("events");
		await signals.publishRunSignal("r1", "cancel");
		expect(got).toHaveBeenCalledTimes(1);
	});
});

describe("run-signals", () => {
	it("publica no canal atlas:run:<id> e entrega só ao run assinado", async () => {
		const redis = fakeRedis();
		const a = vi.fn();
		const b = vi.fn();
		redis.signals.subscribeRunSignals("run-a", a);
		redis.signals.subscribeRunSignals("run-b", b);
		expect(runSignalChannel("run-a")).toBe("atlas:run:run-a");
		await redis.signals.publishRunSignal("run-a", "input");
		expect(redis.publisher.publish).toHaveBeenCalledWith("atlas:run:run-a", "input");
		expect(a).toHaveBeenCalledExactlyOnceWith("input");
		expect(b).not.toHaveBeenCalled();
	});

	it("usa UMA conexão subscriber para vários runs e só assina o canal uma vez", () => {
		const redis = fakeRedis();
		redis.signals.subscribeRunSignals("run-a", () => undefined);
		redis.signals.subscribeRunSignals("run-a", () => undefined);
		redis.signals.subscribeRunSignals("run-b", () => undefined);
		expect(redis.subscribersCreated).toBe(1);
		expect(redis.calls).toEqual(["sub:atlas:run:run-a", "sub:atlas:run:run-b"]);
	});

	it("unsubscribe é idempotente e só solta o canal quando o último ouvinte sai", async () => {
		const redis = fakeRedis();
		const first = vi.fn();
		const second = vi.fn();
		const off1 = redis.signals.subscribeRunSignals("run-a", first);
		const off2 = redis.signals.subscribeRunSignals("run-a", second);
		off1();
		off1();
		expect(redis.subscribed.has("atlas:run:run-a")).toBe(true);
		await redis.signals.publishRunSignal("run-a", "cancel");
		expect(first).not.toHaveBeenCalled();
		expect(second).toHaveBeenCalledWith("cancel");
		off2();
		expect(redis.subscribed.has("atlas:run:run-a")).toBe(false);
	});

	it("ignora mensagem desconhecida e isola ouvinte que lança", async () => {
		const redis = fakeRedis();
		const ok = vi.fn();
		redis.signals.subscribeRunSignals("run-a", () => {
			throw new Error("boom");
		});
		redis.signals.subscribeRunSignals("run-a", ok);
		await redis.publisher.publish("atlas:run:run-a", "lixo");
		expect(ok).not.toHaveBeenCalled();
		await redis.signals.publishRunSignal("run-a", "input");
		expect(ok).toHaveBeenCalledTimes(1);
	});

	it("falha ao publicar devolve false sem lançar nem vazar a mensagem do erro", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const signals = createRunSignals({
			createPublisher: () => ({
				publish: async () => {
					throw Object.assign(new Error("redis://:segredo@host"), { code: "ECONNREFUSED" });
				},
			}),
			createSubscriber: () => fakeRedis().subscriber,
		});
		await expect(signals.publishRunSignal("run-a", "input")).resolves.toBe(false);
		expect(warn.mock.calls.flat().join(" ")).not.toContain("segredo");
		warn.mockRestore();
	});

	it("close fecha as duas conexões e passa a ignorar subscribe/publish", async () => {
		const redis = fakeRedis();
		redis.signals.subscribeRunSignals("run-a", () => undefined);
		await redis.signals.publishRunSignal("run-a", "input");
		await redis.signals.close();
		await redis.signals.close();
		expect(redis.subscriber.quit).toHaveBeenCalledTimes(1);
		expect(redis.publisher.quit).toHaveBeenCalledTimes(1);
		await expect(redis.signals.publishRunSignal("run-a", "input")).resolves.toBe(false);
	});

	it("isSubscribed só depois do SUBSCRIBE confirmado; onReady avisa (e de novo ao reconectar)", async () => {
		const redis = fakeRedis();
		const ready = vi.fn();
		const off = redis.signals.subscribeRunSignals("run-a", () => undefined, ready);
		// O SUBSCRIBE ainda não respondeu: quem consome segue na consulta rápida.
		expect(redis.signals.isSubscribed("run-a")).toBe(false);
		await Promise.resolve();
		await Promise.resolve();
		expect(redis.signals.isSubscribed("run-a")).toBe(true);
		expect(ready).toHaveBeenCalledTimes(1);

		// Conexão caiu: nada confirmado até reassinar.
		redis.emit("close");
		expect(redis.signals.isSubscribed("run-a")).toBe(false);
		redis.emit("ready");
		await Promise.resolve();
		await Promise.resolve();
		expect(redis.signals.isSubscribed("run-a")).toBe(true);
		expect(ready).toHaveBeenCalledTimes(2);

		// Segundo ouvinte num canal já confirmado também recebe o aviso.
		const late = vi.fn();
		const offLate = redis.signals.subscribeRunSignals("run-a", () => undefined, late);
		await Promise.resolve();
		expect(late).toHaveBeenCalledTimes(1);
		offLate();
		off();
		expect(redis.signals.isSubscribed("run-a")).toBe(false);
	});

	it("SUBSCRIBE que falha nunca confirma (consumidor fica na consulta rápida)", async () => {
		const ready = vi.fn();
		const signals = createRunSignals({
			createPublisher: () => ({ publish: async () => 1 }),
			createSubscriber: () => ({
				subscribe: async () => {
					throw new Error("down");
				},
				unsubscribe: async () => undefined,
				on: () => undefined,
			}),
		});
		signals.subscribeRunSignals("run-a", () => undefined, ready);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(signals.isSubscribed("run-a")).toBe(false);
		expect(ready).not.toHaveBeenCalled();
	});
});
