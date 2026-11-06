/**
 * Agenda do agente (F4) contra Postgres real. Pulado sem ATLAS_TEST_DB_URL (`pnpm --filter @workspace/db test:db`).
 * Cobre o caminho feliz, os freios (ignorados, maxRuns, vigência), o contrato silencioso e o acesso de OUTRO dono (40-seguranca).
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { DEFAULT_PROACTIVE_SETTINGS, planAgendaItem, type AgendaPlan, type ProactiveSettings } from "@workspace/shared";
import {
	beginAgendaRun,
	changeAgendaItem,
	claimDueAgendaItems,
	createAgendaItem,
	decideAgendaWake,
	finalizeAgendaRun,
	findAgendaItemsForEvent,
	getAgendaItem,
	getAgendaItemByRunId,
	isAgendaRunInFlight,
	listAgendaItems,
	recordAgendaResult,
	type AgendaGrant,
} from "./agenda.js";
import { prisma } from "./client.js";
import { claimDueFollowups, createFollowup, listFollowups } from "./proactive.js";
import { createTestUser, dbSkip } from "./testing/test-db.js";

const SETTINGS: ProactiveSettings = { ...DEFAULT_PROACTIVE_SETTINGS, enabled: true, timezone: "America/Sao_Paulo" };
const GRANT: AgendaGrant = { autonomy: "balanced", rules: [] };
// Quarta 2026-11-04 10:00 em São Paulo.
const T0 = new Date("2026-11-04T13:00:00.000Z");
const at = (minutes: number, base = T0) => new Date(base.getTime() + minutes * 60_000);

function plan(request: Parameters<typeof planAgendaItem>[0]["request"], now = T0): AgendaPlan {
	const out = planAgendaItem({ request, now, settings: SETTINGS });
	if (!out.ok) throw new Error(out.error);
	return out.plan;
}

describe("agenda (Postgres real)", { skip: dbSkip }, () => {
	let a: string;
	let b: string;
	let botA: string;
	let botB: string;
	let convA: string;

	before(async () => {
		a = (await createTestUser("agA")).id;
		b = (await createTestUser("agB")).id;
		convA = (await prisma.conversation.create({ data: { userId: a } })).id;
		const convB = (await prisma.conversation.create({ data: { userId: b } })).id;
		botA = (await prisma.bot.create({ data: { ownerId: a, name: "A", isPrimary: true, conversationId: convA }, select: { id: true } })).id;
		botB = (await prisma.bot.create({ data: { ownerId: b, name: "B", isPrimary: true, conversationId: convB }, select: { id: true } })).id;
	});
	after(async () => {
		await prisma.$disconnect();
	});

	const watch = (note: string, over: Partial<Parameters<typeof plan>[0]> = {}) => plan({ kind: "watch", note, everyMinutes: 120, ...over });

	test("cria, lista e devolve o mesmo item no pedido repetido", async () => {
		const created = await createAgendaItem({ userId: a, botId: botA, plan: watch("Preço do notebook X"), grant: GRANT });
		assert.ok(created.ok);
		assert.equal(created.duplicate, false);
		assert.equal(created.item.kind, "watch");
		assert.equal(created.item.intervalMinutes, 120);
		assert.equal(created.item.conversationId, convA);
		assert.deepEqual(created.item.grant, GRANT);
		const again = await createAgendaItem({ userId: a, botId: botA, plan: watch("preço do notebook x"), grant: GRANT });
		assert.ok(again.ok && again.duplicate);
		assert.equal(again.item.id, created.item.id);
		assert.ok((await listAgendaItems(a)).some((i) => i.id === created.item.id));
	});

	test("me lembra às 10h e às 20h: dois itens; o mesmo horário devolve o existente (auditoria F4, C2)", async () => {
		const ten = await createAgendaItem({ userId: a, botId: botA, plan: plan({ kind: "remind", note: "Revisar o contrato", when: "2026-11-10T10:00" }), grant: GRANT });
		const twenty = await createAgendaItem({ userId: a, botId: botA, plan: plan({ kind: "remind", note: "Revisar o contrato", when: "2026-11-10T20:00" }), grant: GRANT });
		assert.ok(ten.ok && twenty.ok);
		assert.equal(ten.duplicate, false);
		assert.equal(twenty.duplicate, false);
		assert.notEqual(ten.item.id, twenty.item.id);
		const same = await createAgendaItem({ userId: a, botId: botA, plan: plan({ kind: "remind", note: "revisar o contrato", when: "2026-11-10T10:30" }), grant: GRANT });
		assert.ok(same.ok && same.duplicate);
		assert.equal(same.item.id, ten.item.id);
	});

	test("outro dono: não cria no bot alheio, não lê, não pausa, não cancela e não grava resultado", async () => {
		const created = await createAgendaItem({ userId: a, botId: botA, plan: watch("Item privado do A"), grant: GRANT });
		assert.ok(created.ok);
		const id = created.item.id;
		const foreign = await createAgendaItem({ userId: b, botId: botA, plan: watch("Invasão"), grant: GRANT });
		assert.deepEqual(foreign, { ok: false, error: "Bot não encontrado" });
		assert.equal(await getAgendaItem(b, id), null);
		assert.ok(!(await listAgendaItems(b)).some((i) => i.id === id));
		for (const action of ["pause", "cancel", "resume"] as const) assert.equal(await changeAgendaItem(b, id, action), null);
		assert.equal((await getAgendaItem(a, id))?.status, "pending");
		// resultado e fechamento de run: o run do item é do A; B não grava nem fecha
		await beginAgendaRun(created.item, "run-priv", T0);
		const rec = await recordAgendaResult({ userId: b, runId: "run-priv", outcome: "update", message: "vazou" });
		assert.equal(rec.ok, false);
		assert.deepEqual(await finalizeAgendaRun({ userId: b, runId: "run-priv", text: "x" }), { agenda: false });
		assert.equal((await getAgendaItem(a, id))?.lastResult, null);
		assert.deepEqual(await findAgendaItemsForEvent(b, { source: "email", from: "x@y.com", subject: "s", hasAttachment: false }, T0, 10), { matched: [], coalesced: [] });
		await changeAgendaItem(a, id, "cancel");
	});

	// Notas sem palavras em comum: o dedupe herdado do v2 trata notas com 80% das palavras iguais como o mesmo pedido.
	const TOPICS = ["notebook", "passagem", "ingresso", "aluguel", "cotacao", "voo", "hotel", "fatura", "pedido", "encomenda", "boleto", "consulta", "exame", "vacina", "revisao", "seguro", "imposto", "matricula", "estoque", "premio"];
	test("limite de itens ativos por dono", async () => {
		const user = (await createTestUser("agL")).id;
		const conv = (await prisma.conversation.create({ data: { userId: user } })).id;
		const bot = (await prisma.bot.create({ data: { ownerId: user, name: "L", isPrimary: true, conversationId: conv }, select: { id: true } })).id;
		for (let i = 0; i < 20; i++) assert.ok((await createAgendaItem({ userId: user, botId: bot, plan: watch(`${TOPICS[i]} acompanhar`), grant: GRANT })).ok);
		const over = await createAgendaItem({ userId: user, botId: bot, plan: watch("um a mais"), grant: GRANT });
		assert.ok(!over.ok && over.error.includes("20 active"));
		const first = (await listAgendaItems(user))[0]!;
		await changeAgendaItem(user, first.id, "cancel");
		assert.ok((await createAgendaItem({ userId: user, botId: bot, plan: watch("agora cabe"), grant: GRANT })).ok);
	});

	test("pausar tira da varredura, retomar zera os contadores; cancelar encerra", async () => {
		const created = await createAgendaItem({ userId: a, botId: botA, plan: watch("Pausável"), grant: GRANT });
		assert.ok(created.ok);
		const id = created.item.id;
		assert.equal((await changeAgendaItem(a, id, "pause"))?.status, "paused");
		assert.equal(await changeAgendaItem(a, id, "pause"), null);
		const due = await claimDueAgendaItems(at(60 * 24 * 3));
		assert.ok(!due.some((i) => i.id === id));
		await prisma.botFollowup.update({ where: { id }, data: { ignoredStreak: 1, noChangeStreak: 4 } });
		const resumed = await changeAgendaItem(a, id, "resume");
		assert.equal(resumed?.status, "pending");
		assert.equal(resumed?.ignoredStreak, 0);
		assert.equal(resumed?.noChangeStreak, 0);
		const cancelled = await changeAgendaItem(a, id, "cancel");
		assert.equal(cancelled?.status, "cancelled");
		assert.equal(cancelled?.endReason, "owner");
		assert.equal(await changeAgendaItem(a, id, "resume"), null);
	});

	test("a varredura do v2 não pega item da agenda e a da agenda não pega lembrete do v2", async () => {
		const agenda = await createAgendaItem({ userId: a, botId: botA, plan: plan({ kind: "remind", note: "Lembrete da agenda", when: "2026-11-05T10:00" }), grant: GRANT });
		assert.ok(agenda.ok);
		const legacy = await createFollowup({ userId: a, botId: botA, note: "Lembrete legado v2", kind: "reminder", dueAt: at(60 * 24), requestedFor: at(60 * 24), source: "chat" });
		const later = at(60 * 24 * 10);
		const v2 = await claimDueFollowups(later, 100);
		assert.ok(v2.some((f) => f.id === legacy.followup.id));
		assert.ok(!v2.some((f) => f.id === agenda.item.id));
		const v4 = await claimDueAgendaItems(later, 100);
		assert.ok(v4.some((i) => i.id === agenda.item.id));
		assert.ok(!v4.some((i) => i.id === legacy.followup.id));
		assert.ok(!(await listFollowups(a, botA)).some((f) => f.id === agenda.item.id));
		await prisma.botFollowup.updateMany({ where: { id: { in: [agenda.item.id, legacy.followup.id] } }, data: { status: "cancelled", claimedUntil: null } });
	});

	test("agenda_result: no_change espaça e não deixa nada para dizer; update zera e guarda a mensagem; done encerra", async () => {
		const created = await createAgendaItem({ userId: a, botId: botA, plan: watch("Ciclo completo"), grant: GRANT });
		assert.ok(created.ok);
		const id = created.item.id;

		await beginAgendaRun(created.item, "run-1", T0);
		const started = await getAgendaItem(a, id);
		assert.equal(started?.runCount, 1);
		assert.equal(started?.runId, "run-1");

		const first = await recordAgendaResult({ userId: a, runId: "run-1", outcome: "no_change", memo: "R$ 4.990", now: T0 });
		assert.ok(first.ok && !first.duplicate);
		assert.equal(first.item.noChangeStreak, 1);
		assert.equal(first.item.lastResult?.memo, "R$ 4.990");
		assert.ok(first.item.dueAt.getTime() > T0.getTime());
		// mesma entrega de novo: não aplica o espaçamento duas vezes
		const dup = await recordAgendaResult({ userId: a, runId: "run-1", outcome: "no_change", now: T0 });
		assert.ok(dup.ok && dup.duplicate);
		assert.equal((await getAgendaItem(a, id))?.noChangeStreak, 1);
		assert.deepEqual(await finalizeAgendaRun({ userId: a, runId: "run-1", text: "texto do modelo que não deve sair", now: T0 }), { agenda: true, itemId: id, text: "", stoppedWithoutResult: false, deliverNote: false, note: "Ciclo completo" });
		assert.equal((await getAgendaItem(a, id))?.lastNoticeAt, null);

		const run2 = (await getAgendaItem(a, id))!;
		await beginAgendaRun(run2, "run-2", at(130));
		const upd = await recordAgendaResult({ userId: a, runId: "run-2", outcome: "update", message: "Caiu para R$ 4.200", now: at(130) });
		assert.ok(upd.ok);
		assert.equal(upd.item.noChangeStreak, 0);
		const fin = await finalizeAgendaRun({ userId: a, runId: "run-2", text: "ignorado", now: at(131) });
		assert.deepEqual(fin, { agenda: true, itemId: id, text: "Caiu para R$ 4.200", stoppedWithoutResult: false, deliverNote: false, note: "Ciclo completo" });
		assert.ok((await getAgendaItem(a, id))?.lastNoticeAt);

		await beginAgendaRun((await getAgendaItem(a, id))!, "run-3", at(300));
		const done = await recordAgendaResult({ userId: a, runId: "run-3", outcome: "done", message: "Chegou no preço, encerrei", now: at(300) });
		assert.ok(done.ok);
		assert.equal(done.item.status, "done");
		assert.equal(done.item.endReason, "done");
		// item encerrado não aceita outro resultado
		await prisma.botFollowup.update({ where: { id }, data: { runId: "run-4" } });
		assert.equal((await recordAgendaResult({ userId: a, runId: "run-4", outcome: "update", message: "x" })).ok, false);
	});

	test("maxRuns encerra o vigia ao atingir o teto", async () => {
		const created = await createAgendaItem({ userId: a, botId: botA, plan: watch("Só duas vezes", { maxRuns: 2 }), grant: GRANT });
		assert.ok(created.ok);
		await beginAgendaRun(created.item, "run-m1", T0);
		const one = await recordAgendaResult({ userId: a, runId: "run-m1", outcome: "no_change", now: T0 });
		assert.ok(one.ok && one.item.status === "pending");
		await beginAgendaRun(one.item, "run-m2", at(150));
		const two = await recordAgendaResult({ userId: a, runId: "run-m2", outcome: "no_change", now: at(150) });
		assert.ok(two.ok);
		assert.equal(two.item.status, "done");
		assert.equal(two.item.endReason, "max_runs");
	});

	test("2 avisos seguidos ignorados encerram; abrir a conversa zera a conta", async () => {
		const created = await createAgendaItem({ userId: a, botId: botA, plan: watch("Vigia que o dono ignora"), grant: GRANT });
		assert.ok(created.ok);
		const id = created.item.id;
		// Como o worker: o item que vai ao run é o que `decideAgendaWake` devolveu (com a contagem de ignorados já atualizada).
		const notice = async (n: number, when: Date, item?: Awaited<ReturnType<typeof getAgendaItem>>) => {
			await beginAgendaRun(item ?? (await getAgendaItem(a, id))!, `run-i${n}`, when);
			await recordAgendaResult({ userId: a, runId: `run-i${n}`, outcome: "update", message: `novidade ${n}`, now: when });
			const fin = await finalizeAgendaRun({ userId: a, runId: `run-i${n}`, text: "", now: when });
			assert.ok(fin.agenda && fin.text === `novidade ${n}`);
		};
		const wake = async (when: Date) => decideAgendaWake((await getAgendaItem(a, id))!, when, SETTINGS);

		await notice(1, T0);
		// o dono não abriu a conversa: o 1º aviso ignorado só conta
		const w1 = await wake(at(240));
		assert.equal(w1.action, "run");
		assert.equal((w1.action === "run" ? w1.item.ignoredStreak : -1), 1);
		await notice(2, at(240), w1.action === "run" ? w1.item : undefined);
		const w2 = await wake(at(480));
		assert.deepEqual(w2, { action: "stop", reason: "ignored_notices" });
		const stopped = await getAgendaItem(a, id);
		assert.equal(stopped?.status, "cancelled");
		assert.equal(stopped?.endReason, "ignored_notices");
		assert.equal(stopped?.ignoredStreak, 2);

		// o dono ABRE a conversa depois do aviso: não conta como ignorado
		const seen = await createAgendaItem({ userId: a, botId: botA, plan: watch("Vigia que o dono lê"), grant: GRANT });
		assert.ok(seen.ok);
		await beginAgendaRun(seen.item, "run-s1", T0);
		await recordAgendaResult({ userId: a, runId: "run-s1", outcome: "update", message: "olha isso", now: T0 });
		await finalizeAgendaRun({ userId: a, runId: "run-s1", text: "", now: T0 });
		await prisma.conversationRead.upsert({ where: { userId_conversationId: { userId: a, conversationId: convA } }, create: { userId: a, conversationId: convA, lastReadAt: at(30) }, update: { lastReadAt: at(30) } });
		const w = await decideAgendaWake((await getAgendaItem(a, seen.item.id))!, at(240), SETTINGS);
		assert.equal(w.action, "run");
		assert.equal(w.action === "run" ? w.item.ignoredStreak : -1, 0);
		await changeAgendaItem(a, seen.item.id, "cancel");
	});

	test("fala do dono na conversa depois do aviso também conta como visto", async () => {
		const created = await createAgendaItem({ userId: a, botId: botA, plan: watch("Vigia respondido"), grant: GRANT });
		assert.ok(created.ok);
		const when = new Date("2026-11-04T20:00:00.000Z");
		await beginAgendaRun(created.item, "run-r1", when);
		await recordAgendaResult({ userId: a, runId: "run-r1", outcome: "update", message: "aviso", now: when });
		await finalizeAgendaRun({ userId: a, runId: "run-r1", text: "", now: when });
		// sem leitura registrada depois do aviso, mas o dono escreveu
		await prisma.conversationRead.deleteMany({ where: { userId: a, conversationId: convA } });
		await prisma.conversationMessage.create({ data: { conversationId: convA, role: "user", content: "valeu, vi", createdAt: new Date(when.getTime() + 60_000) } });
		const wake = await decideAgendaWake((await getAgendaItem(a, created.item.id))!, new Date("2026-11-05T12:00:00.000Z"), SETTINGS);
		assert.equal(wake.action, "run");
		assert.equal(wake.action === "run" ? wake.item.ignoredStreak : -1, 0);
		await changeAgendaItem(a, created.item.id, "cancel");
	});

	test("vigência vencida e silêncio: expira sem gastar run; no silêncio adia para a manhã", async () => {
		const created = await createAgendaItem({ userId: a, botId: botA, plan: watch("Com prazo", { until: "2026-11-06T10:00" }), grant: GRANT });
		assert.ok(created.ok);
		const night = new Date("2026-11-05T03:00:00.000Z"); // 00:00 em SP
		const deferred = await decideAgendaWake(created.item, night, SETTINGS);
		assert.equal(deferred.action, "defer");
		assert.equal(deferred.action === "defer" ? deferred.dueAt.toISOString() : "", "2026-11-05T11:00:00.000Z");
		assert.equal((await getAgendaItem(a, created.item.id))?.dueAt.toISOString(), "2026-11-05T11:00:00.000Z");
		const expired = await decideAgendaWake((await getAgendaItem(a, created.item.id))!, new Date("2026-11-07T15:00:00.000Z"), SETTINGS);
		assert.deepEqual(expired, { action: "stop", reason: "expired" });
		assert.equal((await getAgendaItem(a, created.item.id))?.status, "done");
	});

	test("run sem agenda_result: vigia não fala, conta a falha e na 3ª encerra avisando; lembrete entrega o texto", async () => {
		const created = await createAgendaItem({ userId: a, botId: botA, plan: watch("Run que esquece o resultado"), grant: GRANT });
		assert.ok(created.ok);
		let item = created.item;
		let fin;
		for (let n = 1; n <= 3; n++) {
			await beginAgendaRun(item, `run-x${n}`, at(n * 200));
			fin = await finalizeAgendaRun({ userId: a, runId: `run-x${n}`, text: "achei algo talvez", now: at(n * 200) });
			assert.ok(fin.agenda);
			if (n < 3) {
				assert.equal(fin.text, "");
				assert.equal(fin.stoppedWithoutResult, false);
				item = (await getAgendaItem(a, item.id))!;
				assert.equal(item.missingResults, n);
				assert.equal(item.status, "pending");
			}
		}
		assert.ok(fin?.agenda && fin.stoppedWithoutResult);
		const ended = await getAgendaItem(a, created.item.id);
		assert.equal(ended?.status, "done");
		assert.equal(ended?.endReason, "no_result");
		// reentrega do mesmo run: não conta de novo
		const again = await finalizeAgendaRun({ userId: a, runId: "run-x3", text: "x", now: at(700) });
		assert.ok(again.agenda && again.stoppedWithoutResult);

		const remind = await createAgendaItem({ userId: a, botId: botA, plan: plan({ kind: "remind", note: "Ligar para a Ana", when: "2026-11-05T10:00" }), grant: GRANT });
		assert.ok(remind.ok);
		await beginAgendaRun(remind.item, "run-rem", at(60 * 24));
		const sent = await finalizeAgendaRun({ userId: a, runId: "run-rem", text: "Hora de ligar para a Ana.", now: at(60 * 24) });
		assert.ok(sent.agenda && sent.text === "Hora de ligar para a Ana.");
		assert.equal((await getAgendaItem(a, remind.item.id))?.status, "done");
	});

	test("lembrete que acorda sem resultado nem texto não some: reagenda e, na terceira, entrega a própria nota (auditoria F4, C1/B2)", async () => {
		const created = await createAgendaItem({ userId: a, botId: botA, plan: plan({ kind: "remind", note: "Pagar o condomínio", when: "2026-11-20T09:00" }), grant: GRANT });
		assert.ok(created.ok);
		const id = created.item.id;
		let now = at(60 * 24 * 16);
		for (const n of [1, 2]) {
			const woke = await decideAgendaWake((await getAgendaItem(a, id))!, now, SETTINGS);
			assert.equal(woke.action, "run", `acordar ${n}`);
			await beginAgendaRun((await getAgendaItem(a, id))!, `run-sn${n}`, now);
			const fin = await finalizeAgendaRun({ userId: a, runId: `run-sn${n}`, text: "", now });
			assert.ok(fin.agenda && !fin.deliverNote && fin.text === "");
			const item = (await getAgendaItem(a, id))!;
			assert.equal(item.status, "pending", `reagendado na tentativa ${n}`);
			assert.equal(item.missingResults, n);
			now = new Date(item.dueAt.getTime() + 60_000);
		}
		assert.equal((await decideAgendaWake((await getAgendaItem(a, id))!, now, SETTINGS)).action, "run");
		await beginAgendaRun((await getAgendaItem(a, id))!, "run-sn3", now);
		const last = await finalizeAgendaRun({ userId: a, runId: "run-sn3", text: "", now });
		assert.ok(last.agenda && last.deliverNote && !last.stoppedWithoutResult);
		assert.equal(last.note, "Pagar o condomínio");
		const done = (await getAgendaItem(a, id))!;
		assert.equal(done.status, "done");
		assert.equal(done.endReason, "reminder_note");
		// reentrega do mesmo run: continua apontando a nota (idempotente)
		const again = await finalizeAgendaRun({ userId: a, runId: "run-sn3", text: "", now });
		assert.ok(again.agenda && again.deliverNote);
	});

	test("intenção por evento: casa pelo filtro, junta eventos muito próximos e segue valendo depois de acordar", async () => {
		const created = await createAgendaItem({
			userId: a,
			botId: botA,
			plan: plan({ kind: "intent", note: "Resumir a fatura do banco", eventFilter: { source: "email", from: "banco.com", subjectContains: "fatura" } }),
			grant: GRANT,
		});
		assert.ok(created.ok);
		const event = { source: "email" as const, from: "Banco <fatura@banco.com>", subject: "Sua fatura chegou", hasAttachment: true };
		const hit = await findAgendaItemsForEvent(a, event, T0, 10);
		assert.deepEqual(hit.matched.map((i) => i.id), [created.item.id]);
		assert.deepEqual((await findAgendaItemsForEvent(a, { ...event, subject: "Promoção" }, T0, 10)).matched, []);
		assert.deepEqual((await findAgendaItemsForEvent(a, { ...event, from: "x@outro.com" }, T0, 10)).matched, []);

		await beginAgendaRun(created.item, "run-int1", T0);
		// run em andamento: o próximo evento é juntado
		const during = await findAgendaItemsForEvent(a, event, at(2), 10);
		assert.deepEqual(during.coalesced.map((i) => i.id), [created.item.id]);
		const res = await recordAgendaResult({ userId: a, runId: "run-int1", outcome: "update", message: "Fatura: R$ 1.200", now: at(3) });
		assert.ok(res.ok);
		assert.equal(res.item.status, "pending");
		assert.equal(res.item.dueAt.toISOString(), created.item.untilAt?.toISOString());
		assert.equal((await findAgendaItemsForEvent(a, event, at(5), 10)).coalesced.length, 1);
		assert.equal((await findAgendaItemsForEvent(a, event, at(20), 10)).matched.length, 1);
		await changeAgendaItem(a, created.item.id, "cancel");
	});

	test("liga o run ao item (só do dono) e sabe se o run anterior ainda está vivo", async () => {
		const created = await createAgendaItem({ userId: a, botId: botA, plan: watch("Run vivo"), grant: GRANT });
		assert.ok(created.ok);
		const run = await prisma.agentRun.create({ data: { userId: a, conversationId: convA, objective: "o", model: "m", status: "running", origin: "proactive" } });
		await beginAgendaRun(created.item, run.id, T0);
		assert.equal((await getAgendaItemByRunId(a, run.id))?.id, created.item.id);
		assert.equal(await getAgendaItemByRunId(b, run.id), null);
		assert.equal(await getAgendaItemByRunId(a, "run-que-nao-existe"), null);
		assert.equal(await isAgendaRunInFlight(a, run.id, T0), true);
		assert.equal(await isAgendaRunInFlight(b, run.id, T0), false);
		assert.equal(await isAgendaRunInFlight(a, null, T0), false);
		await prisma.agentRun.update({ where: { id: run.id }, data: { status: "paused" } });
		assert.equal(await isAgendaRunInFlight(a, run.id, new Date()), true);
		// parado há mais de 25h (cartão expirado): já não segura o item
		assert.equal(await isAgendaRunInFlight(a, run.id, new Date(Date.now() + 26 * 3600_000)), false);
		await prisma.agentRun.update({ where: { id: run.id }, data: { status: "completed" } });
		assert.equal(await isAgendaRunInFlight(a, run.id, new Date()), false);
		await changeAgendaItem(a, created.item.id, "cancel");
	});

	test("item de outro dono nunca casa evento do dono B", async () => {
		const mine = await createAgendaItem({ userId: a, botId: botA, plan: plan({ kind: "intent", note: "Só do A", eventFilter: { source: "email", from: "loja.com" } }), grant: GRANT });
		assert.ok(mine.ok);
		const hitB = await findAgendaItemsForEvent(b, { source: "email", from: "x@loja.com", subject: "s", hasAttachment: false }, T0, 10);
		assert.equal(hitB.matched.length + hitB.coalesced.length, 0);
		assert.equal((await findAgendaItemsForEvent(a, { source: "email", from: "x@loja.com", subject: "s", hasAttachment: false }, T0, 10)).matched.length, 1);
		await changeAgendaItem(a, mine.item.id, "cancel");
		void botB;
	});
});
