import assert from "node:assert/strict";
import { test } from "node:test";
import {
	ROUTINE_DEFER_DELAY_MS,
	ROUTINE_DEFER_MAX_MS,
	formatRoutineLogLine,
	isBlockedOnHuman,
	planBusyHandling,
} from "./routine-defer.js";

const T0 = new Date("2026-10-13T12:00:00.000Z");

test("evento com bot rodando: adia 60–120s em vez de pular", () => {
	const plan = planBusyHandling({
		triggeredBy: "event",
		kind: "bot_busy",
		activeStatuses: ["running"],
		now: T0,
	});
	assert.equal(plan.action, "defer");
	if (plan.action !== "defer") return;
	assert.ok(plan.delayMs >= 60_000 && plan.delayMs <= 120_000);
	assert.equal(plan.delayMs, ROUTINE_DEFER_DELAY_MS);
	assert.equal(plan.reason, "O bot já está ocupado");
});

test("run pausado/aguardando usuário também adia (índice único impede rodar em paralelo) e o motivo explica", () => {
	for (const status of ["paused", "waiting_user", "waiting_external"]) {
		const plan = planBusyHandling({
			triggeredBy: "event",
			kind: "bot_busy",
			activeStatuses: [status],
			now: T0,
		});
		assert.equal(plan.action, "defer");
		assert.match(plan.reason, /aguardando uma resposta sua/);
	}
	assert.equal(isBlockedOnHuman(["paused", "waiting_user"]), true);
	assert.equal(isBlockedOnHuman(["paused", "running"]), false);
	assert.equal(isBlockedOnHuman([]), false);
});

test("overlap da própria rotina em evento também adia", () => {
	const plan = planBusyHandling({ triggeredBy: "event", kind: "overlap", activeStatuses: [], now: T0 });
	assert.equal(plan.action, "defer");
	assert.equal(plan.reason, "Já há uma execução em andamento");
});

test("passada a janela de ~30 min, pula com o motivo e a espera", () => {
	const since = new Date(T0.getTime() - ROUTINE_DEFER_MAX_MS + 10_000).toISOString();
	const plan = planBusyHandling({
		triggeredBy: "event",
		kind: "bot_busy",
		activeStatuses: ["waiting_user"],
		deferredSince: since,
		now: T0,
	});
	assert.equal(plan.action, "skip");
	assert.match(plan.reason, /aguardando uma resposta sua/);
	assert.match(plan.reason, /30 min/);
});

test("ainda dentro da janela continua adiando", () => {
	const since = new Date(T0.getTime() - 10 * 60_000).toISOString();
	const plan = planBusyHandling({
		triggeredBy: "event",
		kind: "bot_busy",
		activeStatuses: ["running"],
		deferredSince: since,
		now: T0,
	});
	assert.equal(plan.action, "defer");
});

test("manual não adia (quem clicou vê o resultado na hora)", () => {
	const plan = planBusyHandling({ triggeredBy: "manual", kind: "bot_busy", activeStatuses: ["running"], now: T0 });
	assert.equal(plan.action, "skip");
	assert.equal(plan.reason, "O bot já está ocupado");
});

test("agendada com bot ocupado adia em vez de perder o horário", () => {
	const plan = planBusyHandling({ triggeredBy: "schedule", kind: "bot_busy", activeStatuses: ["running"], now: T0 });
	assert.equal(plan.action, "defer");
	if (plan.action !== "defer") return;
	assert.equal(plan.delayMs, ROUTINE_DEFER_DELAY_MS);
});

test("agendada sobreposta à própria rotina pula sem empilhar adiados", () => {
	const plan = planBusyHandling({ triggeredBy: "schedule", kind: "overlap", activeStatuses: [], now: T0 });
	assert.equal(plan.action, "skip");
	if (plan.action === "skip") assert.notEqual(plan.notify, true);
});

test("agendada que esgota a janela pula e pede aviso ao usuário; evento não pede", () => {
	const since = new Date(T0.getTime() - ROUTINE_DEFER_MAX_MS + 10_000).toISOString();
	const scheduled = planBusyHandling({ triggeredBy: "schedule", kind: "bot_busy", activeStatuses: ["running"], deferredSince: since, now: T0 });
	assert.equal(scheduled.action, "skip");
	if (scheduled.action === "skip") assert.equal(scheduled.notify, true);
	const event = planBusyHandling({ triggeredBy: "event", kind: "bot_busy", activeStatuses: ["running"], deferredSince: since, now: T0 });
	assert.equal(event.action, "skip");
	if (event.action === "skip") assert.notEqual(event.notify, true);
});

test("formatRoutineLogLine: ids, status, motivo e agentRun; sem payload", () => {
	const line = formatRoutineLogLine({
		result: { routineId: "r1", routineRunId: "run1", status: "skipped" },
		triggeredBy: "event",
		reason: "O bot já está ocupado",
	});
	assert.equal(
		line,
		'[routine] run=run1 routine=r1 triggeredBy=event status=skipped reason="O bot já está ocupado"',
	);
	const running = formatRoutineLogLine({
		result: { routineId: "r1", routineRunId: "run1", status: "running", agentRunId: "ar1" },
		triggeredBy: "event",
	});
	assert.equal(running, "[routine] run=run1 routine=r1 triggeredBy=event status=running agentRun=ar1");
});
