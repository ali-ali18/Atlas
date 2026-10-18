/**
 * Inscrições push e notify() com tabelas em memória e um web-push falso.
 * Runner: `tsx --test src/push.test.ts` em packages/db.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import {
	PUSH_MAX_FAILURES,
	createNotifier,
	createRedisCoalesce,
	createRedisPresence,
	listPushSubscriptions,
	removePushSubscription,
	savePushSubscription,
	sendTestPush,
	settlePushResult,
	type CoalesceStore,
	type PushSendResult,
	type PushSender,
	type Presence,
	type RedisLike,
} from "./push.js";
import { FakeTable, installFakes } from "./testing/fake-tables.js";

let subs: FakeTable;
let bots: FakeTable;
let installed: { restore: () => void };

const sub = (endpoint: string) => ({ endpoint, p256dh: "pk", auth: "au", userAgent: "UA" });

class FakeSender implements PushSender {
	calls: Array<{ endpoint: string; payload: Record<string, unknown> }> = [];
	results = new Map<string, PushSendResult>();
	async send(target: { endpoint: string }, payload: string) {
		this.calls.push({ endpoint: target.endpoint, payload: JSON.parse(payload) as Record<string, unknown> });
		return this.results.get(target.endpoint) ?? ({ ok: true } as const);
	}
}

function memoryPresence(viewed: boolean): Presence {
	return { touch: async () => undefined, clear: async () => undefined, isViewed: async () => viewed };
}

function memoryCoalesce(): CoalesceStore & { state: Map<string, { at: number; kind: string }> } {
	const state = new Map<string, { at: number; kind: string }>();
	return {
		state,
		get: async (u, c) => (state.get(`${u}:${c}`) as never) ?? null,
		set: async (u, c, s) => void state.set(`${u}:${c}`, s),
	};
}

beforeEach(() => {
	subs = new FakeTable([], () => ({ createdAt: new Date(), lastUsedAt: new Date(), failureCount: 0, lastFailureAt: null, lastError: null }));
	bots = new FakeTable([{ id: "b1", ownerId: "u1", conversationId: "c1", name: "Adolfinho", notify: true }]);
	installed = installFakes({ pushSubscription: subs, bot: bots });
});
afterEach(() => installed.restore());

test("CRUD: salva, reinscreve sem duplicar, lista e remove só as do dono", async () => {
	await savePushSubscription("u1", sub("https://p/1"));
	await savePushSubscription("u1", sub("https://p/2"));
	await savePushSubscription("u1", { ...sub("https://p/1"), userAgent: "novo" });
	const list = await listPushSubscriptions("u1");
	assert.equal(list.length, 2);
	assert.equal(list.find((row) => row.endpoint === "https://p/1")?.userAgent, "novo");
	assert.equal(await removePushSubscription("u2", { id: list[0]!.id }), 0);
	assert.equal(await removePushSubscription("u1", { id: list[0]!.id }), 1);
	assert.equal(await removePushSubscription("u1", { endpoint: "https://p/2" }), 1);
	assert.equal((await listPushSubscriptions("u1")).length, 0);
});

test("410 e 404 apagam a inscrição; outras falhas contam até o limite", async () => {
	const a = await savePushSubscription("u1", sub("https://p/a"));
	const b = await savePushSubscription("u1", sub("https://p/b"));
	assert.equal(await settlePushResult(a.id, { ok: false, status: 410, error: "Gone" }), "deleted");
	assert.equal(await settlePushResult(b.id, { ok: false, status: 404, error: "Not Found" }), "deleted");
	assert.equal(subs.rows.length, 0);
	const c = await savePushSubscription("u1", sub("https://p/c"));
	assert.equal(await settlePushResult(c.id, { ok: false, status: 500, error: "boom" }), "failed");
	assert.equal(subs.rows[0]!.failureCount, 1);
	assert.equal(await settlePushResult(c.id, { ok: true }), "sent");
	assert.equal(subs.rows[0]!.failureCount, 0);
	for (let i = 0; i < PUSH_MAX_FAILURES - 1; i += 1) await settlePushResult(c.id, { ok: false, error: "x" });
	assert.equal(subs.rows.length, 1);
	assert.equal(await settlePushResult(c.id, { ok: false, error: "x" }), "deleted");
	assert.equal(subs.rows.length, 0);
});

test("notify: envia a todos os aparelhos, limpa o morto e usa a tag da conversa", async () => {
	await savePushSubscription("u1", sub("https://p/ok"));
	await savePushSubscription("u1", sub("https://p/dead"));
	const sender = new FakeSender();
	sender.results.set("https://p/dead", { ok: false, status: 410, error: "Gone" });
	const notify = createNotifier({ sender, presence: memoryPresence(false), coalesce: memoryCoalesce(), now: () => 1_000 });
	const result = await notify("u1", "c1", "run-finished", "Pronto, terminei.\nResto");
	assert.deepEqual(result, { status: "sent", sent: 1, deleted: 1, failed: 0 });
	assert.equal(sender.calls.length, 2);
	assert.equal(sender.calls[0]!.payload.tag, "c1");
	assert.equal(sender.calls[0]!.payload.title, "Adolfinho");
	assert.equal(sender.calls[0]!.payload.body, "Pronto, terminei.");
	assert.deepEqual((await listPushSubscriptions("u1")).map((row) => row.endpoint), ["https://p/ok"]);
});

test("notify: não notifica quem está olhando a conversa, o switch desligado, protocolo nem sem aparelhos", async () => {
	const sender = new FakeSender();
	const mk = (viewed: boolean) => createNotifier({ sender, presence: memoryPresence(viewed), coalesce: memoryCoalesce() });
	assert.deepEqual(await mk(false)("u1", "c1", "run-finished", "oi"), { status: "skipped", reason: "no-subscriptions" });
	await savePushSubscription("u1", sub("https://p/1"));
	assert.deepEqual(await mk(true)("u1", "c1", "run-finished", "oi"), { status: "skipped", reason: "viewing" });
	assert.deepEqual(await mk(false)("u1", "c1", "run-finished", "confirmado: Executar"), { status: "skipped", reason: "protocol" });
	bots.rows[0]!.notify = false;
	assert.deepEqual(await mk(false)("u1", "c1", "run-finished", "oi"), { status: "skipped", reason: "bot-disabled" });
	bots.rows[0]!.notify = true;
	assert.deepEqual(await mk(false)("u1", "outra", "run-finished", "oi"), { status: "skipped", reason: "no-conversation" });
	assert.deepEqual(await mk(false)("u2", "c1", "run-finished", "oi"), { status: "skipped", reason: "no-conversation" });
	assert.equal(sender.calls.length, 0);
});

test("notify: coalesce em 30s, mas 'precisa de você' passa por cima", async () => {
	await savePushSubscription("u1", sub("https://p/1"));
	const sender = new FakeSender();
	let now = 1_000;
	const notify = createNotifier({ sender, presence: memoryPresence(false), coalesce: memoryCoalesce(), now: () => now });
	assert.equal((await notify("u1", "c1", "run-finished", "um")).status, "sent");
	now += 5_000;
	assert.deepEqual(await notify("u1", "c1", "run-finished", "dois"), { status: "skipped", reason: "coalesced" });
	assert.equal((await notify("u1", "c1", "needs-user", "Executar · pnpm test", { cardId: "k1" })).status, "sent");
	assert.equal(sender.calls.at(-1)!.payload.url, "/?bot=b1&card=k1");
	now += 31_000;
	assert.equal((await notify("u1", "c1", "run-finished", "três")).status, "sent");
	assert.equal(sender.calls.length, 3);
});

test("teste: ignora presença, switch e coalescência", async () => {
	await savePushSubscription("u1", sub("https://p/1"));
	const sender = new FakeSender();
	assert.deepEqual(await sendTestPush("u1", sender), { sent: 1, deleted: 0, failed: 0, devices: 1 });
	assert.equal(sender.calls[0]!.payload.title, "Notificações ativadas");
	assert.deepEqual(await sendTestPush("u2", sender), { sent: 0, deleted: 0, failed: 0, devices: 0 });
});

test("presença no Redis: sinal vale até o TTL, sai ao limpar, expirados são ignorados", async () => {
	const zsets = new Map<string, Map<string, number>>();
	const redis: RedisLike = {
		zadd: async (k, score, member) => void (zsets.get(k) ?? zsets.set(k, new Map()).get(k)!).set(member, score),
		zrem: async (k, member) => void zsets.get(k)?.delete(member),
		zremrangebyscore: async (k, _min, max) => {
			for (const [member, score] of zsets.get(k) ?? []) if (score <= Number(max)) zsets.get(k)!.delete(member);
		},
		zcount: async (k, min) => [...(zsets.get(k)?.values() ?? [])].filter((score) => score > Number(String(min).replace("(", ""))).length,
		pexpire: async () => undefined,
		get: async () => null,
		set: async () => undefined,
	};
	const presence = createRedisPresence(redis, 45_000);
	assert.equal(await presence.isViewed("u1", "c1", 0), false);
	await presence.touch("u1", "c1", "tab-a", 1_000);
	assert.equal(await presence.isViewed("u1", "c1", 40_000), true);
	assert.equal(await presence.isViewed("u1", "c1", 46_001), false);
	await presence.touch("u1", "c1", "tab-b", 50_000);
	await presence.clear("u1", "c1", "tab-b");
	assert.equal(await presence.isViewed("u1", "c1", 60_000), false);
	assert.equal(await createRedisCoalesce(redis).get("u1", "c1"), null);
});

async function withEnv<T>(env: Record<string, string | undefined>, run: () => Promise<T>): Promise<T> {
	const saved = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
	for (const [key, value] of Object.entries(env)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	try {
		return await run();
	} finally {
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

test("notify: o ícone é o avatar do bot (forma e cor escolhidas), o selo continua o do app", async () => {
	await savePushSubscription("u1", sub("https://p/1"));
	bots.rows[0]!.shape = "galet";
	bots.rows[0]!.color = "#0086FF";
	const sender = new FakeSender();
	await withEnv({ ATLAS_URL: "https://app.example.com/", ATLAS_PUBLIC_URL: undefined }, async () => {
		const notify = createNotifier({ sender, presence: memoryPresence(false), coalesce: memoryCoalesce() });
		assert.equal((await notify("u1", "c1", "run-finished", "Testes passaram")).status, "sent");
	});
	const payload = sender.calls[0]!.payload;
	assert.equal(payload.icon, "https://app.example.com/v1/avatars/pebble-0086ff-v1.png");
	assert.equal(payload.badge, "/icons/badge-72.png");
	assert.ok(!String(payload.icon).includes("b1") && !String(payload.icon).includes("u1"));
});

test("notify: bot sem escolha usa a aparência sorteada pelo id; sem URL pública, o ícone do app", async () => {
	await savePushSubscription("u1", sub("https://p/1"));
	const sender = new FakeSender();
	const mk = () => createNotifier({ sender, presence: memoryPresence(false), coalesce: memoryCoalesce(), now: () => Date.now() + sender.calls.length * 60_000 });
	await withEnv({ ATLAS_URL: "https://app.example.com", ATLAS_PUBLIC_URL: undefined }, async () => {
		await mk()("u1", "c1", "run-finished", "um");
	});
	assert.match(String(sender.calls[0]!.payload.icon), /^https:\/\/app\.example\.com\/v1\/avatars\/[a-z]+-[0-9a-f]{6}-v1\.png$/);
	await withEnv({ ATLAS_URL: undefined, ATLAS_PUBLIC_URL: undefined }, async () => {
		await mk()("u1", "c1", "run-finished", "dois");
	});
	assert.equal(sender.calls[1]!.payload.icon, "/icons/icon-192.png");
});

test("teste: usa o avatar do bot principal; sem bot principal, o ícone do app", async () => {
	await savePushSubscription("u1", sub("https://p/1"));
	const sender = new FakeSender();
	await withEnv({ ATLAS_URL: "https://app.example.com", ATLAS_PUBLIC_URL: undefined }, async () => {
		await sendTestPush("u1", sender);
		assert.equal(sender.calls[0]!.payload.icon, "/icons/icon-192.png");
		bots.rows[0]!.isPrimary = true;
		bots.rows[0]!.shape = "heart";
		bots.rows[0]!.color = "#9159fe";
		await sendTestPush("u1", sender);
		assert.equal(sender.calls[1]!.payload.icon, "https://app.example.com/v1/avatars/heart-9159fe-v1.png");
	});
});
