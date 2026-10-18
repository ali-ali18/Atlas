import { afterEach, describe, expect, it, vi } from "vitest";
import { InterruptedByInputError, runInterruptible } from "./interrupt.js";

const abortable = (signal: AbortSignal | undefined) =>
	new Promise<string>((_resolve, reject) => {
		signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
	});

describe("runInterruptible", () => {
	it("sem peek apenas repassa o sinal original", async () => {
		const controller = new AbortController();
		await expect(runInterruptible({ signal: controller.signal }, async (signal) => signal === controller.signal)).resolves.toBe(true);
	});

	it("interrupt pendente aborta a chamada em voo e lança InterruptedByInputError", async () => {
		let pending = false;
		setTimeout(() => {
			pending = true;
		}, 15);
		await expect(
			runInterruptible({ peek: async () => pending, pollMs: 5 }, abortable),
		).rejects.toBeInstanceOf(InterruptedByInputError);
	});

	it("descarta o resultado se o interrupt chegou junto com a resposta", async () => {
		let pending = false;
		await expect(
			runInterruptible({ peek: async () => pending, pollMs: 1_000 }, async () => {
				pending = true;
				await new Promise((resolve) => setTimeout(resolve, 5));
				return "resposta parcial";
			}),
		).resolves.toBe("resposta parcial");
		// Com a consulta ativa durante a chamada, a resposta é descartada.
		let flag = false;
		await expect(
			runInterruptible({ peek: async () => flag, pollMs: 2 }, async () => {
				flag = true;
				await new Promise((resolve) => setTimeout(resolve, 30));
				return "resposta parcial";
			}),
		).rejects.toBeInstanceOf(InterruptedByInputError);
	});

	it("cancelamento do run não vira interrupt: o erro original segue", async () => {
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 5);
		await expect(
			runInterruptible({ signal: controller.signal, peek: async () => false, pollMs: 5 }, abortable),
		).rejects.toThrow("aborted");
	});

	it("falha na consulta não derruba a chamada", async () => {
		await expect(
			runInterruptible(
				{
					peek: async () => {
						throw new Error("db");
					},
					pollMs: 2,
				},
				async () => "ok",
			),
		).resolves.toBe("ok");
	});
});

describe("startPolling", () => {
	it("não sobrepõe ciclos, engole erro e para o timer no stop", async () => {
		const { startPolling } = await import("./interrupt.js");
		let running = 0;
		let maxRunning = 0;
		let runs = 0;
		const poller = startPolling(async () => {
			runs += 1;
			running += 1;
			maxRunning = Math.max(maxRunning, running);
			await new Promise((resolve) => setTimeout(resolve, 30));
			running -= 1;
			if (runs === 1) throw new Error("falhou");
		}, 5);
		await new Promise((resolve) => setTimeout(resolve, 100));
		await poller.stop();
		const after = runs;
		expect(maxRunning).toBe(1);
		expect(after).toBeGreaterThan(1);
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(runs).toBe(after);
	});
});

/** Fonte de sinais falsa: guarda os ouvintes vivos (inscrições - cancelamentos). */
function fakeSignals() {
	const listeners = new Set<(kind: string) => void>();
	let subscribed = 0;
	let unsubscribed = 0;
	return {
		subscribe: (listener: (kind: string) => void) => {
			subscribed += 1;
			listeners.add(listener);
			return () => {
				if (listeners.delete(listener)) unsubscribed += 1;
			};
		},
		emit: (kind: string) => {
			for (const listener of [...listeners]) listener(kind);
		},
		get live() {
			return listeners.size;
		},
		get subscribed() {
			return subscribed;
		},
		get unsubscribed() {
			return unsubscribed;
		},
	};
}

describe("startSignalWatch", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("com sinais: um sinal input roda UM ciclo e não há consulta de 750 ms", async () => {
		vi.useFakeTimers();
		const { startSignalWatch } = await import("./interrupt.js");
		const bus = fakeSignals();
		const task = vi.fn(async () => undefined);
		const watch = startSignalWatch(task, { subscribe: bus.subscribe });
		await vi.advanceTimersByTimeAsync(10_000);
		expect(task).toHaveBeenCalledTimes(0);
		bus.emit("input");
		await vi.advanceTimersByTimeAsync(0);
		expect(task).toHaveBeenCalledTimes(1);
		await watch.stop();
	});

	it("ignora sinais que não são input", async () => {
		vi.useFakeTimers();
		const { startSignalWatch } = await import("./interrupt.js");
		const bus = fakeSignals();
		const task = vi.fn(async () => undefined);
		const watch = startSignalWatch(task, { subscribe: bus.subscribe });
		bus.emit("cancel");
		await vi.advanceTimersByTimeAsync(0);
		expect(task).not.toHaveBeenCalled();
		await watch.stop();
	});

	it("sinal durante um ciclo em voo agenda UM novo ciclo (a leitura em voo pode ter perdido a novidade)", async () => {
		const { startSignalWatch } = await import("./interrupt.js");
		const bus = fakeSignals();
		let release!: () => void;
		let calls = 0;
		const watch = startSignalWatch(
			async () => {
				calls += 1;
				if (calls === 1) await new Promise<void>((resolve) => (release = resolve));
			},
			{ subscribe: bus.subscribe },
		);
		bus.emit("input");
		bus.emit("input");
		bus.emit("input");
		release();
		await vi.waitFor(() => expect(calls).toBe(2));
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(calls).toBe(2);
		await watch.stop();
	});

	it("consulta de segurança a cada 15 s quando nenhum sinal chega", async () => {
		vi.useFakeTimers();
		const { startSignalWatch, SIGNAL_FALLBACK_POLL_MS } = await import("./interrupt.js");
		expect(SIGNAL_FALLBACK_POLL_MS).toBe(15_000);
		const bus = fakeSignals();
		const task = vi.fn(async () => undefined);
		const watch = startSignalWatch(task, { subscribe: bus.subscribe });
		await vi.advanceTimersByTimeAsync(14_999);
		expect(task).toHaveBeenCalledTimes(0);
		await vi.advanceTimersByTimeAsync(1);
		expect(task).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(15_000);
		expect(task).toHaveBeenCalledTimes(2);
		await watch.stop();
	});

	it("stop cancela a inscrição e o timer (idempotente); sinal depois do stop não roda nada", async () => {
		vi.useFakeTimers();
		const { startSignalWatch } = await import("./interrupt.js");
		const bus = fakeSignals();
		const task = vi.fn(async () => undefined);
		const watch = startSignalWatch(task, { subscribe: bus.subscribe });
		await watch.stop();
		await watch.stop();
		expect(bus.live).toBe(0);
		expect(bus.unsubscribed).toBe(1);
		bus.emit("input");
		await vi.advanceTimersByTimeAsync(60_000);
		expect(task).not.toHaveBeenCalled();
	});

	it("sem fonte de sinais mantém a consulta periódica de pollMs", async () => {
		vi.useFakeTimers();
		const { startSignalWatch } = await import("./interrupt.js");
		const task = vi.fn(async () => undefined);
		const watch = startSignalWatch(task, { pollMs: 750 });
		await vi.advanceTimersByTimeAsync(2_250);
		expect(task).toHaveBeenCalledTimes(3);
		await watch.stop();
	});
});

describe("runInterruptible com sinais", () => {
	it("sinal input durante a chamada: UMA leitura extra, interrompe, e solta a inscrição", async () => {
		const bus = fakeSignals();
		let pending = false;
		const peek = vi.fn(async () => pending);
		const promise = runInterruptible({ peek, subscribe: bus.subscribe }, abortable);
		await vi.waitFor(() => expect(peek).toHaveBeenCalledTimes(1));
		pending = true;
		bus.emit("input");
		await expect(promise).rejects.toBeInstanceOf(InterruptedByInputError);
		expect(peek).toHaveBeenCalledTimes(2);
		expect(bus.live).toBe(0);
	});

	it("solta a inscrição em sucesso, erro da chamada e abort externo", async () => {
		const bus = fakeSignals();
		const peek = async () => false;
		await runInterruptible({ peek, subscribe: bus.subscribe }, async () => "ok");
		await expect(
			runInterruptible({ peek, subscribe: bus.subscribe }, async () => {
				throw new Error("falhou");
			}),
		).rejects.toThrow("falhou");
		const controller = new AbortController();
		const aborted = runInterruptible({ peek, subscribe: bus.subscribe, signal: controller.signal }, abortable);
		await new Promise((resolve) => setTimeout(resolve, 5));
		controller.abort();
		await expect(aborted).rejects.toThrow("aborted");
		await vi.waitFor(() => expect(bus.unsubscribed).toBe(3));
		expect(bus.subscribed).toBe(3);
		expect(bus.live).toBe(0);
	});
});
