/**
 * Worker de wake da agenda (F4.3): decisões antes do run e criação dele, com db e fila falsos.
 * Runner: `NODE_ENV=test ATLAS_HOOK_PEPPER=test-pepper pnpm exec tsx --test src/agenda-wake.test.ts`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgendaItemRecord, AgendaWakeDecision } from "@workspace/db";
import { DEFAULT_PROACTIVE_SETTINGS, readEngineV4Gate, type AgendaEvent } from "@workspace/shared";
import { agendaObjective, dispatchAgendaItem, isAgendaWakeObjective, parseAgendaEvent, processAgenda, wakeAgendaForEvent, type AgendaWakeDeps, type AgendaWakeResult } from "./agenda-wake.js";

const NOW = new Date("2026-11-05T12:00:00.000Z");
const GATE_ON = readEngineV4Gate("true", "user-a");

const item = (over: Partial<AgendaItemRecord> = {}): AgendaItemRecord => ({
	id: "i1", userId: "user-a", botId: "bot-1", conversationId: "conv-1", kind: "watch", status: "pending", note: "Ver o preço do notebook X", dueAt: NOW, requestedFor: NOW,
	intervalMinutes: 120, untilAt: null, maxRuns: null, runCount: 0, eventFilter: null, noChangeStreak: 0, ignoredStreak: 0, missingResults: 0, lastResult: null, lastNoticeAt: null,
	grant: { autonomy: "balanced", rules: [] }, runId: null, endReason: null, sourceRunId: null, reservedUntil: null, createdAt: NOW, ...over,
});

function harness(over: Partial<AgendaWakeDeps> & { decision?: AgendaWakeDecision; busyRuns?: number; runAlive?: boolean } = {}) {
	const calls = { created: [] as Array<{ userId: string; objective: string; conversationId: string | null; origin: string | undefined }>, begun: [] as Array<{ id: string; runId: string }>, rescheduled: [] as Array<{ id: string; dueAt: Date; countAttempt?: boolean; error?: string }>, stopped: [] as Array<{ id: string; reason: string }>, enqueued: [] as string[], logs: [] as string[] };
	const deps: AgendaWakeDeps = {
		v4Gate: GATE_ON,
		enqueueRun: async (runId) => (calls.enqueued.push(runId), true),
		envDefaultModel: "test/model",
		now: () => NOW,
		log: (line) => void calls.logs.push(line),
		loadBot: async (userId, botId) => (userId === "user-a" && botId === "bot-1" ? { id: "bot-1", conversationId: "conv-1" } : null),
		loadSettings: async () => ({ ...DEFAULT_PROACTIVE_SETTINGS, enabled: true }),
		decide: async (it) => over.decision ?? { action: "run", item: it },
		inFlight: async () => over.runAlive === true,
		activeRuns: async () => Array.from({ length: over.busyRuns ?? 0 }, () => ({}) as never),
		createRun: (async (input: { userId: string; request: { objective?: string; conversationId?: string; origin?: string } }) => {
			calls.created.push({ userId: input.userId, objective: input.request.objective ?? "", conversationId: input.request.conversationId ?? null, origin: input.request.origin });
			return { id: "run-1", origin: input.request.origin, objective: input.request.objective };
		}) as unknown as AgendaWakeDeps["createRun"],
		begin: async (it, runId) => void calls.begun.push({ id: it.id, runId }),
		reschedule: async (_u, id, input) => void calls.rescheduled.push({ id, ...input }),
		stop: async (_u, id, reason) => void calls.stopped.push({ id, reason }),
		resolveModel: async () => "test/model",
		claimPending: async () => [],
		markPending: async () => true,
		clearPending: async () => undefined,
		...Object.fromEntries(Object.entries(over).filter(([key]) => !["decision", "busyRuns", "runAlive"].includes(key))),
	};
	return { deps, calls };
}
const fresh = (): AgendaWakeResult => ({ run: 0, deferred: 0, stopped: 0, coalesced: 0 });

test("item vencido vira run de origem proativa na conversa do bot, silencioso, e entra na fila", async () => {
	const { deps, calls } = harness();
	const result = fresh();
	await dispatchAgendaItem(item(), deps, result);
	assert.deepEqual(result, { run: 1, deferred: 0, stopped: 0, coalesced: 0 });
	assert.deepEqual(calls.created, [{ userId: "user-a", objective: "Agenda wake (watch): Ver o preço do notebook X", conversationId: "conv-1", origin: "proactive" }]);
	assert.deepEqual(calls.begun, [{ id: "i1", runId: "run-1" }]);
	assert.deepEqual(calls.enqueued, ["run-1"]);
});

test("sem v4 ligado para a conta: não cria run, adia 6h sem gastar tentativa e volta quando a flag voltar", async () => {
	const { deps, calls } = harness({ v4Gate: readEngineV4Gate("true", "outro") });
	const result = fresh();
	await dispatchAgendaItem(item(), deps, result);
	assert.equal(calls.created.length, 0);
	assert.equal(result.deferred, 1);
	assert.equal(calls.rescheduled[0]?.dueAt.toISOString(), "2026-11-05T18:00:00.000Z");
	assert.equal(calls.rescheduled[0]?.countAttempt, undefined);
	assert.match(calls.logs[0] ?? "", /reason=v4_off/);
});

test("freios do db: parar não cria run", async () => {
	for (const decision of [{ action: "stop", reason: "ignored_notices" }, { action: "stop", reason: "max_runs" }] as AgendaWakeDecision[]) {
		const { deps, calls } = harness({ decision });
		const result = fresh();
		await dispatchAgendaItem(item(), deps, result);
		assert.equal(calls.created.length, 0);
		assert.equal(result.stopped, 1);
	}
});

test("run anterior ainda vivo (ou conversa ocupada): adia sem empilhar outro run", async () => {
	const a = harness({ runAlive: true });
	const ra = fresh();
	await dispatchAgendaItem(item({ runId: "run-0" }), a.deps, ra);
	assert.equal(a.calls.created.length, 0);
	assert.match(a.calls.logs[0] ?? "", /run_in_flight/);
	const b = harness({ busyRuns: 1 });
	const rb = fresh();
	await dispatchAgendaItem(item(), b.deps, rb);
	assert.equal(b.calls.created.length, 0);
	assert.equal(b.calls.rescheduled[0]?.dueAt.toISOString(), "2026-11-05T12:02:00.000Z");
});

test("corrida: o create devolveu o run ativo de outro assunto na conversa, então o item volta à fila sem contar execução", async () => {
	const { deps, calls } = harness({
		createRun: (async () => ({ id: "run-chat", origin: "chat", objective: "oi" })) as unknown as AgendaWakeDeps["createRun"],
	});
	const result = fresh();
	await dispatchAgendaItem(item(), deps, result);
	assert.equal(calls.begun.length, 0);
	assert.equal(calls.enqueued.length, 0);
	assert.match(calls.logs[0] ?? "", /bot_busy_race/);
});

test("bot sumiu: tenta de novo até o limite e então encerra o item (sem laço infinito)", async () => {
	const { deps, calls } = harness({ loadBot: async () => null });
	const first = fresh();
	await dispatchAgendaItem(item({ missingResults: 0 }), deps, first);
	assert.equal(calls.rescheduled[0]?.countAttempt, true);
	const last = fresh();
	await dispatchAgendaItem(item({ missingResults: 4 }), deps, last);
	assert.deepEqual(calls.stopped, [{ id: "i1", reason: "unavailable" }]);
	assert.equal(last.stopped, 1);
});

test("falha ao criar o run: conta a tentativa e agenda de novo; na quinta encerra", async () => {
	const boom = (async () => {
		throw new Error("db fora do ar");
	}) as unknown as AgendaWakeDeps["createRun"];
	const { deps, calls } = harness({ createRun: boom });
	await dispatchAgendaItem(item({ missingResults: 1 }), deps, fresh());
	assert.deepEqual(calls.rescheduled.map((r) => [r.countAttempt, r.error]), [[true, "db fora do ar"]]);
	await dispatchAgendaItem(item({ missingResults: 4 }), deps, fresh());
	assert.deepEqual(calls.stopped, [{ id: "i1", reason: "unavailable" }]);
});

test("processAgenda despacha só o que o db reservou e um item com erro não derruba os outros", async () => {
	const { deps, calls } = harness({
		claimDue: async () => [item({ id: "a" }), item({ id: "b", botId: "bot-x" }), item({ id: "c" })],
	});
	const result = await processAgenda(deps);
	assert.equal(result.run, 2);
	assert.equal(calls.created.length, 2);
	assert.equal(result.deferred, 1);
});

test("intenção pega pelo relógio sem evento só serve para expirar: não roda e não mexe na vigência", async () => {
	const intent = item({ kind: "intent", intervalMinutes: null, untilAt: new Date("2026-12-05T12:00:00.000Z"), dueAt: new Date("2026-12-05T12:00:00.000Z") });
	const { deps, calls } = harness();
	await dispatchAgendaItem(intent, deps, fresh());
	assert.equal(calls.created.length, 0);
	assert.equal(calls.rescheduled[0]?.dueAt.toISOString(), "2026-12-05T12:00:00.000Z");
	const expired = harness({ decision: { action: "stop", reason: "expired" } });
	const result = fresh();
	await dispatchAgendaItem(intent, expired.deps, result);
	assert.equal(result.stopped, 1);
});

const EVENT: AgendaEvent = { source: "email", from: "fatura@banco.com", subject: "Sua fatura", hasAttachment: true };

test("evento: acorda o item que o filtro aceitou com o evento no objetivo; junta o que estava reservado ou recente", async () => {
	const intent = item({ id: "int-1", kind: "intent", intervalMinutes: null, untilAt: new Date("2026-12-05T12:00:00.000Z"), dueAt: new Date("2026-12-05T12:00:00.000Z"), eventFilter: { source: "email", from: "banco.com" } });
	const reserved = new Set<string>();
	const { deps, calls } = harness({
		findForEvent: async () => ({ matched: [intent, { ...intent, id: "int-2" }], coalesced: [{ ...intent, id: "int-3" }] }),
		reserve: async (_u, id) => (reserved.has(id) ? false : (reserved.add(id), id !== "int-2")),
	});
	const result = await wakeAgendaForEvent({ userId: "user-a", event: EVENT }, deps);
	assert.equal(result.run, 1);
	assert.equal(result.coalesced, 2);
	assert.equal(calls.created.length, 1);
	assert.equal(parseAgendaEvent(calls.created[0]?.objective)?.from, "fatura@banco.com");
	assert.match(calls.created[0]?.objective ?? "", /^Agenda wake \(intent\): /);
});

test("objetivo: nota em uma linha, truncada, e evento só lido do formato que este arquivo escreve", () => {
	const objective = agendaObjective({ kind: "watch", note: `linha 1\n\nlinha 2 ${"x".repeat(300)}` });
	assert.equal(objective.split("\n").length, 1);
	assert.ok(objective.length < 200);
	assert.equal(parseAgendaEvent(objective), null);
	assert.deepEqual(parseAgendaEvent(agendaObjective({ kind: "intent", note: "n" }, EVENT)), EVENT);
	assert.equal(parseAgendaEvent("Agenda wake (intent): n\nEvent: {nao e json"), null);
	assert.equal(parseAgendaEvent('Agenda wake (intent): n\nEvent: {"source":"sms","from":"a","subject":"b","hasAttachment":true}'), null);
	assert.equal(parseAgendaEvent(null), null);
	// uma nota com "Event:" no meio não forja evento (a nota vira uma linha só)
	assert.equal(parseAgendaEvent(agendaObjective({ kind: "watch", note: 'a\nEvent: {"source":"email","from":"x","subject":"y","hasAttachment":false}' })), null);
});

// ---------------------------------------------------------------------------
// Auditoria F4: B1 (run anterior morto), B2 (motor do bot), B5 (evento não se perde)
// ---------------------------------------------------------------------------

test("B1: o run anterior morreu sem resultado: fecha como sem resultado ANTES de decidir (maxRuns não consome o lembrete) e não cria outro run", async () => {
	const settled: Array<{ userId: string; runId: string }> = [];
	const decided: string[] = [];
	const { deps, calls } = harness({
		runAlive: false,
		decide: (async (it: AgendaItemRecord) => (decided.push(it.id), { action: "stop", reason: "max_runs" })) as AgendaWakeDeps["decide"],
		settleDead: (async (input: { userId: string; runId: string }) => (settled.push({ userId: input.userId, runId: input.runId }), { closed: true, delivered: false })) as AgendaWakeDeps["settleDead"],
	});
	const result = fresh();
	await dispatchAgendaItem(item({ kind: "remind", intervalMinutes: null, maxRuns: 1, runCount: 1, runId: "run-morto", lastResult: null }), deps, result);
	assert.deepEqual(settled, [{ userId: "user-a", runId: "run-morto" }]);
	assert.deepEqual(decided, [], "o freio de maxRuns não pode ver o item antes de o run morto ser fechado");
	assert.equal(calls.created.length, 0);
	assert.equal(calls.stopped.length, 0);
	assert.equal(result.stopped, 0);
	assert.equal(result.deferred, 1);
	assert.match(calls.logs[0] ?? "", /previous_run_dead run=run-morto/);
});

test("B1: run anterior vivo, ou já fechado (lastResult do mesmo run), não passa pelo fechamento de morto", async () => {
	let settled = 0;
	const settleDead = (async () => (settled += 1, { closed: true, delivered: false })) as AgendaWakeDeps["settleDead"];
	const alive = harness({ runAlive: true, settleDead });
	await dispatchAgendaItem(item({ runId: "run-0", runCount: 1 }), alive.deps, fresh());
	const closed = harness({ runAlive: false, settleDead });
	const result = fresh();
	await dispatchAgendaItem(item({ runId: "run-0", runCount: 1, lastResult: { runId: "run-0", outcome: "no_change", at: NOW.toISOString() } }), closed.deps, result);
	assert.equal(settled, 0);
	assert.equal(result.run, 1);
});

test("B1: intenção cujo run morreu fica marcada com evento pendente (não há relógio para voltar)", async () => {
	const marked: string[] = [];
	const { deps } = harness({
		runAlive: false,
		settleDead: (async () => ({ closed: true, delivered: false })) as AgendaWakeDeps["settleDead"],
		markPending: async (_u, id) => (marked.push(id), true),
	});
	await dispatchAgendaItem(item({ id: "int-9", kind: "intent", intervalMinutes: null, runId: "run-morto", runCount: 1 }), deps, fresh(), EVENT);
	assert.deepEqual(marked, ["int-9"]);
});

test("B2: bot com o motor fixado em v1 (ou v2 fora do v4): adia sem criar run e sem gastar tentativa", async () => {
	for (const policyJson of [{ engine: "v1" }]) {
		const { deps, calls } = harness({ loadBot: async () => ({ id: "bot-1", conversationId: "conv-1", policyJson }) });
		const result = fresh();
		await dispatchAgendaItem(item({ kind: "remind", intervalMinutes: null }), deps, result);
		assert.equal(calls.created.length, 0);
		assert.equal(result.deferred, 1);
		assert.equal(calls.rescheduled[0]?.countAttempt, undefined);
		assert.equal(calls.rescheduled[0]?.dueAt.toISOString(), "2026-11-05T12:30:00.000Z");
		assert.match(calls.logs[0] ?? "", /engine_not_v4/);
	}
	// bot sem motor fixado e flag ligada: segue para o v4
	const ok = harness({ loadBot: async () => ({ id: "bot-1", conversationId: "conv-1", policyJson: {} }) });
	const result = fresh();
	await dispatchAgendaItem(item(), ok.deps, result);
	assert.equal(result.run, 1);
});

test("B5: evento junto demais (reserva ativa/recente ou reserva perdida) deixa o item marcado para rodar depois, sem perder o evento", async () => {
	const intent = item({ id: "int-1", kind: "intent", intervalMinutes: null, untilAt: new Date("2026-12-05T12:00:00.000Z"), dueAt: new Date("2026-12-05T12:00:00.000Z"), eventFilter: { source: "email", from: "banco.com" } });
	const marked: string[] = [];
	const { deps, calls } = harness({
		findForEvent: async () => ({ matched: [{ ...intent, id: "int-2" }], coalesced: [intent] }),
		reserve: async () => false,
		markPending: async (_u, id) => (marked.push(id), true),
	});
	const result = await wakeAgendaForEvent({ userId: "user-a", event: EVENT }, deps);
	assert.equal(result.run, 0);
	assert.equal(calls.created.length, 0);
	assert.deepEqual(marked.sort(), ["int-1", "int-2"]);
});

test("B5: a varredura acorda o item com evento pendente (sem evento no objetivo) e tira a marca ao criar o run", async () => {
	const intent = item({ id: "int-1", kind: "intent", intervalMinutes: null, untilAt: new Date("2026-12-05T12:00:00.000Z"), dueAt: new Date("2026-12-05T12:00:00.000Z") });
	const cleared: string[] = [];
	const { deps, calls } = harness({ claimDue: async () => [], claimPending: async () => [intent], clearPending: async (_u, id) => void cleared.push(id) });
	const result = await processAgenda(deps);
	assert.equal(result.run, 1);
	assert.match(calls.created[0]?.objective ?? "", /^Agenda wake \(intent\): /);
	assert.equal(parseAgendaEvent(calls.created[0]?.objective), null);
	assert.deepEqual(cleared, ["int-1"]);
});

test("B5: falha da varredura de eventos pendentes não derruba a passada dos itens vencidos", async () => {
	const { deps } = harness({ claimDue: async () => [item()], claimPending: async () => { throw new Error("db fora do ar"); }, log: () => undefined });
	const result = await processAgenda(deps);
	assert.equal(result.run, 1);
});

test("B3: só o objetivo de wake escrito por este arquivo conta como run de agenda", () => {
	assert.equal(isAgendaWakeObjective(agendaObjective({ kind: "remind", note: "n" })), true);
	assert.equal(isAgendaWakeObjective("Follow-up: ver o preço"), false);
	assert.equal(isAgendaWakeObjective(null), false);
});

test("plano do dia (F7.2): roda com o modelo de ajudante do bot (helperModel) quando existe; os outros tipos seguem o modelo do bot", async () => {
	const models: string[] = [];
	const create = (async (input: { model: string; request: { objective?: string; origin?: string } }) => (models.push(input.model), { id: "run-1", origin: input.request.origin, objective: input.request.objective })) as unknown as AgendaWakeDeps["createRun"];
	const withHelper = harness({ createRun: create, loadBot: async () => ({ id: "bot-1", conversationId: "conv-1", policyJson: { helperModel: "anthropic/claude-haiku-5.5" } }) });
	await dispatchAgendaItem(item({ kind: "brief", intervalMinutes: 1440 }), withHelper.deps, fresh());
	await dispatchAgendaItem(item({ kind: "watch" }), withHelper.deps, fresh());
	assert.deepEqual(models, ["anthropic/claude-haiku-5.5", "test/model"]);
	// Sem helperModel (ou com valor inválido), o brief usa o modelo barato do deploy, nunca o de chat do bot.
	models.length = 0;
	const without = harness({ createRun: create, cheapModel: () => "test/barato", loadBot: async () => ({ id: "bot-1", conversationId: "conv-1", policyJson: { helperModel: "modelo com espaço!" } }) });
	await dispatchAgendaItem(item({ kind: "brief", intervalMinutes: 1440 }), without.deps, fresh());
	await dispatchAgendaItem(item({ kind: "watch" }), without.deps, fresh());
	assert.deepEqual(models, ["test/barato", "test/model"]);
});

test("plano do dia sem helperModel e sem cheapModel injetado usa o padrão barato do deploy (Haiku)", async () => {
	const models: string[] = [];
	const create = (async (input: { model: string; request: { objective?: string; origin?: string } }) => (models.push(input.model), { id: "run-1", origin: input.request.origin, objective: input.request.objective })) as unknown as AgendaWakeDeps["createRun"];
	const { deps } = harness({ createRun: create });
	await dispatchAgendaItem(item({ kind: "brief", intervalMinutes: 1440 }), deps, fresh());
	assert.equal(models[0], "anthropic/claude-haiku-5.5");
});

test("plano do dia encerrado por avisos ignorados: o dono é avisado uma vez, no idioma do bot; outros tipos e outros motivos não avisam", async () => {
	const sent: Array<{ conversationId: string; text: string }> = [];
	const base = { language: async () => "en-US", deliver: async (conversationId: string, text: string) => void sent.push({ conversationId, text }) };
	const stop = harness({ ...base, decision: { action: "stop", reason: "ignored_notices" } });
	const result = fresh();
	await dispatchAgendaItem(item({ kind: "brief", intervalMinutes: 1440 }), stop.deps, result);
	assert.equal(result.stopped, 1);
	assert.equal(stop.calls.created.length, 0);
	assert.equal(sent.length, 1);
	assert.equal(sent[0]?.conversationId, "conv-1");
	assert.match(sent[0]?.text ?? "", /daily plan/);
	// Vigia ignorado e brief que acabou por outro motivo: sem aviso.
	await dispatchAgendaItem(item({ kind: "watch" }), stop.deps, fresh());
	const other = harness({ ...base, decision: { action: "stop", reason: "max_runs" } });
	await dispatchAgendaItem(item({ kind: "brief", intervalMinutes: 1440 }), other.deps, fresh());
	assert.equal(sent.length, 1);
	// Falha ao entregar não derruba a passada.
	const failing = harness({ language: async () => "pt-BR", deliver: async () => { throw new Error("db fora"); }, decision: { action: "stop", reason: "ignored_notices" } });
	await dispatchAgendaItem(item({ kind: "brief", intervalMinutes: 1440 }), failing.deps, fresh());
	assert.match(failing.calls.logs.join("\n"), /aviso de parada não entregue/);
});
