/**
 * Agenda do worker contra Postgres real (auditoria F4: T2 concorrência, T3 run que morreu, B1/B5 ponta a ponta no banco).
 * Pulado sem `ATLAS_TEST_DB_URL` (banco com `test` no nome) e `DATABASE_URL` igual a ele.
 * Runner: `ATLAS_TEST_DB_URL=postgresql://.../atlas_test DATABASE_URL=$ATLAS_TEST_DB_URL NODE_ENV=test ATLAS_HOOK_PEPPER=test-pepper pnpm exec tsx --test src/agenda-wake.db.test.ts`.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";
import {
	AGENDA_RUN_RETRY_MS,
	beginAgendaRun,
	claimDueAgendaItems,
	createAgendaItem,
	finalizeAgendaRun,
	getAgendaItem,
	prisma,
	recordAgendaResult,
	reserveAgendaItem,
	type AgendaGrant,
	type AgendaItemRecord,
} from "@workspace/db";
import { AGENDA_EVENT_MIN_GAP_MINUTES, DEFAULT_PROACTIVE_SETTINGS, planAgendaItem, readEngineV4Gate, type AgendaEvent, type AgendaPlan } from "@workspace/shared";
import { claimPendingEventItems, clearPendingEvent, markPendingEvent } from "./agenda-pending-event.js";
import { realAgendaRunDb, settleAbortedAgendaRun } from "./agenda-run.js";
import { dispatchAgendaItem, processAgenda, wakeAgendaForEvent, type AgendaWakeDeps } from "./agenda-wake.js";

const url = process.env.ATLAS_TEST_DB_URL?.trim() ?? "";
const dbSkip: string | false = !url ? "banco de teste ausente (ATLAS_TEST_DB_URL)" : !/test/i.test(new URL(url).pathname) ? "recusado: o banco deve ter 'test' no nome" : process.env.DATABASE_URL !== url ? "DATABASE_URL difere de ATLAS_TEST_DB_URL" : false;

const GRANT: AgendaGrant = { autonomy: "balanced", rules: [] };
// Quarta 2026-11-04 10:00 em São Paulo.
const T0 = new Date("2026-11-04T13:00:00.000Z");
const at = (minutes: number, base = T0) => new Date(base.getTime() + minutes * 60_000);
const SETTINGS = { ...DEFAULT_PROACTIVE_SETTINGS, enabled: true, timezone: "America/Sao_Paulo" };
const EVENT: AgendaEvent = { source: "email", from: "fatura@banco.com", subject: "Sua fatura", hasAttachment: true };

function plan(request: Parameters<typeof planAgendaItem>[0]["request"]): AgendaPlan {
	const out = planAgendaItem({ request, now: T0, settings: SETTINGS });
	if (!out.ok) throw new Error(out.error);
	return out.plan;
}

describe("agenda do worker (Postgres real)", { skip: dbSkip }, () => {
	let userId: string;
	let otherId: string;
	let botId: string;
	let convId: string;

	before(async () => {
		userId = `wk-${randomUUID()}`;
		otherId = `wk-${randomUUID()}`;
		for (const id of [userId, otherId]) await prisma.user.create({ data: { id, name: id, email: `${id}@test.local` } });
		convId = (await prisma.conversation.create({ data: { userId } })).id;
		botId = (await prisma.bot.create({ data: { ownerId: userId, name: "A", isPrimary: true, conversationId: convId }, select: { id: true } })).id;
	});
	after(async () => {
		await prisma.$disconnect();
	});

	/** Um "worker": db real, só a criação do run e a fila são falsas (contam por dono do teste). */
	function worker(now: Date, sink: { created: string[]; delivered: string[] }, over: Partial<AgendaWakeDeps> = {}): AgendaWakeDeps {
		return {
			v4Gate: readEngineV4Gate("true", `${userId},${otherId}`),
			enqueueRun: async () => true,
			envDefaultModel: "test/model",
			now: () => now,
			log: () => undefined,
			resolveModel: async () => "test/model",
			activeRuns: async () => [],
			createRun: (async (input: { userId: string; request: { objective?: string; origin?: string } }) => {
				const id = `run-${randomUUID()}`;
				if (input.userId === userId) sink.created.push(id);
				return { id, origin: input.request.origin, objective: input.request.objective };
			}) as unknown as AgendaWakeDeps["createRun"],
			settleDead: (input) => settleAbortedAgendaRun({ ...input, db: { ...realAgendaRunDb, deliver: async (_c, text) => void sink.delivered.push(text) } }),
			...over,
		};
	}
	const sink = () => ({ created: [] as string[], delivered: [] as string[] });

	async function newItem(request: Parameters<typeof plan>[0]): Promise<AgendaItemRecord> {
		const created = await createAgendaItem({ userId, botId, plan: plan(request), grant: GRANT });
		assert.ok(created.ok, created.ok ? "" : created.error);
		return created.item;
	}

	test("T2: duas varreduras ao mesmo tempo sobre o mesmo item vencido criam UM run só (FOR UPDATE SKIP LOCKED)", async () => {
		const item = await newItem({ kind: "watch", note: `Varredura concorrente ${randomUUID()}`, everyMinutes: 120, when: "2026-11-04T10:00" });
		const now = at(180);
		const s = sink();
		await Promise.all([processAgenda(worker(now, s)), processAgenda(worker(now, s))]);
		// só este item é do dono do teste e está vencido
		assert.equal(s.created.length, 1);
		const after = await getAgendaItem(userId, item.id);
		assert.equal(after?.runCount, 1);
		assert.equal(after?.runId, s.created[0]);
	});

	test("T2: o mesmo evento em dois workers acorda o item de intenção uma vez só (reserva compare-and-set)", async () => {
		const item = await newItem({ kind: "intent", note: `Fatura ${randomUUID()}`, eventFilter: { source: "email", from: "banco.com" } });
		const now = at(60);
		const s = sink();
		const [a, b] = await Promise.all([wakeAgendaForEvent({ userId, event: EVENT }, worker(now, s)), wakeAgendaForEvent({ userId, event: EVENT }, worker(now, s))]);
		assert.equal(a.run + b.run, 1);
		assert.equal(s.created.length, 1);
		assert.equal((await getAgendaItem(userId, item.id))?.runCount, 1);
		// reservar de novo (outro worker, mesmo instante) não passa
		assert.equal(await reserveAgendaItem(userId, item.id, now), false);
		// outro dono não reserva
		assert.equal(await reserveAgendaItem(otherId, item.id, at(500)), false);
	});

	test("T2: reentrega do fechamento (finalizeAgendaRun duas vezes, em série e em paralelo) não aplica o efeito duas vezes", async () => {
		const item = await newItem({ kind: "watch", note: `Reentrega ${randomUUID()}`, everyMinutes: 120, when: "2026-11-04T10:00" });
		await beginAgendaRun(item, "run-reent-1", at(180));
		const once = await finalizeAgendaRun({ userId, runId: "run-reent-1", text: "", now: at(185) });
		assert.ok(once.agenda);
		const afterOnce = await getAgendaItem(userId, item.id);
		await Promise.all([finalizeAgendaRun({ userId, runId: "run-reent-1", text: "", now: at(186) }), finalizeAgendaRun({ userId, runId: "run-reent-1", text: "", now: at(186) })]);
		const afterMany = await getAgendaItem(userId, item.id);
		assert.equal(afterMany?.missingResults, afterOnce?.missingResults);
		assert.equal(afterMany?.noChangeStreak, afterOnce?.noChangeStreak);
		assert.equal(afterMany?.dueAt.getTime(), afterOnce?.dueAt.getTime());

		// com resultado declarado: a reentrega também não soma o espaçamento
		const watch = await newItem({ kind: "watch", note: `Reentrega com resultado ${randomUUID()}`, everyMinutes: 120, when: "2026-11-04T10:00" });
		await beginAgendaRun(watch, "run-reent-2", at(180));
		assert.ok((await recordAgendaResult({ userId, runId: "run-reent-2", outcome: "no_change", now: at(185) })).ok);
		const first = await getAgendaItem(userId, watch.id);
		const dup = await recordAgendaResult({ userId, runId: "run-reent-2", outcome: "no_change", now: at(190) });
		assert.ok(dup.ok && dup.duplicate);
		await finalizeAgendaRun({ userId, runId: "run-reent-2", text: "", now: at(191) });
		const last = await getAgendaItem(userId, watch.id);
		assert.equal(last?.noChangeStreak, first?.noChangeStreak);
		assert.equal(last?.dueAt.getTime(), first?.dueAt.getTime());
	});

	test("T3 + B1: o run morreu sem resultado, volta na fila em 30 min e o wake o fecha ANTES do maxRuns: lembrete único não some em silêncio", async () => {
		const item = await newItem({ kind: "remind", note: `Ligar para a Ana ${randomUUID()}`, when: "2026-11-04T10:00" });
		const startedAt = at(180);
		await beginAgendaRun(item, "run-morto-1", startedAt);
		// antes de AGENDA_RUN_RETRY_MS a varredura não pega o item
		assert.equal((await claimDueAgendaItems(at(180 + 29))).some((i) => i.id === item.id), false);
		const claimed = (await claimDueAgendaItems(new Date(startedAt.getTime() + AGENDA_RUN_RETRY_MS))).find((i) => i.id === item.id);
		assert.ok(claimed, "volta à fila no prazo");
		assert.equal(claimed.runCount, 1);
		// lembrete único nasce com teto de 1 execução: é exatamente o que o `max_runs` do wake consumiria
		assert.equal(claimed.maxRuns, 1, "lembrete de uma vez só");
		const s = sink();
		const result = { run: 0, deferred: 0, stopped: 0, coalesced: 0 };
		await dispatchAgendaItem(claimed, worker(new Date(startedAt.getTime() + AGENDA_RUN_RETRY_MS), s), result);
		assert.equal(s.created.length, 0, "não cria outro run");
		assert.equal(result.stopped, 0, "o maxRuns não consome o item antes do fechamento");
		assert.equal(result.deferred, 1);
		const after = await getAgendaItem(userId, item.id);
		assert.equal(after?.lastResult?.runId, "run-morto-1");
		assert.equal(after?.lastResult?.outcome, "missing");
		// nunca em silêncio: ou continua na fila, ou o texto do lembrete foi entregue
		assert.ok(after?.status === "pending" || s.delivered.some((text) => text.includes("Ligar para a Ana")), `status=${after?.status} entregue=${JSON.stringify(s.delivered)}`);
	});

	test("B1: falha, cancelamento ou queda fecham o item pelo mesmo caminho (idempotente)", async () => {
		const item = await newItem({ kind: "remind", note: `Reunião ${randomUUID()}`, when: "2026-11-04T10:00" });
		await beginAgendaRun(item, "run-falhou-1", at(180));
		const s = sink();
		const deps = { userId, runId: "run-falhou-1", language: "pt-BR", db: { ...realAgendaRunDb, deliver: async (_c: string, text: string) => void s.delivered.push(text) } };
		assert.equal((await settleAbortedAgendaRun({ ...deps, now: at(181) })).closed, true);
		const first = await getAgendaItem(userId, item.id);
		assert.equal(first?.lastResult?.outcome, "missing");
		// reentrega do mesmo fechamento: não duplica o aviso
		const delivered = s.delivered.length;
		await settleAbortedAgendaRun({ ...deps, now: at(182) });
		assert.equal(s.delivered.length, delivered);
		assert.ok(first?.status === "pending" || delivered >= 1);
		// item de outro dono: o fechamento não encontra
		assert.deepEqual(await settleAbortedAgendaRun({ userId: otherId, runId: "run-falhou-1", db: { ...realAgendaRunDb, deliver: async () => undefined } }), { closed: false, delivered: false });
	});

	test("B5: evento pendente só é acordado depois do espaçamento mínimo, uma vez, e só pelo dono", async () => {
		const item = await newItem({ kind: "intent", note: `Pendente ${randomUUID()}`, eventFilter: { source: "email", from: "pendente.com" } });
		assert.equal(await markPendingEvent(otherId, item.id), false);
		assert.equal(await markPendingEvent(userId, item.id), true);
		const base = at(600);
		// recém acordou (lastResult agora): espera o espaçamento
		await beginAgendaRun(item, "run-pend-1", base);
		await recordAgendaResult({ userId, runId: "run-pend-1", outcome: "no_change", now: base });
		await markPendingEvent(userId, item.id);
		assert.equal((await claimPendingEventItems(at(5, base), 10)).some((i) => i.id === item.id), false);
		const claimed = await Promise.all([claimPendingEventItems(at(11, base), 10), claimPendingEventItems(at(11, base), 10)]);
		assert.equal(claimed.flat().filter((i) => i.id === item.id).length, 1, "dois workers: uma reserva só");
		await clearPendingEvent(userId, item.id);
		assert.equal((await getAgendaItem(userId, item.id))?.endReason, null);
		assert.equal((await claimPendingEventItems(at(60, base), 10)).some((i) => i.id === item.id), false);
	});

	test("N1: evento pendente respeita o teto de 8 acordares por 24h: contínuo = no máximo 8 runs por janela, sem perder o evento (reauditoria F4)", async () => {
		const item = await newItem({ kind: "intent", note: `Teto ${randomUUID()}`, eventFilter: { source: "email", from: "teto.com" } });
		const base = at(2000);
		let runs = 0;
		// varredura a cada 31 min durante 24h menos 1 min, com o item sempre marcado como pendente
		for (let n = 0; n * 31 < 24 * 60 - 1; n++) {
			const now = at(n * 31, base);
			await markPendingEvent(userId, item.id);
			const claimed = (await claimPendingEventItems(now, AGENDA_EVENT_MIN_GAP_MINUTES)).filter((i) => i.id === item.id);
			if (claimed.length === 0) continue;
			runs += 1;
			await beginAgendaRun(claimed[0]!, `run-teto-${n}`, now);
			await recordAgendaResult({ userId, runId: `run-teto-${n}`, outcome: "no_change", now });
		}
		assert.equal(runs, 8, "no máximo 8 runs na janela");
		assert.equal((await getAgendaItem(userId, item.id))?.endReason, "event_pending", "o evento continua esperando");
		// a janela virou: o pendente acorda de novo
		await markPendingEvent(userId, item.id);
		assert.equal((await claimPendingEventItems(at(24 * 60 + 40, base), AGENDA_EVENT_MIN_GAP_MINUTES)).some((i) => i.id === item.id), true);
	});

	test("B5: evento que chegou com a intenção ocupada roda quando o run termina (ponta a ponta)", async () => {
		const item = await newItem({ kind: "intent", note: `Ocupada ${randomUUID()}`, eventFilter: { source: "email", from: "banco.com" } });
		const t = at(700);
		const s1 = sink();
		await wakeAgendaForEvent({ userId, event: EVENT }, worker(t, s1));
		assert.equal(s1.created.length, 1);
		const runId = s1.created[0]!;
		// segundo e-mail com o run em andamento: juntado, mas marcado
		const s2 = sink();
		const during = await wakeAgendaForEvent({ userId, event: EVENT }, worker(at(2, t), s2));
		assert.equal(during.run, 0);
		assert.equal(s2.created.length, 0);
		assert.equal((await getAgendaItem(userId, item.id))?.endReason, "event_pending");
		// o run termina; passado o espaçamento a varredura acorda o item de novo, sem esperar o fim da vigência
		assert.ok((await recordAgendaResult({ userId, runId, outcome: "no_change", now: at(3, t) })).ok);
		const s3 = sink();
		// (o resultado foi gravado em t+3; o espaçamento mínimo entre acordares é o do shared, 30 min desde a auditoria F4, B4)
		const sweep = await processAgenda(worker(at(3 + AGENDA_EVENT_MIN_GAP_MINUTES + 1, t), s3, { inFlight: async () => false }));
		assert.ok(sweep.run >= 1);
		// (o banco de teste tem itens de outros testes vencidos: confere pelo item)
		const woken = await getAgendaItem(userId, item.id);
		assert.equal(woken?.runCount, 2);
		assert.ok(woken?.runId && s3.created.includes(woken.runId));
		assert.equal(woken?.endReason, null);
	});
});
