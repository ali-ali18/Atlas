import assert from "node:assert/strict";
import { test } from "node:test";
import { Hono } from "hono";
import type { AuthEnv } from "../middleware/auth.js";

process.env.ATLAS_OWNER_EMAIL ||= "owner@example.com";
process.env.BETTER_AUTH_SECRET ||= "test-secret-long-enough-for-better-auth-middleware";
process.env.ATLAS_HOOK_PEPPER ||= "test-pepper";

const { createMemoryUserEventStore } = await import("@workspace/db/testing");
const { publishUserEvent } = await import("@workspace/db");
const { createEventRoutes, realtimeHubEnabled, runUserEventStream } = await import("./events.js");

type Store = ReturnType<typeof createMemoryUserEventStore>;
type Frame = { id?: number; event?: string; data?: Record<string, unknown>; comment?: string };

function parseFrames(raw: string[]): Frame[] {
	return raw
		.join("")
		.split("\n\n")
		.filter(Boolean)
		.map((block) => {
			const frame: Frame = {};
			for (const line of block.split("\n")) {
				if (line.startsWith("id:")) frame.id = Number(line.slice(3));
				else if (line.startsWith("event:")) frame.event = line.slice(6).trim();
				else if (line.startsWith("data:")) frame.data = JSON.parse(line.slice(5));
				else if (line.startsWith(":")) frame.comment = line.slice(1).trim();
			}
			return frame;
		});
}

/** Roda o laço por `steps` esperas, avançando um relógio falso; `script[i]` roda na i-ésima espera. */
async function collect(
	store: Store,
	userId: string,
	cursor: number | null,
	script: Array<() => Promise<unknown> | unknown> = [],
	steps = script.length + 1,
	keepaliveMs?: number,
) {
	const raw: string[] = [];
	let tick = 0;
	let clock = 0;
	await runUserEventStream({
		store,
		userId,
		cursor,
		pollMs: 1000,
		keepaliveMs,
		now: () => clock,
		io: {
			stopped: () => tick >= steps,
			send: (frame) => void raw.push(frame),
			wait: async (ms) => {
				clock += ms;
				const step = script[tick];
				tick += 1;
				await step?.();
			},
		},
	});
	return parseFrames(raw.filter((frame) => !frame.startsWith("retry:")));
}

test("conexão nova: ready com o fim do log; eventos novos chegam em ordem com id = seq", async () => {
	const store = createMemoryUserEventStore();
	await publishUserEvent("u1", "message", { old: true }, store);
	const frames = await collect(
		store,
		"u1",
		null,
		[
			() => publishUserEvent("u1", "run", { runId: "r1", status: "running" }, store),
			() => publishUserEvent("u1", "message", { messageId: "m1" }, store),
		],
		4,
	);
	assert.deepEqual(frames.map((f) => [f.event, f.id]), [["ready", 1], ["run", 2], ["message", 3]]);
	assert.equal((frames[1]!.data!.payload as { runId: string }).runId, "r1");
});

test("retomada com Last-Event-ID: reenvia só o que falta, sem duplicar", async () => {
	const store = createMemoryUserEventStore();
	for (let i = 1; i <= 4; i += 1) await publishUserEvent("u1", "message", { i }, store);
	const frames = await collect(store, "u1", 2);
	assert.deepEqual(frames.map((f) => f.id), [3, 4]);
});

test("cursor velho (log podado) responde resync e segue do fim", async () => {
	const store = createMemoryUserEventStore();
	for (let i = 1; i <= 3; i += 1) await publishUserEvent("u1", "message", { i }, store);
	await store.prune(new Date(Date.now() + 10_000));
	await publishUserEvent("u1", "message", { i: 4 }, store);
	const frames = await collect(store, "u1", 1, [() => publishUserEvent("u1", "message", { i: 5 }, store)], 3);
	assert.deepEqual(frames.map((f) => [f.event, f.id]), [["resync", 4], ["message", 5]]);
});

test("podado por baixo de uma conexão aberta: resync no meio do stream", async () => {
	const store = createMemoryUserEventStore();
	await publishUserEvent("u1", "message", { i: 1 }, store);
	const frames = await collect(
		store,
		"u1",
		null,
		[
			async () => {
				await publishUserEvent("u1", "message", { i: 2 }, store);
				await publishUserEvent("u1", "message", { i: 3 }, store);
				store.events.set("u1", store.events.get("u1")!.filter((e) => e.seq === 3));
			},
		],
		3,
	);
	assert.deepEqual(frames.map((f) => [f.event, f.id]), [["ready", 1], ["resync", 3]]);
});

test("isolamento: um usuário nunca recebe eventos de outro", async () => {
	const store = createMemoryUserEventStore();
	await publishUserEvent("u2", "message", { secret: true }, store);
	const frames = await collect(
		store,
		"u1",
		null,
		[
			() => publishUserEvent("u2", "message", { secret: true }, store),
			() => publishUserEvent("u1", "message", { mine: true }, store),
		],
		4,
	);
	assert.deepEqual(frames.map((f) => f.event), ["ready", "message"]);
	assert.deepEqual(frames[1]!.data!.payload, { mine: true });
});

test("keepalive a cada 15 s de silêncio", async () => {
	const store = createMemoryUserEventStore();
	const frames = await collect(store, "u1", null, [], 17, 15_000);
	assert.ok(frames.filter((f) => f.comment === "keepalive").length >= 1);
});

test("falha de leitura do banco não derruba o stream: volta a entregar depois", async () => {
	const store = createMemoryUserEventStore();
	await publishUserEvent("u1", "message", { i: 1 }, store);
	const real = store.listAfter;
	let fail = true;
	store.listAfter = async (...args) => {
		if (fail) {
			fail = false;
			throw new Error("db down");
		}
		return real(...args);
	};
	const warn = console.warn;
	console.warn = () => undefined;
	try {
		const frames = await collect(store, "u1", 0, [], 3);
		assert.deepEqual(frames.map((f) => f.id), [1]);
	} finally {
		console.warn = warn;
	}
});

function appFor(userId: string, store: Store, env: Record<string, string | undefined> = {}) {
	const outer = new Hono<AuthEnv>();
	outer.use("*", async (c, next) => {
		c.set("session", { user: { id: userId } } as AuthEnv["Variables"]["session"]);
		await next();
	});
	outer.route("/", createEventRoutes(store, env));
	return outer;
}

test("rota: SSE com Last-Event-ID; REALTIME_HUB=0 devolve 404", async () => {
	const store = createMemoryUserEventStore();
	await publishUserEvent("u1", "message", { i: 1 }, store);
	await publishUserEvent("u1", "run", { i: 2 }, store);
	const abort = new AbortController();
	const response = await appFor("u1", store).request("/v1/events", { headers: { "Last-Event-ID": "1" }, signal: abort.signal });
	assert.equal(response.status, 200);
	assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
	const reader = response.body!.getReader();
	const decoder = new TextDecoder();
	let text = "";
	while (!text.includes("event: run")) {
		const { value, done } = await reader.read();
		if (done) break;
		text += decoder.decode(value);
	}
	abort.abort();
	await reader.cancel().catch(() => undefined);
	assert.match(text, /id: 2\nevent: run/);
	assert.doesNotMatch(text, /id: 1\n/);

	const off = await appFor("u1", store, { REALTIME_HUB: "0" }).request("/v1/events");
	assert.equal(off.status, 404);
	assert.equal(realtimeHubEnabled({}), true);
	assert.equal(realtimeHubEnabled({ REALTIME_HUB: "off" }), false);
});
