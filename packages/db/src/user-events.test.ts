/**
 * Log de eventos por usuário: ordem, cursor, replay, resync, isolamento e publicação que nunca lança.
 * Runner: `tsx --test src/user-events.test.ts` em packages/db.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createPublishThrottle, parseEventCursor, planReplay, publishUserEvent, USER_EVENT_RETENTION_MS } from "./user-events.js";
import { createMemoryUserEventStore } from "./testing/memory-user-events.js";

test("seq cresce de 1 em 1 por usuário e os usuários não se misturam", async () => {
	const store = createMemoryUserEventStore();
	assert.equal(await publishUserEvent("a", "message", { n: 1 }, store), 1);
	assert.equal(await publishUserEvent("b", "message", { n: 1 }, store), 1);
	assert.equal(await publishUserEvent("a", "run", { n: 2 }, store), 2);
	assert.deepEqual((await store.listAfter("a", 0, 10)).map((e) => [e.seq, e.type]), [[1, "message"], [2, "run"]]);
	assert.deepEqual((await store.listAfter("b", 0, 10)).map((e) => e.seq), [1]);
	assert.equal(await store.head("a"), 2);
	assert.equal(await store.head("zzz"), 0);
});

test("publishUserEvent nunca lança e ignora usuário vazio", async () => {
	const store = createMemoryUserEventStore();
	store.failNextPublish();
	const warn = console.warn;
	console.warn = () => undefined;
	try {
		assert.equal(await publishUserEvent("a", "message", {}, store), null);
	} finally {
		console.warn = warn;
	}
	assert.equal(await publishUserEvent(null, "message", {}, store), null);
	assert.equal(await publishUserEvent("a", "message", {}, store), 1);
});

test("replay: sem cursor começa do fim; com cursor entrega o que falta em ordem", async () => {
	const store = createMemoryUserEventStore();
	for (let i = 0; i < 5; i += 1) await publishUserEvent("a", "message", { i }, store);
	assert.deepEqual(await planReplay(store, "a", null), { kind: "fresh", head: 5 });
	const plan = await planReplay(store, "a", 2);
	assert.equal(plan.kind, "events");
	if (plan.kind === "events") assert.deepEqual(plan.events.map((e) => e.seq), [3, 4, 5]);
	const caughtUp = await planReplay(store, "a", 5);
	assert.equal(caughtUp.kind, "events");
	if (caughtUp.kind === "events") assert.equal(caughtUp.events.length, 0);
});

test("replay: cursor podado ou no futuro vira resync", async () => {
	let clock = 0;
	const store = createMemoryUserEventStore(() => clock);
	for (let i = 0; i < 4; i += 1) await publishUserEvent("a", "message", { i }, store);
	clock = USER_EVENT_RETENTION_MS + 10;
	await publishUserEvent("a", "message", { i: 4 }, store);
	await store.prune(new Date(clock - USER_EVENT_RETENTION_MS + 5));
	// só o seq 5 sobrou: cursor 1 tem buraco, cursor 4 está emendado
	assert.deepEqual(await planReplay(store, "a", 1), { kind: "resync", head: 5 });
	const ok = await planReplay(store, "a", 4);
	assert.equal(ok.kind, "events");
	assert.deepEqual(await planReplay(store, "a", 99), { kind: "resync", head: 5 });
	// tudo podado mas o contador lembra: cursor velho ainda vira resync
	await store.prune(new Date(clock + 1000));
	assert.deepEqual(await planReplay(store, "a", 2), { kind: "resync", head: 5 });
	assert.deepEqual(await planReplay(store, "a", 5), { kind: "events", events: [], head: 5 });
});

test("parseEventCursor aceita só inteiros não negativos", () => {
	assert.equal(parseEventCursor(undefined), null);
	assert.equal(parseEventCursor(""), null);
	assert.equal(parseEventCursor("abc"), null);
	assert.equal(parseEventCursor("-3"), null);
	assert.equal(parseEventCursor("0"), 0);
	assert.equal(parseEventCursor("42"), 42);
});

test("throttle deixa passar o primeiro e descarta o resto da janela, por chave", () => {
	let clock = 1000;
	const allow = createPublishThrottle(2000, () => clock);
	assert.equal(allow("r1"), true);
	assert.equal(allow("r1"), false);
	assert.equal(allow("r2"), true);
	clock += 2001;
	assert.equal(allow("r1"), true);
});
