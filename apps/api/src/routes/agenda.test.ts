/**
 * Agenda do agente na Biblioteca (F4.4): lista, pausar, retomar, cancelar, flag do v4 e IDOR (40-seguranca).
 * As rotas rodam sobre as funções REAIS de `packages/db/src/agenda.ts`; só o `prisma` é dublado, com um estado em memória
 * que honra o filtro `userId` da consulta (uma consulta sem dono devolveria o item do outro e o teste pegaria).
 * Runner: `NODE_ENV=test ATLAS_HOOK_PEPPER=test-pepper pnpm exec tsx --test src/routes/agenda.test.ts`.
 */
import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import { Hono } from "hono";
import type { AgendaChangeResponse, AgendaListResponse } from "@workspace/shared";
import type { AuthEnv } from "../middleware/auth.js";

process.env.ATLAS_OWNER_EMAIL ||= "owner@example.com";
process.env.BETTER_AUTH_SECRET ||= "test-secret-long-enough-for-better-auth-middleware";
const { prisma } = await import("@workspace/db");
const { createAgendaRoutes } = await import("./agenda.js");

const A = "agenda-owner-a";
const B = "agenda-owner-b";
const T0 = new Date("2026-11-07T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;

const restorers: (() => void)[] = [];
function stubMethod<T extends object, K extends keyof T>(object: T, key: K, fake: (...args: never[]) => unknown) {
	const original = object[key];
	const replacement = mock.fn(fake);
	Object.defineProperty(object, key, { value: replacement, configurable: true, writable: true });
	restorers.push(() => Object.defineProperty(object, key, { value: original, configurable: true, writable: true }));
	return replacement;
}
afterEach(() => {
	for (const restore of restorers.reverse()) restore();
	restorers.length = 0;
});

type Row = Record<string, unknown> & { id: string; userId: string; botId: string; status: string; agendaKind: string | null; dueAt: Date };

function row(id: string, userId: string, patch: Partial<Row> = {}): Row {
	return {
		id,
		userId,
		botId: userId === A ? "bot-a" : "bot-b",
		conversationId: "conv",
		kind: "reminder",
		agendaKind: "remind",
		status: "pending",
		note: `nota ${id}`,
		dueAt: new Date(T0.getTime() + HOUR),
		requestedFor: new Date(T0.getTime() + HOUR),
		intervalMinutes: null,
		untilAt: null,
		maxRuns: null,
		runCount: 0,
		eventFilterJson: null,
		noChangeStreak: 0,
		ignoredStreak: 0,
		attempts: 0,
		lastResultJson: null,
		lastNoticeAt: null,
		grantJson: { autonomy: "autonomous", rules: [] },
		runId: "run-secreto",
		endReason: null,
		claimedUntil: null,
		doneAt: null,
		createdAt: T0,
		...patch,
	} as Row;
}

const matches = (r: Row, where: Record<string, unknown>): boolean =>
	Object.entries(where).every(([key, value]) => {
		if (key === "agendaKind") return r.agendaKind !== null;
		if (value && typeof value === "object" && "in" in (value as object)) return (value as { in: unknown[] }).in.includes(r[key]);
		return r[key] === value;
	});

/** Estado em memória por trás de `botFollowup` e `bot`; devolve as linhas para o teste conferir o que foi gravado. */
function world(rows: Row[]) {
	stubMethod(prisma.botFollowup, "findMany", async ({ where }: { where: Record<string, unknown> }) => rows.filter((r) => matches(r, where)));
	stubMethod(prisma.botFollowup, "findFirst", async ({ where }: { where: Record<string, unknown> }) => rows.find((r) => matches(r, where)) ?? null);
	stubMethod(prisma.botFollowup, "updateMany", async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
		const hit = rows.filter((r) => matches(r, where));
		for (const r of hit) Object.assign(r, data);
		return { count: hit.length };
	});
	stubMethod(prisma.bot, "findFirst", async ({ where }: { where: { id: string; ownerId: string } }) => (where.ownerId === A && where.id === "bot-a") || (where.ownerId === B && where.id === "bot-b") ? { id: where.id } : null);
	return rows;
}

function appFor(userId: string) {
	const app = new Hono<AuthEnv>();
	app.use("*", async (c, next) => {
		c.set("session", { user: { id: userId, name: "Test", email: "owner@example.com", emailVerified: true, createdAt: T0, updatedAt: T0 }, session: { id: "s", token: "t", userId, expiresAt: T0, createdAt: T0, updatedAt: T0, ipAddress: null, userAgent: null } });
		await next();
	});
	return app;
}

async function build(userId: string, gate = { enabled: true, accounts: [A, B] as readonly string[] }) {
	const { listAgendaItems, getAgendaItem, changeAgendaItem, isBotOwnedBy } = await import("@workspace/db");
	const app = appFor(userId);
	app.route("/", createAgendaRoutes({ gate: () => gate, botOwned: isBotOwnedBy, list: listAgendaItems, get: getAgendaItem, change: (u, id, action) => changeAgendaItem(u, id, action, T0), timezone: async () => "America/Sao_Paulo" }));
	return app;
}

const act = (app: Hono<AuthEnv>, id: string, body: unknown) => app.request(`/v1/agenda/${id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

test("lista os itens do dono, ativos e encerrados, sem campo interno", async () => {
	world([
		row("i1", A, { dueAt: new Date(T0.getTime() + 2 * HOUR) }),
		row("i2", A, { agendaKind: "watch", intervalMinutes: 120, dueAt: new Date(T0.getTime() + HOUR) }),
		row("i3", A, { status: "paused" }),
		row("i4", A, { status: "done", endReason: "max_runs", dueAt: new Date(T0.getTime() - HOUR) }),
		row("v2", A, { agendaKind: null }),
		row("o1", B),
	]);
	const res = await (await build(A)).request("/v1/agenda?botId=bot-a");
	assert.equal(res.status, 200);
	const body = (await res.json()) as AgendaListResponse;
	assert.equal(body.enabled, true);
	assert.equal(body.timezone, "America/Sao_Paulo");
	assert.deepEqual(body.items.map((i) => i.id), ["i2", "i1", "i3"], "mais próximo primeiro; pausado depois");
	assert.deepEqual(body.ended.map((i) => [i.id, i.endReason]), [["i4", "max_runs"]]);
	const text = JSON.stringify(body);
	for (const secret of ["run-secreto", "grant", "autonomous", "userId", "conversationId"]) assert.ok(!text.includes(secret), `vazou ${secret}`);
});

test("conta fora do v4: lista desligada sem tocar no banco, e mudar é 404", async () => {
	const rows = world([row("i1", A)]);
	const off = { enabled: false, accounts: [] as readonly string[] };
	const res = await (await build(A, off)).request("/v1/agenda");
	assert.deepEqual(await res.json(), { enabled: false, timezone: "", items: [], ended: [] });
	assert.equal((prisma.botFollowup.findMany as unknown as ReturnType<typeof mock.fn>).mock.callCount(), 0);
	assert.equal((await act(await build(A, off), "i1", { action: "pause" })).status, 404);
	assert.equal(rows[0]!.status, "pending");
	// Flag ligada, mas a conta não está na lista.
	const notListed = { enabled: true, accounts: [B] as readonly string[] };
	assert.equal(((await (await (await build(A, notListed)).request("/v1/agenda")).json()) as AgendaListResponse).enabled, false);
});

test("pausar, retomar e cancelar gravam o estado e devolvem o item", async () => {
	const rows = world([row("i1", A)]);
	const app = await build(A);
	const paused = (await (await act(app, "i1", { action: "pause" })).json()) as AgendaChangeResponse;
	assert.equal(paused.item.status, "paused");
	assert.equal(rows[0]!.status, "paused");
	const resumed = (await (await act(app, "i1", { action: "resume" })).json()) as AgendaChangeResponse;
	assert.equal(resumed.item.status, "pending");
	const cancelled = (await (await act(app, "i1", { action: "cancel" })).json()) as AgendaChangeResponse;
	assert.deepEqual([cancelled.item.status, cancelled.item.endReason, cancelled.item.nextAt], ["cancelled", "owner", null]);
});

test("ação que não cabe no estado é 409 e não muda nada", async () => {
	const rows = world([row("i1", A), row("i2", A, { status: "done", endReason: "completed" })]);
	const app = await build(A);
	assert.equal((await act(app, "i1", { action: "resume" })).status, 409, "retomar o que já está ativo");
	assert.equal((await act(app, "i2", { action: "cancel" })).status, 409, "mexer no que acabou");
	assert.deepEqual(rows.map((r) => r.status), ["pending", "done"]);
});

test("corpo estrito: campo desconhecido, ação inválida e corpo vazio são 400", async () => {
	const rows = world([row("i1", A)]);
	const app = await build(A);
	assert.equal((await act(app, "i1", { action: "pause", userId: B })).status, 400);
	assert.equal((await act(app, "i1", { action: "apagar" })).status, 400);
	assert.equal((await app.request("/v1/agenda/i1", { method: "POST" })).status, 400);
	assert.equal(rows[0]!.status, "pending");
});

test("IDOR: o usuário B não lê, pausa, retoma nem cancela o item do usuário A", async () => {
	const rows = world([row("a1", A), row("a2", A, { status: "paused" }), row("b1", B)]);
	const app = await build(B);
	const list = (await (await app.request("/v1/agenda")).json()) as AgendaListResponse;
	assert.deepEqual(list.items.map((i) => i.id), ["b1"], "a lista de B só tem o que é de B");
	for (const [id, action] of [["a1", "pause"], ["a1", "cancel"], ["a2", "resume"], ["a2", "cancel"]] as const) {
		const res = await act(app, id, { action });
		assert.equal(res.status, 404, `${action} em ${id}`);
		assert.deepEqual(await res.json(), { error: "Not found" }, "indistinguível de inexistente");
	}
	assert.deepEqual(rows.map((r) => [r.id, r.status]), [["a1", "pending"], ["a2", "paused"], ["b1", "pending"]], "nada do A mudou");
	assert.equal((await act(app, "nao-existe", { action: "pause" })).status, 404);
});

test("IDOR: bot de outro dono na query é 404 e o userId não vem da query", async () => {
	world([row("a1", A), row("b1", B)]);
	const app = await build(B);
	assert.equal((await app.request("/v1/agenda?botId=bot-a")).status, 404);
	const sneaky = (await (await app.request("/v1/agenda?userId=" + A)).json()) as AgendaListResponse;
	assert.deepEqual(sneaky.items.map((i) => i.id), ["b1"]);
	assert.equal((await app.request("/v1/agenda?botId=")).status, 404);
});
