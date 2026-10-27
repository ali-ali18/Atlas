import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { prisma } from "./client.js";
import { claimBriefPosting, listPendingBriefs, markBriefPending } from "./brief-delivery.js";

const restores: Array<() => void> = [];
function patch(target: object, name: string, impl: unknown) {
	const original = Reflect.get(target, name);
	Reflect.set(target, name, impl);
	restores.push(() => Reflect.set(target, name, original));
}
afterEach(() => {
	for (const restore of restores.splice(0).reverse()) restore();
});

test("claim só vence quando o brief está pendente (filtro condicional no UPDATE)", async () => {
	let where: unknown;
	patch(prisma.routineRun, "updateMany", async (args: { where: unknown }) => {
		where = args.where;
		return { count: 1 };
	});
	assert.equal(await claimBriefPosting("rr-1", "texto"), true);
	assert.deepEqual(where, { id: "rr-1", eventJson: { path: ["briefDelivery", "state"], equals: "pending" } });
	patch(prisma.routineRun, "updateMany", async () => ({ count: 0 }));
	assert.equal(await claimBriefPosting("rr-1", "texto"), false, "segundo chamador perde");
});

test("marcar pendente nunca rebaixa um brief já postado", async () => {
	let where: unknown;
	patch(prisma.routineRun, "updateMany", async (args: { where: unknown }) => {
		where = args.where;
		return { count: 0 };
	});
	await markBriefPending("rr-1", "texto");
	assert.deepEqual(where, { id: "rr-1", NOT: { eventJson: { path: ["briefDelivery", "state"], equals: "posted" } } });
});

test("lista só pendentes de rotina Seu dia, com o dono vindo da rotina (não do texto)", async () => {
	let args: { where: Record<string, unknown> } | undefined;
	patch(prisma.routineRun, "findMany", async (a: typeof args) => {
		args = a;
		return [
			{ id: "rr-1", eventJson: { briefDelivery: { state: "pending", text: "Resumo" } }, routine: { userId: "user-a", botId: "bot-a" } },
			{ id: "rr-2", eventJson: { briefDelivery: { state: "pending", text: "  " } }, routine: { userId: "user-a", botId: "bot-a" } },
		];
	});
	const now = new Date("2026-10-27T10:00:00Z");
	assert.deepEqual(await listPendingBriefs(now), [{ routineRunId: "rr-1", userId: "user-a", botId: "bot-a", text: "Resumo" }]);
	assert.deepEqual(args?.where.routine, { template: "daily_brief" });
	assert.deepEqual(args?.where.eventJson, { path: ["briefDelivery", "state"], equals: "pending" });
	assert.deepEqual(args?.where.createdAt, { gte: new Date("2026-10-26T22:00:00Z") });
});
