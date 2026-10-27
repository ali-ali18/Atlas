/** Entrega do brief "Seu dia" no Postgres real: semântica de NULL, concorrência, escopo por dono e expiração. */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { prisma } from "./client.js";
import {
	appendBriefMessage,
	briefMessageId,
	expireStaleBriefs,
	isConversationBusyForBrief,
	listPendingBriefs,
	markBriefPending,
	markBriefPosted,
} from "./brief-delivery.js";
import { createTestBot, createTestUser, dbSkip } from "./testing/test-db.js";

describe("entrega do brief (Postgres real)", { skip: dbSkip }, () => {
	let userA: string;
	let userB: string;
	let botA: string;
	let conversationA: string;
	let conversationB: string;
	let routineA: string;

	/** Execução como o cron cria: `eventJson` e `briefStatus` NULL. */
	const newRun = async (createdAt = new Date()) =>
		(await prisma.routineRun.create({ data: { routineId: routineA, createdAt }, select: { id: true } })).id;
	const rowOf = (id: string) => prisma.routineRun.findUniqueOrThrow({ where: { id } });
	const messagesOf = (id: string) => prisma.conversationMessage.findMany({ where: { id: briefMessageId(id) } });

	before(async () => {
		userA = (await createTestUser("brief-a")).id;
		userB = (await createTestUser("brief-b")).id;
		botA = (await createTestBot(userA)).id;
		conversationA = (await prisma.conversation.create({ data: { userId: userA } })).id;
		conversationB = (await prisma.conversation.create({ data: { userId: userB } })).id;
		routineA = (await prisma.routine.create({ data: { userId: userA, botId: botA, name: "Seu dia", prompt: "p", template: "daily_brief" } })).id;
	});
	after(async () => {
		await prisma.$disconnect();
	});

	test("de briefStatus NULL (eventJson NULL): pendente -> postado, e o texto é limpo", async () => {
		const id = await newRun();
		const before = await rowOf(id);
		assert.equal(before.briefStatus, null);
		assert.equal(before.eventJson, null);
		assert.equal(await markBriefPending(userA, id, "Resumo do dia"), true, "NULL tem de marcar (o bug do JSON path não marcava)");
		assert.deepEqual((await listPendingBriefs()).filter((b) => b.routineRunId === id).map((b) => b.text), ["Resumo do dia"]);
		assert.equal(await markBriefPosted(userA, id), true);
		const after = await rowOf(id);
		assert.equal(after.briefStatus, "posted");
		assert.equal(after.briefText, null);
		assert.equal(await markBriefPending(userA, id, "outro"), false, "postado nunca volta a pendente");
		assert.equal(await markBriefPosted(userA, id), false, "segundo marcador perde");
	});

	test("flushes concorrentes: uma mensagem só, uma virada só", async () => {
		const id = await newRun();
		await markBriefPending(userA, id, "Resumo concorrente");
		const results = await Promise.all(
			Array.from({ length: 6 }, async () => {
				const outcome = await appendBriefMessage(userA, conversationA, id, "Resumo concorrente");
				const flipped = await markBriefPosted(userA, id);
				return { outcome, flipped };
			}),
		);
		assert.equal(results.filter((r) => r.outcome === "created").length, 1);
		assert.equal(results.filter((r) => r.outcome === "exists").length, 5);
		assert.equal(results.filter((r) => r.flipped).length, 1);
		assert.equal((await messagesOf(id)).length, 1);
		assert.equal((await rowOf(id)).briefStatus, "posted");
	});

	test("queda entre inserir e marcar: reinserir não duplica e a marcação conclui", async () => {
		const id = await newRun();
		await markBriefPending(userA, id, "Resumo");
		assert.equal(await appendBriefMessage(userA, conversationA, id, "Resumo"), "created");
		// worker caiu aqui: continua pendente
		assert.equal((await rowOf(id)).briefStatus, "pending");
		assert.equal(await appendBriefMessage(userA, conversationA, id, "Resumo"), "exists");
		assert.equal(await markBriefPosted(userA, id), true);
		assert.equal((await messagesOf(id)).length, 1);
	});

	test("escopo (rule 40): o usuário B não marca, não posta nem lê o brief do usuário A", async () => {
		const id = await newRun();
		assert.equal(await markBriefPending(userB, id, "invasão"), false);
		assert.equal((await rowOf(id)).briefStatus, null);
		await markBriefPending(userA, id, "Resumo do A");
		assert.equal(await markBriefPosted(userB, id), false);
		assert.equal((await rowOf(id)).briefStatus, "pending");
		await assert.rejects(appendBriefMessage(userB, conversationA, id, "x"), /Conversation not found/, "conversa do A");
		await assert.rejects(appendBriefMessage(userB, conversationB, id, "x"), /Routine run not found/, "execução do A na conversa do B");
		assert.equal((await messagesOf(id)).length, 0);
	});

	test("expiração: pendente há mais de 12 h vira expired, perde o texto e não é listado", async () => {
		const old = await newRun(new Date(Date.now() - 13 * 3_600_000));
		const fresh = await newRun();
		await markBriefPending(userA, old, "velho");
		await markBriefPending(userA, fresh, "novo");
		assert.ok((await listPendingBriefs()).every((b) => b.routineRunId !== old));
		assert.ok((await expireStaleBriefs()) >= 1);
		const row = await rowOf(old);
		assert.equal(row.briefStatus, "expired");
		assert.equal(row.briefText, null);
		assert.equal((await rowOf(fresh)).briefStatus, "pending");
		assert.equal(await markBriefPending(userA, old, "volta?"), false, "expirado não volta");
	});

	test("ocupada: na fila/rodando/tentando de novo segura; waiting_user e pausada não; run recém-terminada segura 5 s", async () => {
		const conversationId = (await prisma.conversation.create({ data: { userId: userA } })).id;
		const now = new Date();
		// Há no máximo uma execução ativa por conversa: o mesmo registro percorre os estados.
		const run = await prisma.agentRun.create({ data: { userId: userA, conversationId, objective: "o", model: "m", status: "waiting_user" }, select: { id: true } });
		assert.equal(await isConversationBusyForBrief(conversationId, now), false, "waiting_user");
		await prisma.agentRun.update({ where: { id: run.id }, data: { status: "paused" } });
		assert.equal(await isConversationBusyForBrief(conversationId, now), false, "paused");
		for (const status of ["queued", "running", "retrying"]) {
			await prisma.agentRun.update({ where: { id: run.id }, data: { status } });
			assert.equal(await isConversationBusyForBrief(conversationId, now), true, status);
		}
		await prisma.agentRun.update({ where: { id: run.id }, data: { status: "completed", finishedAt: new Date(now.getTime() - 2_000) } });
		assert.equal(await isConversationBusyForBrief(conversationId, now), true, "terminou há 2 s");
		assert.equal(await isConversationBusyForBrief(conversationId, new Date(now.getTime() + 10_000)), false, "terminou há 12 s");
	});
});
