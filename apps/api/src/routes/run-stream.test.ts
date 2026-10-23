import assert from "node:assert/strict";
import { test } from "node:test";
import { createRunObserver } from "./run-observer.js";
import { runRunStream, type RunStreamState } from "./run-stream.js";

const dec = new TextDecoder();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Ev = { seq: number; payload: { type: string; [k: string]: unknown } };

/** Run falso: eventos em memória + estado + contadores de consulta. */
function fakeRun(initial: Ev[] = [], status = "running") {
	const events = [...initial];
	const state = { status } as { status: string };
	const calls = { list: 0, state: 0, subscribed: 0, unsubscribed: 0 };
	let wake: (() => void) | undefined;
	return {
		events,
		state,
		calls,
		append(ev: Ev) {
			events.push(ev);
			wake?.();
		},
		deps: {
			getState: async (): Promise<RunStreamState | null> => {
				calls.state += 1;
				const now = new Date().toISOString();
				return { status: state.status, leaseUntil: new Date(Date.now() + 30_000).toISOString(), createdAt: now, updatedAt: now, jobEnqueuedAt: now };
			},
			listEvents: async (after: number, limit: number) => {
				calls.list += 1;
				return events.filter((e) => e.seq > after).slice(0, limit);
			},
			subscribe: (onWake: () => void) => {
				calls.subscribed += 1;
				wake = onWake;
				return () => {
					calls.unsubscribed += 1;
					wake = undefined;
				};
			},
		},
	};
}

function collect(abort: AbortController, run: (io: { stopped: () => boolean; send: (b: Uint8Array) => void; wait: (ms: number) => Promise<void>; wakeUp: () => void }) => Promise<void>) {
	const frames: string[] = [];
	const stream = createRunObserver(abort.signal, async (observer) => {
		await run(observer);
	});
	const done = (async () => {
		const reader = stream.getReader();
		for (;;) {
			const { value, done: finished } = await reader.read();
			if (finished) break;
			frames.push(dec.decode(value));
		}
	})();
	return { frames, done };
}

test("entrega eventos em ordem com id=seq e fecha quando o run termina", async () => {
	const run = fakeRun([
		{ seq: 1, payload: { type: "status" } },
		{ seq: 2, payload: { type: "assistant_delta", delta: "oi" } },
		{ seq: 3, payload: { type: "done" } },
	], "completed");
	const abort = new AbortController();
	const { frames, done } = collect(abort, (io) => runRunStream(0, { ...run.deps, io }));
	await done;
	const text = frames.join("");
	assert.ok(text.startsWith("retry: 2000"));
	assert.deepEqual([...text.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1])), [1, 2, 3]);
	assert.equal(run.calls.unsubscribed, 1);
});

test("Last-Event-ID: começa depois do cursor informado", async () => {
	const run = fakeRun([
		{ seq: 1, payload: { type: "status" } },
		{ seq: 2, payload: { type: "done" } },
	], "completed");
	const abort = new AbortController();
	const { frames, done } = collect(abort, (io) => runRunStream(1, { ...run.deps, io }));
	await done;
	assert.deepEqual([...frames.join("").matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1])), [2]);
});

test("sinal acorda o loop na hora (bem antes do polling de segurança de 500ms)", async () => {
	const run = fakeRun([], "running");
	const abort = new AbortController();
	const { frames, done } = collect(abort, (io) => runRunStream(0, { ...run.deps, io }));
	await sleep(60); // loop já está dormindo na espera
	const t0 = Date.now();
	run.append({ seq: 1, payload: { type: "assistant_delta", delta: "a" } });
	while (!frames.join("").includes("id: 1")) {
		assert.ok(Date.now() - t0 < 400, "evento deveria chegar muito antes do polling de segurança");
		await sleep(2);
	}
	const latency = Date.now() - t0;
	assert.ok(latency < 200, `latência do primeiro delta ${latency}ms`);
	abort.abort();
	await done;
});

test("sem sinal (Redis fora), o polling de segurança entrega em até ~500ms", async () => {
	const run = fakeRun([], "running");
	const noSubscribe = { ...run.deps, subscribe: undefined };
	const abort = new AbortController();
	const { frames, done } = collect(abort, (io) => runRunStream(0, { ...noSubscribe, io }));
	await sleep(50);
	const t0 = Date.now();
	run.events.push({ seq: 1, payload: { type: "assistant_delta", delta: "a" } });
	while (!frames.join("").includes("id: 1")) {
		assert.ok(Date.now() - t0 < 1200);
		await sleep(5);
	}
	assert.ok(Date.now() - t0 <= 700);
	abort.abort();
	await done;
});

test("não lê o run a cada volta: com atividade contínua só consulta eventos", async () => {
	const run = fakeRun([], "running");
	const abort = new AbortController();
	const { done } = collect(abort, (io) => runRunStream(0, { ...run.deps, io }));
	for (let i = 1; i <= 20; i++) {
		run.append({ seq: i, payload: { type: "assistant_delta", delta: String(i) } });
		await sleep(10);
	}
	assert.ok(run.calls.list >= 20);
	// Antes: 1 leitura do run (+ liveness) por volta. Agora: só quando para de vir evento.
	assert.ok(run.calls.state <= 3, `leituras do run: ${run.calls.state}`);
	abort.abort();
	await done;
});

test("run inexistente: avisa e fecha", async () => {
	const run = fakeRun();
	const abort = new AbortController();
	const { frames, done } = collect(abort, (io) => runRunStream(0, { ...run.deps, getState: async () => null, io }));
	await done;
	assert.match(frames.join(""), /Run not found/);
});

test("run pausado fecha com evento explícito", async () => {
	const run = fakeRun([{ seq: 1, payload: { type: "status" } }], "paused");
	const abort = new AbortController();
	const { frames, done } = collect(abort, (io) => runRunStream(0, { ...run.deps, io }));
	await done;
	assert.match(frames.join(""), /event: paused/);
});

test("assinatura confirmada espaça a consulta de segurança (3 s); sem Redis fica em 500 ms", async () => {
	for (const subscribed of [true, false]) {
		const run = fakeRun([], "running");
		const waits: number[] = [];
		let stop = false;
		await runRunStream(0, {
			...run.deps,
			subscribed: () => subscribed,
			io: {
				stopped: () => stop,
				send: () => undefined,
				wakeUp: () => undefined,
				wait: async (ms) => {
					waits.push(ms);
					if (waits.length >= 2) stop = true;
				},
			},
		});
		assert.deepEqual(waits, subscribed ? [3_000, 3_000] : [500, 500]);
	}
});

test("evento gravado entre a primeira leitura e a confirmação do SUBSCRIBE não espera a consulta lenta", async () => {
	const run = fakeRun([], "running");
	let ready: (() => void) | undefined;
	let confirmed = false;
	const abort = new AbortController();
	const { frames, done } = collect(abort, (io) =>
		runRunStream(0, {
			...run.deps,
			subscribe: (onWake, onReady) => {
				ready = onReady;
				return run.deps.subscribe(onWake);
			},
			subscribed: () => confirmed,
			io: { ...io, wait: (ms) => io.wait(Math.min(ms, 3_000)) },
		}),
	);
	await sleep(20);
	// Publicado antes de a assinatura valer: o sinal se perdeu (sem wake).
	run.events.push({ seq: 1, payload: { type: "assistant_delta", delta: "oi" } });
	confirmed = true;
	ready!();
	await sleep(50);
	assert.match(frames.join(""), /^id: 1$/m);
	abort.abort();
	await done;
});
