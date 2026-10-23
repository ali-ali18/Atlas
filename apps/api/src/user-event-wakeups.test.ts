import assert from "node:assert/strict";
import { test } from "node:test";
import { createUserEventWaker, getDefaultUserEventWaker, USER_EVENTS_CHANNEL, type ListenClient } from "./user-event-wakeups.js";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Conexão do pg falsa: grava os comandos e deixa o teste disparar NOTIFY e queda. */
function fakeClient(options: { failConnect?: boolean } = {}) {
	const queries: string[] = [];
	let notify: ((channel: string, payload: string | undefined) => void) | undefined;
	let lost: (() => void) | undefined;
	let ended = 0;
	const client: ListenClient = {
		connect: async () => {
			if (options.failConnect) throw Object.assign(new Error("postgres://u:segredo@host"), { code: "ECONNREFUSED" });
		},
		query: async (sql) => void queries.push(sql),
		onNotification: (listener) => void (notify = listener),
		onLost: (listener) => void (lost = listener),
		end: async () => void (ended += 1),
	};
	return {
		client,
		queries,
		notify: (channel: string, payload?: string) => notify?.(channel, payload),
		lose: () => lost?.(),
		get ended() {
			return ended;
		},
	};
}

test("NOTIFY acorda só os streams do usuário do aviso; listening só com LISTEN feito", async () => {
	const fake = fakeClient();
	const waker = createUserEventWaker({ createClient: () => fake.client });
	assert.equal(waker.listening(), false);
	const a: string[] = [];
	const b: string[] = [];
	const offA = waker.subscribe("u1", () => a.push("wake"));
	waker.subscribe("u2", () => b.push("wake"));
	await tick();
	assert.deepEqual(fake.queries, [`LISTEN ${USER_EVENTS_CHANNEL}`]);
	assert.equal(waker.listening(), true);
	// Ao começar a escutar, todos releem uma vez (o que entrou antes da escuta).
	assert.deepEqual([a.length, b.length], [1, 1]);
	fake.notify(USER_EVENTS_CHANNEL, "u1");
	fake.notify("outro_canal", "u2");
	assert.deepEqual([a.length, b.length], [2, 1]);
	offA();
	offA();
	fake.notify(USER_EVENTS_CHANNEL, "u1");
	assert.equal(a.length, 2);
	await waker.close();
	assert.equal(fake.ended, 1);
	assert.equal(waker.listening(), false);
});

test("conexão cai: volta à consulta rápida e reconecta acordando todos", async () => {
	const fakes = [fakeClient(), fakeClient()];
	let created = 0;
	const waker = createUserEventWaker({ createClient: () => fakes[created++]!.client, reconnectMs: 5 });
	const woken: number[] = [];
	waker.subscribe("u1", () => woken.push(Date.now()));
	await tick();
	assert.equal(waker.listening(), true);
	fakes[0]!.lose();
	assert.equal(waker.listening(), false);
	await new Promise((resolve) => setTimeout(resolve, 30));
	assert.equal(created, 2);
	assert.equal(waker.listening(), true);
	assert.equal(woken.length, 2);
	await waker.close();
});

test("falha ao conectar não lança nem vaza a URL; segue sem escutar", async () => {
	const warn = console.warn;
	const logged: string[] = [];
	console.warn = (...args: unknown[]) => void logged.push(args.join(" "));
	try {
		const waker = createUserEventWaker({ createClient: () => fakeClient({ failConnect: true }).client, reconnectMs: 60_000 });
		waker.subscribe("u1", () => undefined);
		await tick();
		assert.equal(waker.listening(), false);
		assert.doesNotMatch(logged.join(" "), /segredo/);
		await waker.close();
	} finally {
		console.warn = warn;
	}
});

test("sem DATABASE_URL não há escuta (o stream fica na consulta de 600 ms)", () => {
	assert.equal(getDefaultUserEventWaker({}), null);
});
