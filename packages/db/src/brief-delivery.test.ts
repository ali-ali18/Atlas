import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { prisma } from "./client.js";
import { findRoutineRunByAgentRunId } from "./routines.js";
import { expireStaleBriefs, isConversationBusyForBrief, listPendingBriefs, markBriefPending, markBriefPosted } from "./brief-delivery.js";

const restores: Array<() => void> = [];
function patch(target: object, name: string, impl: unknown) {
	const original = Reflect.get(target, name);
	Reflect.set(target, name, impl);
	restores.push(() => Reflect.set(target, name, original));
}
afterEach(() => {
	for (const restore of restores.splice(0).reverse()) restore();
});

// Estes testes fixam a FORMA das consultas (só filtros de coluna, sempre com o dono). A semântica real de
// NULL e a concorrência são provadas em brief-delivery.db.test.ts (Postgres de verdade).
const owner = { routine: { userId: { in: ["user-a"] } } };

test("marcar pendente: filtro de coluna simples (IS NULL ou pending), com o dono; nunca rebaixa postado", async () => {
	let where: unknown;
	patch(prisma.routineRun, "updateMany", async (args: { where: unknown }) => ((where = args.where), { count: 1 }));
	assert.equal(await markBriefPending("user-a", "rr-1", "texto"), true);
	assert.deepEqual(where, { id: "rr-1", ...owner, OR: [{ briefStatus: null }, { briefStatus: "pending" }] });
	assert.equal(await markBriefPending("user-a", "rr-1", "texto", "ifUnset"), true);
	assert.deepEqual(where, { id: "rr-1", ...owner, briefStatus: null }, "linha de falha: só de sem estado");
	patch(prisma.routineRun, "updateMany", async () => ({ count: 0 }));
	assert.equal(await markBriefPending("user-a", "rr-1", "texto"), false);
});

test("marcar postado: só de pending, com o dono, e limpa o texto", async () => {
	let args: { where: unknown; data: unknown } | undefined;
	patch(prisma.routineRun, "updateMany", async (a: typeof args) => ((args = a), { count: 1 }));
	assert.equal(await markBriefPosted("user-a", "rr-1"), true);
	assert.deepEqual(args?.where, { id: "rr-1", ...owner, briefStatus: "pending" });
	assert.deepEqual(args?.data, { briefStatus: "posted", briefText: null });
});

test("lista só pendentes de rotina Seu dia pela coluna indexada, com o dono vindo da rotina", async () => {
	let args: { where: Record<string, unknown> } | undefined;
	patch(prisma.routineRun, "findMany", async (a: typeof args) => {
		args = a;
		return [
			{ id: "rr-1", briefText: "Resumo", briefPushedAt: null, routine: { userId: "user-a", botId: "bot-a", notify: "always" } },
			{ id: "rr-2", briefText: "  ", briefPushedAt: null, routine: { userId: "user-a", botId: "bot-a", notify: "always" } },
			{ id: "rr-3", briefText: "Outro", briefPushedAt: new Date(), routine: { userId: "user-a", botId: "bot-a", notify: "important" } },
		];
	});
	assert.deepEqual(await listPendingBriefs(new Date("2026-10-27T10:00:00Z")), [
		{ routineRunId: "rr-1", userId: "user-a", botId: "bot-a", text: "Resumo", pushed: false, notify: "always" },
		{ routineRunId: "rr-3", userId: "user-a", botId: "bot-a", text: "Outro", pushed: true, notify: "important" },
	]);
	assert.equal(args?.where.briefStatus, "pending");
	assert.deepEqual(args?.where.routine, { template: "daily_brief" });
	assert.deepEqual(args?.where.createdAt, { gte: new Date("2026-10-26T22:00:00Z") });
});

test("expirar: pendente mais velho que 12 h vira expired e perde o texto", async () => {
	let args: { where: unknown; data: unknown } | undefined;
	patch(prisma.routineRun, "updateMany", async (a: typeof args) => ((args = a), { count: 3 }));
	assert.equal(await expireStaleBriefs(new Date("2026-10-27T10:00:00Z")), 3);
	assert.deepEqual(args?.where, { briefStatus: "pending", createdAt: { lt: new Date("2026-10-26T22:00:00Z") } });
	assert.deepEqual(args?.data, { briefStatus: "expired", briefText: null });
});

test("ocupada: só queued/running/retrying ou run que acabou nos últimos 5 s", async () => {
	let where: unknown;
	patch(prisma.agentRun, "findFirst", async (a: { where: unknown }) => ((where = a.where), null));
	const now = new Date("2026-10-27T10:00:00Z");
	assert.equal(await isConversationBusyForBrief("conv", now), false);
	assert.deepEqual(where, {
		conversationId: "conv",
		OR: [{ status: { in: ["queued", "running", "retrying"] } }, { finishedAt: { gte: new Date("2026-10-27T09:59:55Z") } }],
	});
});

test("o texto do brief nunca sai pelo registro da execução (API de rotinas)", async () => {
	patch(prisma.routineRun, "findFirst", async () => ({
		id: "rr-1", routineId: "r", agentRunId: "a", triggeredBy: "schedule", scheduledFor: null, status: "completed",
		startedAt: null, finishedAt: null, error: null, summary: null, eventJson: null, createdAt: new Date(),
		briefStatus: "pending", briefText: "TEXTO PRIVADO DO BRIEF",
	}));
	const record = await findRoutineRunByAgentRunId("a");
	assert.ok(record);
	assert.ok(!JSON.stringify(record).includes("TEXTO PRIVADO"));
	assert.ok(!("briefText" in record) && !("briefStatus" in record));
});
