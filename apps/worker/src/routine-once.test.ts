import assert from "node:assert/strict";
import { test } from "node:test";
import { planOnceRoutine, shouldAutoDeleteAfterRun } from "@workspace/shared";

const NOW = new Date("2026-09-28T12:00:00.000Z");

test("planOnceRoutine: agenda quando o horário ainda não chegou", () => {
	const runAt = new Date(NOW.getTime() + 10 * 60_000).toISOString();
	const plan = planOnceRoutine(runAt, NOW);
	assert.equal(plan.action, "schedule");
	if (plan.action === "schedule") assert.equal(plan.delayMs, 10 * 60_000);
});

test("planOnceRoutine: roda agora quando o atraso é pequeno (dentro de 1h)", () => {
	const runAt = new Date(NOW.getTime() - 5 * 60_000).toISOString();
	assert.deepEqual(planOnceRoutine(runAt, NOW), { action: "run-now" });
});

test("planOnceRoutine: ainda roda agora exatamente na borda de 1h de atraso", () => {
	const runAt = new Date(NOW.getTime() - 60 * 60_000).toISOString();
	assert.deepEqual(planOnceRoutine(runAt, NOW), { action: "run-now" });
});

test("planOnceRoutine: perdida passado 1h de atraso", () => {
	const runAt = new Date(NOW.getTime() - (60 * 60_000 + 1_000)).toISOString();
	assert.deepEqual(planOnceRoutine(runAt, NOW), { action: "missed" });
});

test("planOnceRoutine: runAt inválido conta como perdida", () => {
	assert.deepEqual(planOnceRoutine("lixo", NOW), { action: "missed" });
});

// `cleanupOnceRoutineAfterRun` (packages/db) delega a decisão "apaga depois
// de rodar?" pra este helper puro — testado aqui porque a versão com Prisma
// real exigiria um Postgres de integração (fora do escopo deste worker).
test("shouldAutoDeleteAfterRun: só rotinas 'once' se auto-apagam depois de rodar", () => {
	assert.equal(shouldAutoDeleteAfterRun("once"), true);
	assert.equal(shouldAutoDeleteAfterRun("cron"), false);
	assert.equal(shouldAutoDeleteAfterRun("event"), false);
});
