/**
 * Sono do bot contra Postgres real (F5.3): reserva do slot, relatórios, propostas e a leitura do dia, tudo por dono.
 * Pulado sem ATLAS_TEST_DB_URL. Runner: `pnpm --filter @workspace/db test:db`.
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { prisma } from "./client.js";
import { addMemoryEntry } from "./memory-entries.js";
import { listSleepChanges } from "./notes.js";
import { SLEEP_STALE_MS, claimSleepSlot, dismissSleepProposal, finishSleepReport, getPreviousSleepEnd, getSleepReport, listBotsForSleep, listMemoryForDoctor, listSleepReports, loadSleepDay, sumSleepCostUsd } from "./sleep-reports.js";
import { createTestBot, createTestUser, dbSkip } from "./testing/test-db.js";

describe("sono (Postgres real)", { skip: dbSkip }, () => {
	let userA: string;
	let userB: string;
	let botA: string;
	let convA: string;
	let groupConv: string;

	before(async () => {
		userA = (await createTestUser("sleep-a")).id;
		userB = (await createTestUser("sleep-b")).id;
		botA = (await createTestBot(userA, { name: "A" })).id;
		convA = (await prisma.conversation.create({ data: { userId: userA } })).id;
		groupConv = (await prisma.conversation.create({ data: { userId: userA } })).id;
		await prisma.bot.update({ where: { id: botA }, data: { conversationId: convA } });
	});
	after(async () => {
		await prisma.$disconnect();
	});

	const now = new Date("2026-11-05T02:30:00Z");

	test("a reserva do slot é única por bot, tipo e dia; o abandonado é reassumido", async () => {
		const first = await claimSleepSlot({ userId: userA, botId: botA, kind: "daily", slot: "2026-11-04", now });
		assert.ok(first);
		assert.equal(await claimSleepSlot({ userId: userA, botId: botA, kind: "daily", slot: "2026-11-04", now: new Date(now.getTime() + 1000) }), null);
		assert.ok(await claimSleepSlot({ userId: userA, botId: botA, kind: "doctor", slot: "2026-11-04", now }));
		assert.ok(await claimSleepSlot({ userId: userA, botId: botA, kind: "daily", slot: "2026-11-05", now }));
		const later = new Date(now.getTime() + SLEEP_STALE_MS + 1000);
		const reclaimed = await claimSleepSlot({ userId: userA, botId: botA, kind: "daily", slot: "2026-11-04", now: later });
		assert.equal(reclaimed?.id, first.id);
		await finishSleepReport({ userId: userA, id: first.id, status: "done" });
		assert.equal(await claimSleepSlot({ userId: userA, botId: botA, kind: "daily", slot: "2026-11-04", now: new Date(later.getTime() + SLEEP_STALE_MS * 2) }), null);
	});

	test("o fim da janela do último sono concluído é o começo do próximo", async () => {
		const bot = (await createTestBot(userA, { name: "janela" })).id;
		assert.equal(await getPreviousSleepEnd(userA, bot), null);
		const day1 = await claimSleepSlot({ userId: userA, botId: bot, kind: "daily", slot: "2026-11-01", now });
		await finishSleepReport({ userId: userA, id: day1!.id, status: "done", windowEnd: new Date("2026-11-02T02:30:00Z") });
		const day2 = await claimSleepSlot({ userId: userA, botId: bot, kind: "daily", slot: "2026-11-02", now });
		await finishSleepReport({ userId: userA, id: day2!.id, status: "failed", detail: "sem chave", windowEnd: new Date("2026-11-03T02:30:00Z") });
		// Falha não avança a janela: o dia que falhou entra na próxima leitura.
		assert.equal((await getPreviousSleepEnd(userA, bot))?.toISOString(), "2026-11-02T02:30:00.000Z");
		// Dia quieto (skipped) avança.
		const day3 = await claimSleepSlot({ userId: userA, botId: bot, kind: "daily", slot: "2026-11-03", now });
		await finishSleepReport({ userId: userA, id: day3!.id, status: "skipped", detail: "sem fala do dono na janela", windowEnd: new Date("2026-11-04T02:30:00Z") });
		assert.equal((await getPreviousSleepEnd(userA, bot))?.toISOString(), "2026-11-04T02:30:00.000Z");
		assert.deepEqual((await listSleepReports({ userId: userA, botId: bot })).reports.map((r) => r.status).sort(), ["done", "failed"], "dia quieto (skipped) não aparece na lista");
		assert.equal(await getPreviousSleepEnd(userB, bot), null);
	});

	test("relatórios e propostas: só o dono lista, lê e dispensa", async () => {
		const bot = (await createTestBot(userA, { name: "relatorio" })).id;
		const claim = await claimSleepSlot({ userId: userA, botId: bot, kind: "daily", slot: "2026-11-10", now });
		const proposals = [{ id: "skill:x", kind: "skill" as const, status: "open" as const, name: "N", description: "D", instructions: "I" }];
		await finishSleepReport({ userId: userA, id: claim!.id, status: "done", summary: "Guardei 2 coisas.", proposals, stats: { facts: 2, notes: 0 } });
		const listed = await listSleepReports({ userId: userA, botId: bot });
		assert.deepEqual(listed.reports.map((r) => [r.id, r.status, r.summary, r.stats.facts, r.proposals.length]), [[claim!.id, "done", "Guardei 2 coisas.", 2, 1]]);
		assert.deepEqual((await listSleepReports({ userId: userB })).reports.filter((r) => r.botId === bot), []);
		assert.equal(await getSleepReport(userB, claim!.id), null);
		assert.equal(await dismissSleepProposal({ userId: userB, reportId: claim!.id, proposalId: "skill:x" }), null);
		assert.equal((await getSleepReport(userA, claim!.id))?.proposals[0]?.status, "open");
		assert.equal(await dismissSleepProposal({ userId: userA, reportId: claim!.id, proposalId: "nao-existe" }), null);
		const dismissed = await dismissSleepProposal({ userId: userA, reportId: claim!.id, proposalId: "skill:x" });
		assert.equal(dismissed?.proposals[0]?.status, "dismissed");
	});

	test("dois dispensar ao mesmo tempo não perdem nenhum (auditoria F5, B3)", async () => {
		const bot = (await createTestBot(userA, { name: "dispensa" })).id;
		const claim = await claimSleepSlot({ userId: userA, botId: bot, kind: "doctor", slot: "2026-11-15", now });
		const ids = Array.from({ length: 6 }, (_, i) => `doctor:2026-11-15:${i}`);
		const finding = { type: "stale" as const, subject: "memory" as const, ids: ["m"], reason: "r" };
		await finishSleepReport({ userId: userA, id: claim!.id, status: "done", proposals: ids.map((id) => ({ id, kind: "doctor" as const, status: "open" as const, finding })) });
		await Promise.all(ids.map((proposalId) => dismissSleepProposal({ userId: userA, reportId: claim!.id, proposalId })));
		const report = await getSleepReport(userA, claim!.id);
		assert.deepEqual(report?.proposals.map((p) => p.status), ids.map(() => "dismissed"));
	});

	test("a leitura do dia traz só a conversa direta do bot, na janela, e os runs v4 de chat", async () => {
		const at = (iso: string) => new Date(iso);
		await prisma.conversationMessage.createMany({
			data: [
				{ conversationId: convA, role: "user", content: "antes da janela", createdAt: at("2026-11-01T12:00:00Z") },
				{ conversationId: convA, role: "user", content: "moro em Curitiba", createdAt: at("2026-11-04T12:00:00Z") },
				{ conversationId: convA, role: "assistant", content: "anotado", createdAt: at("2026-11-04T12:01:00Z") },
				{ conversationId: convA, role: "user", content: "resumo de e-mail", origin: "email", createdAt: at("2026-11-04T13:00:00Z") },
				{ conversationId: groupConv, role: "user", content: "segredo do grupo", createdAt: at("2026-11-04T12:00:00Z") },
			],
		});
		const run = await prisma.agentRun.create({ data: { userId: userA, botId: botA, conversationId: convA, origin: "chat", objective: "faz X", status: "completed", model: "m", createdAt: at("2026-11-04T12:00:00Z"), stopReason: "loop_repeat" } });
		await prisma.agentJournalEntry.create({ data: { runId: run.id, userId: userA, step: 1, idempotencyKey: "k1", toolName: "web_search", argsHash: "h", state: "succeeded" } });
		await prisma.agentRun.create({ data: { userId: userA, botId: botA, conversationId: convA, origin: "chat", objective: "sem v4", status: "completed", model: "m", createdAt: at("2026-11-04T12:00:00Z") } });
		await prisma.note.create({ data: { userId: userA, botId: botA, title: "n", body: "b" } });

		const day = await loadSleepDay({ userId: userA, botId: botA, from: at("2026-11-04T02:30:00Z"), to: at("2026-11-05T02:30:00Z") });
		assert.ok(day);
		assert.deepEqual(day.messages.map((m) => [m.content, m.origin]), [["moro em Curitiba", null], ["anotado", null], ["resumo de e-mail", "email"]]);
		assert.deepEqual(day.runs.map((r) => [r.objective, r.stopReason, r.journal.length]), [["faz X", "loop_repeat", 1]]);
		assert.ok(day.notes.some((n) => n.title === "n"));
		// O outro dono não lê o dia do bot do A, nem passando o id certo.
		assert.equal(await loadSleepDay({ userId: userB, botId: botA, from: at("2026-11-01T00:00:00Z"), to: at("2026-11-09T00:00:00Z") }), null);
	});

	test("custo do sono: soma os relatórios do dono (feitos, quietos e falhos), por bot e por período; nunca os de outro dono (auditoria F5, C1)", async () => {
		const bot = (await createTestBot(userA, { name: "custo" })).id;
		const other = (await createTestBot(userB, { name: "custo-b" })).id;
		const at = (iso: string) => new Date(iso);
		for (const [slot, status, cost, day] of [["2026-10-01", "done", 0.01, "2026-10-02T02:30:00Z"], ["2026-10-02", "failed", 0.005, "2026-10-03T02:30:00Z"], ["2026-10-03", "skipped", 0, "2026-10-04T02:30:00Z"]] as const) {
			const claim = await claimSleepSlot({ userId: userA, botId: bot, kind: "daily", slot, now: at(day) });
			await finishSleepReport({ userId: userA, id: claim!.id, status, stats: { costUsd: cost }, now: at(day) });
		}
		const foreign = await claimSleepSlot({ userId: userB, botId: other, kind: "daily", slot: "2026-10-01", now: at("2026-10-02T02:30:00Z") });
		await finishSleepReport({ userId: userB, id: foreign!.id, status: "done", stats: { costUsd: 9 }, now: at("2026-10-02T02:30:00Z") });
		assert.equal(await sumSleepCostUsd({ userId: userA, botId: bot, since: at("2026-10-01T00:00:00Z") }), 0.015);
		assert.equal(await sumSleepCostUsd({ userId: userA, botId: bot, since: at("2026-10-03T00:00:00Z") }), 0.005);
		assert.equal(await sumSleepCostUsd({ userId: userB, botId: bot, since: at("2026-10-01T00:00:00Z") }), 0);
	});

	test("a leitura do dia pagina até o fim: dia com mais falas que a página não é cortado, mesmo com horários iguais (auditoria F5, C5/B2)", async () => {
		const bot = (await createTestBot(userA, { name: "longo" })).id;
		const conv = (await prisma.conversation.create({ data: { userId: userA } })).id;
		await prisma.bot.update({ where: { id: bot }, data: { conversationId: conv } });
		const same = new Date("2026-11-04T12:00:00Z");
		const tag = `long-${Date.now()}`;
		await prisma.conversationMessage.createMany({ data: Array.from({ length: 8 }, (_, i) => ({ id: `${tag}-${i}`, conversationId: conv, role: "user", content: `fala ${i}`, createdAt: i < 5 ? same : new Date(same.getTime() + i * 1000) })) });
		const day = await loadSleepDay({ userId: userA, botId: bot, from: new Date("2026-11-04T02:30:00Z"), to: new Date("2026-11-05T02:30:00Z"), pageSize: 3 });
		assert.deepEqual(day?.messages.map((m) => m.id), Array.from({ length: 8 }, (_, i) => `${tag}-${i}`));
		const exact = await loadSleepDay({ userId: userA, botId: bot, from: new Date("2026-11-04T02:30:00Z"), to: new Date("2026-11-05T02:30:00Z"), pageSize: 4 });
		assert.equal(exact?.messages.length, 8, "página cheia no final não deixa nada de fora");
	});

	test("bots para dormir: só os dos donos pedidos, com conversa direta", async () => {
		const bots = await listBotsForSleep([userA]);
		assert.ok(bots.some((b) => b.id === botA && b.ownerId === userA));
		assert.ok(bots.every((b) => b.ownerId === userA));
		assert.deepEqual(await listBotsForSleep([]), []);
		assert.deepEqual(await listBotsForSleep([userB]), []);
	});

	test("fato do sono entra pela memória com origem sleep e relatório, e aparece no 'o que o sono fez'", async () => {
		const added = await addMemoryEntry({ userId: userA, botId: botA, target: "memory", content: "usa Linux no trabalho", source: "sleep", origin: "sleep", reportId: "rep-fact" });
		assert.ok(added.ok);
		const page = await listSleepChanges({ userId: userA, botId: botA, reportId: "rep-fact" });
		assert.deepEqual(page.changes.map((c) => [c.target, c.action, c.source, c.after]), [["memory", "add", "sleep", "usa Linux no trabalho"]]);
		const doctor = await listMemoryForDoctor({ userId: userA, botId: botA });
		assert.ok(doctor.some((m) => m.content === "usa Linux no trabalho" && m.scope === "bot"));
		assert.deepEqual(await listMemoryForDoctor({ userId: userB, botId: botA }), []);
	});
});
