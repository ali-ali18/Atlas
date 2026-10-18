import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { startLeaseGuards } from "./lease-guards.js";

test("W3: stop() para heartbeat e poll de cancelamento", (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	let renews = 0;
	let polls = 0;
	const guards = startLeaseGuards({
		runId: "r1",
		renew: async () => {
			renews += 1;
			return true;
		},
		isCancelRequested: async () => {
			polls += 1;
			return false;
		},
	});
	t.mock.timers.tick(10_000);
	assert.ok(renews >= 1 && polls >= 1, "timers rodam enquanto o run vive");
	const before = { renews, polls };
	guards.stop();
	t.mock.timers.tick(60_000);
	assert.deepEqual({ renews, polls }, before, "nada roda depois do stop");
	assert.equal(guards.aborter.signal.aborted, true);
});

test("W3: stop() é idempotente e seguro após aborto", (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	const guards = startLeaseGuards({
		runId: "r1",
		renew: async () => true,
		isCancelRequested: async () => false,
	});
	guards.stop();
	guards.stop();
	assert.equal(guards.isLeaseLost(), false);
});

test("W3: renovação recusada marca lease perdido e aborta o run", async (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	const guards = startLeaseGuards({
		runId: "r1",
		renew: async () => false,
		isCancelRequested: async () => false,
	});
	mock.method(console, "error", () => undefined);
	t.mock.timers.tick(10_000);
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(guards.isLeaseLost(), true);
	assert.equal(guards.aborter.signal.aborted, true);
	guards.stop();
	mock.restoreAll();
});

function fakeBus() {
	const listeners = new Set<(kind: string) => void>();
	return {
		subscribe: (listener: (kind: string) => void) => {
			listeners.add(listener);
			return () => void listeners.delete(listener);
		},
		emit: (kind: string) => listeners.forEach((listener) => listener(kind)),
		listeners,
	};
}

test("sinais: cancel aborta o run na hora, sem esperar a consulta periódica", async (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	const bus = fakeBus();
	let cancelled = false;
	let polls = 0;
	const guards = startLeaseGuards({
		runId: "r1",
		renew: async () => true,
		isCancelRequested: async () => {
			polls += 1;
			return cancelled;
		},
		subscribeSignals: bus.subscribe,
	});
	await Promise.resolve();
	const afterStart = polls;
	t.mock.timers.tick(10_000);
	assert.equal(polls, afterStart, "sem consulta de 2 s: o poll virou segurança de 15 s");
	cancelled = true;
	bus.emit("cancel");
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(polls, afterStart + 1, "um sinal = uma leitura");
	assert.equal(guards.aborter.signal.aborted, true);
	assert.equal(guards.aborter.signal.reason?.name, "AgentRunCancelledError");
	guards.stop();
});

test("sinais: input não consulta cancel; consulta de segurança roda a cada 15 s", async (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	const bus = fakeBus();
	let polls = 0;
	const guards = startLeaseGuards({
		runId: "r1",
		renew: async () => true,
		isCancelRequested: async () => {
			polls += 1;
			return false;
		},
		subscribeSignals: bus.subscribe,
	});
	const afterStart = polls;
	bus.emit("input");
	assert.equal(polls, afterStart);
	t.mock.timers.tick(14_999);
	assert.equal(polls, afterStart);
	t.mock.timers.tick(1);
	assert.equal(polls, afterStart + 1);
	guards.stop();
});

test("sinais: stop() cancela a inscrição (idempotente) e sinal depois não consulta", (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	const bus = fakeBus();
	let polls = 0;
	const guards = startLeaseGuards({
		runId: "r1",
		renew: async () => true,
		isCancelRequested: async () => {
			polls += 1;
			return false;
		},
		subscribeSignals: bus.subscribe,
	});
	assert.equal(bus.listeners.size, 1);
	guards.stop();
	guards.stop();
	assert.equal(bus.listeners.size, 0);
	const before = polls;
	bus.emit("cancel");
	assert.equal(polls, before);
});
