/** Limite de 30 alertas ativos por pessoa e fechamento direto da execução (alerta com regra, sem modelo). */
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { ALERT_ACTIVE_LIMIT } from "@workspace/shared";
import { prisma } from "./client.js";
import { FakeTable, installFakes } from "./testing/fake-tables.js";
import { AlertLimitError, countActiveAlerts, createRoutine, recordRoutineAlertState, settleRoutineRunDirect, updateRoutine } from "./routines.js";

type Row = { id: string; userId: string; enabled: boolean; alertJson: unknown; triggerType?: string };
type RunRow = { id: string; routineId: string; status: string; summary?: string | null; error?: string | null; finishedAt?: Date | null; startedAt?: Date | null };

let rows: Row[];
let runs: RunRow[];
let routineWrites: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }>;
let installed: { restore: () => void };
const originals: Record<string, unknown> = {};

const alertJson = { condition: "estoque baixo", active: false };
const seed = (userId: string, count: number, extra: Partial<Row> = {}) => {
	for (let i = 0; i < count; i += 1) rows.push({ id: `${userId}-${rows.length}`, userId, enabled: true, alertJson, ...extra });
};

beforeEach(() => {
	rows = [];
	runs = [{ id: "run-a", routineId: "ra", status: "queued" }];
	routineWrites = [];
	installed = installFakes({ bot: new FakeTable([{ id: "bot-a", ownerId: "user-a", conversationId: null, openRouterModel: "m" }, { id: "bot-b", ownerId: "user-b", conversationId: null, openRouterModel: "m" }]) });
	const client = prisma as unknown as Record<string, Record<string, unknown>>;
	originals.routine = client.routine;
	// A gravação do alerta ativo roda numa transação com advisory lock (Postgres real nos testes .db): aqui a transação é só repasse.
	originals.$transaction = (prisma as unknown as Record<string, unknown>).$transaction;
	Object.assign(prisma, { $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma), $executeRaw: async () => 1 });
	originals.routineRun = client.routineRun;
	const owned = (where: { userId?: { in: string[] }; id?: string }) => (row: Row) => (!where.userId || where.userId.in.includes(row.userId)) && (!where.id || where.id === row.id);
	const full = (row: Row) => ({ ...row, botId: "bot-a", createdAt: new Date(), updatedAt: new Date(), lastRunAt: null, timezone: "America/Sao_Paulo", model: "m", notify: "always", createdBy: "user", triggerJson: { kind: "interval", everyMinutes: 120 }, triggerType: row.triggerType ?? "interval", name: "Alerta", prompt: "x", schedule: null });
	client.routine = {
		// Mesma semântica do banco: enabled + alertJson não nulo, escopado pelo dono.
		count: async ({ where }: { where: { userId: { in: string[] }; enabled: boolean } }) => rows.filter(owned(where)).filter((row) => row.enabled === where.enabled && row.alertJson !== null).length,
		create: async ({ data }: { data: Record<string, unknown> }) => full({ id: "novo", userId: String(data.userId), enabled: data.enabled !== false, alertJson: data.alertJson ?? null }),
		findFirst: async ({ where }: { where: { id: string; userId: string } }) => rows.filter((row) => row.id === where.id && row.userId === where.userId).map(full)[0] ?? null,
		update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
			routineWrites.push({ where, data });
			return full(rows.find((row) => row.id === where.id)!);
		},
		updateMany: async ({ where, data }: { where: { id: string; userId: { in: string[] } }; data: Record<string, unknown> }) => {
			routineWrites.push({ where, data });
			return { count: rows.filter(owned(where)).length };
		},
	};
	client.routineRun = {
		updateMany: async ({ where, data }: { where: { id: string; status: { in: string[] }; routine: { userId: { in: string[] } } }; data: Record<string, unknown> }) => {
			const run = runs.find((r) => r.id === where.id && where.status.in.includes(r.status));
			const routine = rows.find((row) => row.id === run?.routineId);
			if (!run || !routine || !where.routine.userId.in.includes(routine.userId)) return { count: 0 };
			Object.assign(run, data);
			return { count: 1 };
		},
		findFirst: async ({ where }: { where: { id: string; routine: { userId: { in: string[] } } } }) => {
			const run = runs.find((r) => r.id === where.id);
			const routine = rows.find((row) => row.id === run?.routineId);
			return run && routine && where.routine.userId.in.includes(routine.userId) ? { routineId: run.routineId } : null;
		},
	};
});
afterEach(() => {
	installed.restore();
	(prisma as unknown as Record<string, unknown>).routine = originals.routine;
	(prisma as unknown as Record<string, unknown>).$transaction = originals.$transaction;
	(prisma as unknown as Record<string, unknown>).routineRun = originals.routineRun;
});

const base = { botId: "bot-a", name: "Alerta", prompt: "verifique", triggerType: "interval" as const, trigger: { kind: "interval" as const, everyMinutes: 120 } };

test("countActiveAlerts conta só alertas ligados do dono (pausado, sem alerta e de outro usuário ficam de fora)", async () => {
	seed("user-a", 3);
	seed("user-a", 2, { enabled: false });
	seed("user-a", 4, { alertJson: null });
	seed("user-b", 30);
	assert.equal(await countActiveAlerts("user-a"), 3);
	assert.equal(await countActiveAlerts("user-b"), 30);
	assert.equal(await countActiveAlerts("default"), 0);
	assert.equal(await countActiveAlerts(undefined), 0);
});

test("createRoutine: o 31º alerta é recusado com mensagem amigável; o 30º passa", async () => {
	seed("user-a", ALERT_ACTIVE_LIMIT - 1);
	await createRoutine("user-a", { ...base, alert: { condition: "estoque baixo" } });
	seed("user-a", 1);
	await assert.rejects(() => createRoutine("user-a", { ...base, alert: { condition: "estoque baixo" } }), (error: unknown) => error instanceof AlertLimitError && /30 alertas ativos/.test(error.message) && /Pause ou apague/.test(error.message));
});

test("createRoutine: os 30 alertas de outro usuário não bloqueiam; rotina sem alerta e alerta pausado ignoram o limite", async () => {
	seed("user-b", 30);
	await createRoutine("user-a", { ...base, alert: { condition: "estoque baixo" } });
	seed("user-a", 30);
	await createRoutine("user-a", base);
	await createRoutine("user-a", { ...base, enabled: false, alert: { condition: "estoque baixo" } });
});

test("updateRoutine: religar ou ligar alerta no limite é recusado; editar um alerta que já conta não", async () => {
	seed("user-a", 29);
	rows.push({ id: "pausado", userId: "user-a", enabled: false, alertJson }, { id: "comum", userId: "user-a", enabled: true, alertJson: null });
	rows.push({ id: "ativo", userId: "user-a", enabled: true, alertJson });
	await assert.rejects(() => updateRoutine("user-a", "bot-a", "pausado", { enabled: true }), AlertLimitError);
	await assert.rejects(() => updateRoutine("user-a", "bot-a", "comum", { alert: { condition: "agora é alerta" } }), AlertLimitError);
	await updateRoutine("user-a", "bot-a", "ativo", { alert: { condition: "outra condição" } });
	await updateRoutine("user-a", "bot-a", "ativo", { enabled: false });
	await updateRoutine("user-a", "bot-a", "comum", { name: "só renomeia" });
	// liberou uma vaga: agora o pausado volta
	rows.splice(rows.findIndex((row) => row.id === "ativo"), 1);
	await updateRoutine("user-a", "bot-a", "pausado", { enabled: true });
});

test("settleRoutineRunDirect fecha só a execução do dono e só enquanto ativa", async () => {
	rows.push({ id: "ra", userId: "user-a", enabled: true, alertJson });
	assert.equal(await settleRoutineRunDirect("user-b", "run-a", { status: "succeeded", summary: "x" }), false);
	assert.equal(await settleRoutineRunDirect("default", "run-a", { status: "succeeded" }), false);
	assert.equal(await settleRoutineRunDirect(undefined, "run-a", { status: "succeeded" }), false);
	assert.equal(runs[0]!.status, "queued");
	assert.equal(routineWrites.length, 0, "outro usuário não mexe nem em lastRunAt");
	assert.equal(await settleRoutineRunDirect("user-a", "run-a", { status: "succeeded", summary: "  Tênis está em R$ 449,90 " }), true);
	assert.deepEqual({ status: runs[0]!.status, summary: runs[0]!.summary, error: runs[0]!.error }, { status: "succeeded", summary: "Tênis está em R$ 449,90", error: null });
	assert.ok(runs[0]!.finishedAt instanceof Date);
	assert.ok(routineWrites.some((write) => write.data.lastRunAt instanceof Date && (write.where.userId as { in: string[] }).in[0] === "user-a"));
	// já fechada: não reabre nem sobrescreve
	assert.equal(await settleRoutineRunDirect("user-a", "run-a", { status: "failed", error: "x" }), false);
	assert.equal(runs[0]!.status, "succeeded");
});

test("settleRoutineRunDirect guarda o motivo quando a conferência falha", async () => {
	rows.push({ id: "ra", userId: "user-a", enabled: true, alertJson });
	assert.equal(await settleRoutineRunDirect("user-a", "run-a", { status: "failed", error: "o site não respondeu a tempo" }), true);
	assert.deepEqual({ status: runs[0]!.status, error: runs[0]!.error }, { status: "failed", error: "o site não respondeu a tempo" });
});

test("recordRoutineAlertState com regra só grava se a regra ainda é a avaliada", async () => {
	const rule = { source: { type: "page", url: "https://a.example.com/", extract: { kind: "css", selector: ".p" } }, check: { kind: "value", parse: "money", op: "lt", value: 400 } } as never;
	rows.push({ id: "ra", userId: "user-a", enabled: true, alertJson });
	await recordRoutineAlertState("user-a", "ra", { condition: "x", active: false, rule });
	const guard = routineWrites[0]!.where as { AND?: Array<{ alertJson: { path: string[]; equals: unknown } }> };
	assert.deepEqual(guard.AND?.[0]?.alertJson.path, ["rule"]);
	assert.deepEqual(guard.AND?.[0]?.alertJson.equals, rule);
	routineWrites.length = 0;
	await recordRoutineAlertState("user-a", "ra", { condition: "x", active: false });
	assert.equal("AND" in routineWrites[0]!.where, false);
});
