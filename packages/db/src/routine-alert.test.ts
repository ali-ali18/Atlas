/** Alerta por condição da rotina: só cron/interval, estado escopado por dono (IDOR) e rearme ao trocar a condição. */
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { prisma } from "./client.js";
import { FakeTable, installFakes } from "./testing/fake-tables.js";
import { parseRoutineAlert } from "@workspace/shared";
import { createRoutine, getRoutineAlertForAgentRun, getRoutineContextForAgentRun, recordRoutineAlertState, updateRoutine } from "./routines.js";

let installed: { restore: () => void };
const writes: Array<Record<string, unknown>> = [];
let lastWhere: Record<string, unknown> = {};
const originals: Record<string, unknown> = {};
let stored: { userId: string; triggerType: string; alertJson: unknown };

beforeEach(() => {
	writes.length = 0;
	stored = { userId: "user-a", triggerType: "interval", alertJson: null };
	installed = installFakes({
		bot: new FakeTable([
			{ id: "bot-a", ownerId: "user-a", conversationId: null, openRouterModel: "m" },
			{ id: "bot-b", ownerId: "user-b", conversationId: null, openRouterModel: "m" },
		]),
	});
	const client = prisma as unknown as Record<string, Record<string, unknown>>;
	originals.routine = client.routine;
	// A gravação do alerta ativo roda numa transação com advisory lock (Postgres real nos testes .db): aqui a transação é só repasse.
	originals.$transaction = (prisma as unknown as Record<string, unknown>).$transaction;
	Object.assign(prisma, { $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma), $executeRaw: async () => 1 });
	originals.routineRun = client.routineRun;
	const row = (extra: Record<string, unknown> = {}) => ({
		id: "r1",
		userId: stored.userId,
		botId: "bot-a",
		createdAt: new Date(),
		updatedAt: new Date(),
		lastRunAt: null,
		enabled: true,
		triggerType: stored.triggerType,
		timezone: "America/Sao_Paulo",
		model: "m",
		notify: "always",
		createdBy: "user",
		triggerJson: { kind: "interval", everyMinutes: 30 },
		name: "Estoque",
		prompt: "verifique",
		schedule: null,
		alertJson: stored.alertJson,
		...extra,
	});
	client.routine = {
		count: async () => 0,
		create: async ({ data }: { data: Record<string, unknown> }) => {
			writes.push(data);
			return row(data);
		},
		findFirst: async () => row(),
		update: async ({ data }: { data: Record<string, unknown> }) => {
			writes.push(data);
			return row();
		},
		updateMany: async ({ where, data }: { where: { userId: { in: string[] }; alertJson: { equals: string } }; data: Record<string, unknown> }) => {
			const mine = where.userId.in.includes(stored.userId);
			const sameCondition = (stored.alertJson as { condition?: string } | null)?.condition === where.alertJson.equals;
			if (!mine || !sameCondition) return { count: 0 };
			writes.push(data);
			lastWhere = where as unknown as Record<string, unknown>;
			return { count: 1 };
		},
	};
	client.routineRun = { ...(client.routineRun ?? {}), findFirst: async () => null };
});
afterEach(() => {
	installed.restore();
	(prisma as unknown as Record<string, unknown>).routine = originals.routine;
	(prisma as unknown as Record<string, unknown>).$transaction = originals.$transaction;
	(prisma as unknown as Record<string, unknown>).routineRun = originals.routineRun;
});

const base = { botId: "bot-a", name: "Estoque", prompt: "verifique", triggerType: "interval" as const, trigger: { kind: "interval" as const, everyMinutes: 30 } };

test("createRoutine grava o alerta desarmado e devolve no registro", async () => {
	const { routine } = await createRoutine("user-a", { ...base, alert: { condition: "o estoque da canela cair abaixo de 10", hint: "produto canela" } });
	assert.deepEqual(writes[0]!.alertJson, { condition: "o estoque da canela cair abaixo de 10", hint: "produto canela", active: false });
	assert.equal(routine.alert?.condition, "o estoque da canela cair abaixo de 10");
	assert.equal(routine.alert?.active, false);
});

test("createRoutine recusa alerta em gatilho que não verifica por tempo e condição inválida", async () => {
	await assert.rejects(() => createRoutine("user-a", { ...base, triggerType: "once", trigger: { kind: "once", runAt: "2099-01-01T10:00:00.000Z" }, alert: { condition: "estoque baixo" } }), /horário ou por intervalo/);
	await assert.rejects(() => createRoutine("user-a", { ...base, triggerType: "event", trigger: { kind: "generic" }, alert: { condition: "estoque baixo" } }), /horário ou por intervalo/);
	await assert.rejects(() => createRoutine("user-a", { ...base, alert: { condition: " " } }), /alert\.condition/);
	assert.equal(writes.length, 0);
});

test("createRoutine sem alerta não grava alertJson", async () => {
	const { routine } = await createRoutine("user-a", base);
	assert.equal("alertJson" in writes[0]!, false);
	assert.equal(routine.alert, undefined);
});

test("updateRoutine: usuário B não altera o alerta da rotina de A", async () => {
	stored = { ...stored, userId: "user-a" };
	const client = prisma as unknown as { routine: { findFirst: unknown } };
	const original = client.routine.findFirst;
	client.routine.findFirst = async ({ where }: { where: { userId: string } }) => (where.userId === "user-a" ? { id: "r1", userId: "user-a", triggerType: "interval", triggerJson: { kind: "interval", everyMinutes: 30 }, schedule: null, alertJson: null } : null);
	try {
		assert.equal(await updateRoutine("user-b", "bot-a", "r1", { alert: { condition: "estoque baixo" } }), null);
		assert.equal(writes.length, 0);
		await updateRoutine("user-a", "bot-a", "r1", { alert: { condition: "estoque baixo" } });
		assert.deepEqual(writes[0]!.alertJson, { condition: "estoque baixo", active: false });
	} finally {
		client.routine.findFirst = original;
	}
});

test("updateRoutine: mesma condição mantém o estado, condição nova rearma, null remove", async () => {
	stored.alertJson = { condition: "estoque baixo", active: true, triggeredAt: "2026-10-01T10:00:00.000Z" };
	await updateRoutine("user-a", "bot-a", "r1", { alert: { condition: "estoque baixo", hint: "canela" } });
	assert.deepEqual(writes.at(-1)!.alertJson, { condition: "estoque baixo", hint: "canela", active: true, triggeredAt: "2026-10-01T10:00:00.000Z" });
	await updateRoutine("user-a", "bot-a", "r1", { alert: { condition: "estoque abaixo de 5" } });
	assert.deepEqual(writes.at(-1)!.alertJson, { condition: "estoque abaixo de 5", active: false });
	await updateRoutine("user-a", "bot-a", "r1", { alert: null });
	assert.ok(writes.at(-1)!.alertJson !== undefined && typeof writes.at(-1)!.alertJson === "object" && !("condition" in (writes.at(-1)!.alertJson as object)), "null vira DbNull");
	await updateRoutine("user-a", "bot-a", "r1", { name: "outro" });
	assert.equal("alertJson" in writes.at(-1)!, false, "omitido mantém o alerta");
});

test("updateRoutine recusa trocar para gatilho sem tempo enquanto há alerta", async () => {
	stored.alertJson = { condition: "estoque baixo", active: false };
	await assert.rejects(() => updateRoutine("user-a", "bot-a", "r1", { triggerType: "event" }), /horário ou por intervalo/);
	await assert.rejects(() => updateRoutine("user-a", "bot-a", "r1", { triggerType: "once", onceTrigger: { runAt: "2099-01-01T10:00:00.000Z" } }), /horário ou por intervalo/);
	// desligar o alerta junto com a troca é permitido
	await updateRoutine("user-a", "bot-a", "r1", { triggerType: "cron", schedule: "0 8 * * *", alert: null });
});

test("getRoutineAlertForAgentRun filtra pelo dono e só devolve rotina de alerta", async () => {
	const client = prisma as unknown as Record<string, Record<string, unknown>>;
	const original = client.routineRun;
	client.routineRun = {
		findFirst: async ({ where }: { where: { routine: { userId: { in: string[] } } } }) =>
			where.routine.userId.in.includes("user-a") ? { routine: { id: "r1", botId: "bot-a", name: "Estoque", alertJson: stored.alertJson, triggerType: "interval", triggerJson: { kind: "interval", everyMinutes: 120 } } } : null,
	};
	try {
		stored.alertJson = { condition: "estoque baixo", active: true };
		assert.deepEqual(await getRoutineAlertForAgentRun("run-1", "user-a"), { routineId: "r1", botId: "bot-a", name: "Estoque", alert: { condition: "estoque baixo", active: true }, interval: { everyMinutes: 120 } });
		assert.equal(await getRoutineAlertForAgentRun("run-1", "user-b"), null);
		assert.equal(await getRoutineAlertForAgentRun("run-1", "default"), null);
		assert.equal(await getRoutineAlertForAgentRun("run-1", undefined), null);
		stored.alertJson = null;
		assert.equal(await getRoutineAlertForAgentRun("run-1", "user-a"), null);
	} finally {
		client.routineRun = original!;
	}
});

test("recordRoutineAlertState: só o dono grava e só se a condição ainda é a avaliada", async () => {
	stored.alertJson = { condition: "estoque baixo", active: false };
	const next = { condition: "estoque baixo", active: true, triggeredAt: "2026-10-02T12:00:00.000Z" };
	assert.equal(await recordRoutineAlertState("user-b", "r1", next), false);
	assert.equal(await recordRoutineAlertState("default", "r1", next), false);
	assert.equal(await recordRoutineAlertState(undefined, "r1", next), false);
	assert.equal(writes.length, 0);
	// condição editada no meio da verificação: o estado velho não sobrescreve
	assert.equal(await recordRoutineAlertState("user-a", "r1", { ...next, condition: "outra condição" }), false);
	assert.equal(writes.length, 0);
	assert.equal(await recordRoutineAlertState("user-a", "r1", next), true);
	assert.deepEqual(writes[0]!.alertJson, next);
});

test("recordRoutineAlertState com backoff grava o novo intervalo junto, só em rotina de intervalo e só do dono", async () => {
	stored.alertJson = { condition: "estoque baixo", active: false };
	const next = { condition: "estoque baixo", active: false, quietStreak: 0, backoff: { base: 120, to: 240 } };
	assert.equal(await recordRoutineAlertState("user-b", "r1", next, 240), false);
	assert.equal(writes.length, 0);
	assert.equal(await recordRoutineAlertState("user-a", "r1", next, 240), true);
	assert.deepEqual(writes[0]!.triggerJson, { kind: "interval", everyMinutes: 240 });
	assert.equal(lastWhere.triggerType, "interval");
	assert.deepEqual(writes[0]!.alertJson, next);
	// sem novo intervalo (ou valor inválido) o gatilho não é tocado
	writes.length = 0;
	assert.equal(await recordRoutineAlertState("user-a", "r1", next), true);
	assert.equal(await recordRoutineAlertState("user-a", "r1", next, 0.5), true);
	assert.ok(writes.every((write) => !("triggerJson" in write)));
});

test("o estado de backoff do alerta sobrevive ao ciclo gravar/ler", () => {
	const alert = parseRoutineAlert({ condition: "x y z", active: false, quietStreak: 2, backoff: { base: 120, to: 240 } });
	assert.deepEqual(alert, { condition: "x y z", active: false, quietStreak: 2, backoff: { base: 120, to: 240 } });
	assert.equal(parseRoutineAlert({ condition: "x y z", active: false, backoff: { base: 240, to: 120 } })!.backoff, undefined);
});

test("getRoutineContextForAgentRun: nome e conversa do bot só para o dono da rotina", async () => {
	const client = prisma as unknown as Record<string, Record<string, unknown>>;
	const original = client.routineRun;
	client.routineRun = {
		findFirst: async ({ where }: { where: { routine: { userId: { in: string[] } } } }) =>
			where.routine.userId.in.includes("user-a") ? { routine: { id: "r1", name: "Estoque", botId: "bot-a" } } : null,
	};
	const botTable = new FakeTable([{ id: "bot-a", ownerId: "user-a", conversationId: "conv-a" }]);
	const fakes = installFakes({ bot: botTable });
	try {
		assert.deepEqual(await getRoutineContextForAgentRun("run-1", "user-a"), { routineId: "r1", name: "Estoque", conversationId: "conv-a" });
		assert.equal(await getRoutineContextForAgentRun("run-1", "user-b"), null);
		assert.equal(await getRoutineContextForAgentRun("run-1", "default"), null);
		assert.equal(await getRoutineContextForAgentRun("run-1", undefined), null);
	} finally {
		fakes.restore();
		client.routineRun = original!;
	}
});
