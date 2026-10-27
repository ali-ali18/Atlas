/** Entrega do brief "Seu dia" no Postgres real: semântica de NULL, concorrência, escopo por dono e expiração. */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { BRIEF_FAILURE_LINE, BRIEF_RUN_SUMMARY_FAILED, BRIEF_RUN_SUMMARY_SENT } from "@workspace/shared";
import { prisma } from "./client.js";
import {
	appendBriefMessage,
	briefMessageId,
	claimBriefPush,
	expireStaleBriefs,
	isConversationBusyForBrief,
	listPendingBriefs,
	markBriefExpired,
	markBriefPending,
	markBriefPosted,
	recoverUnstartedBriefs,
	releaseBriefPush,
} from "./brief-delivery.js";
import { settleRoutineRunForAgentRun } from "./routines.js";
import { createTestBot, createTestUser, dbSkip } from "./testing/test-db.js";

describe("entrega do brief (Postgres real)", { skip: dbSkip }, () => {
	let userA: string;
	let userB: string;
	let botA: string;
	let conversationA: string;
	let conversationB: string;
	let routineA: string;

	/** Execução como o cron cria: `eventJson` e `briefStatus` NULL. */
	const newRun = async (createdAt = new Date(), routineId = routineA) =>
		(await prisma.routineRun.create({ data: { routineId, createdAt }, select: { id: true } })).id;
	/** Execução concluída do agente + execução da rotina, como o fim do run deixa antes de entregar. */
	const completedRun = async (over: { userId?: string; resultText?: string | null; finishedAt?: Date; status?: string; createdAt?: Date } = {}) => {
		const agentRun = await prisma.agentRun.create({
			data: { userId: over.userId ?? userA, conversationId: conversationA, objective: "o", model: "m", status: over.status ?? "completed", resultText: over.resultText ?? "Resumo do run" },
		});
		const run = await prisma.routineRun.create({
			data: {
				routineId: routineA,
				agentRunId: agentRun.id,
				status: "succeeded",
				createdAt: over.createdAt ?? new Date(Date.now() - 120_000),
				finishedAt: over.finishedAt ?? new Date(Date.now() - 90_000),
			},
			select: { id: true },
		});
		return run.id;
	};
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
		// Limpa tudo o que o arquivo criou (reexecução não acumula linhas nem interfere nas listas globais).
		const users = [userA, userB];
		await prisma.conversationMessage.deleteMany({ where: { conversation: { userId: { in: users } } } });
		await prisma.routineRun.deleteMany({ where: { routine: { userId: { in: users } } } });
		await prisma.routine.deleteMany({ where: { userId: { in: users } } });
		await prisma.agentRun.deleteMany({ where: { userId: { in: users } } });
		await prisma.conversation.deleteMany({ where: { userId: { in: users } } });
		await prisma.bot.deleteMany({ where: { ownerId: { in: users } } });
		await prisma.user.deleteMany({ where: { id: { in: users } } });
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

	test("modos de marcar: o brief real troca a linha de falha pendente; a linha nunca sobrescreve nem trava", async () => {
		const failureFirst = await newRun();
		assert.equal(await markBriefPending(userA, failureFirst, "linha de falha", "ifUnset"), true);
		assert.equal(await markBriefPending(userA, failureFirst, "brief real", "replace"), true, "troca a linha ainda pendente");
		assert.equal((await rowOf(failureFirst)).briefText, "brief real");

		const realFirst = await newRun();
		await markBriefPending(userA, realFirst, "brief real", "replace");
		assert.equal(await markBriefPending(userA, realFirst, "linha de falha", "ifUnset"), false, "não sobrescreve o pendente");
		assert.equal((await rowOf(realFirst)).briefText, "brief real");

		const posted = await newRun();
		await markBriefPending(userA, posted, "brief real");
		await markBriefPosted(userA, posted);
		assert.equal(await markBriefPending(userA, posted, "x", "replace"), false, "nunca por cima de postado");
		assert.equal(await markBriefPending(userA, posted, "x", "ifUnset"), false);
		assert.equal((await rowOf(posted)).briefStatus, "posted");
	});

	test("push reivindicado uma vez só (concorrente), devolvível e escopado pelo dono", async () => {
		const id = await newRun();
		await markBriefPending(userA, id, "Resumo");
		assert.equal(await claimBriefPush(userB, id), false, "outro usuário não reivindica");
		assert.equal((await rowOf(id)).briefPushedAt, null);
		const wins = await Promise.all(Array.from({ length: 5 }, () => claimBriefPush(userA, id)));
		assert.equal(wins.filter(Boolean).length, 1);
		assert.notEqual((await rowOf(id)).briefPushedAt, null);
		await releaseBriefPush(userB, id);
		assert.notEqual((await rowOf(id)).briefPushedAt, null, "outro usuário não devolve");
		await releaseBriefPush(userA, id);
		assert.equal(await claimBriefPush(userA, id), true);
		const pending = (await listPendingBriefs()).find((b) => b.routineRunId === id);
		assert.equal(pending?.pushed, true);
		assert.equal(pending?.notify, "always");
	});

	test("expirar um brief: só pendente e só do dono", async () => {
		const id = await newRun();
		await markBriefPending(userA, id, "Resumo");
		assert.equal(await markBriefExpired(userB, id), false);
		assert.equal(await markBriefExpired(userA, id), true);
		const row = await rowOf(id);
		assert.equal(row.briefStatus, "expired");
		assert.equal(row.briefText, null);
		assert.equal(await markBriefExpired(userA, id), false);
	});

	test("lista pendentes: mais antigos primeiro e no máximo `limit` por varredura (o resto fica para a próxima)", async () => {
		const routine = (await prisma.routine.create({ data: { userId: userA, botId: botA, name: "Seu dia (limite)", prompt: "p", template: "daily_brief" } })).id;
		const ids: string[] = [];
		for (let i = 0; i < 5; i += 1) {
			const id = await newRun(new Date(Date.now() - (10 - i) * 60_000), routine);
			await markBriefPending(userA, id, `Resumo ${i}`);
			ids.push(id);
		}
		const mine = (items: Array<{ routineRunId: string }>) => items.map((item) => item.routineRunId).filter((id) => ids.includes(id));
		assert.deepEqual(mine(await listPendingBriefs()), ids, "ordem de criação");
		assert.equal((await listPendingBriefs(new Date(), 2)).length, 2, "respeita o limite");
		for (const id of ids.slice(0, 2)) await markBriefPosted(userA, id);
		assert.deepEqual(mine(await listPendingBriefs()), ids.slice(2), "o que foi postado sai e os seguintes entram");
	});

	test("recuperação: run concluído sem estado vira pendente com o resultText; escopo, janela, tolerância e status respeitados", async () => {
		const good = await completedRun({ resultText: "Resumo recuperado" });
		const empty = await completedRun({ resultText: "  " });
		const tooFresh = await completedRun({ finishedAt: new Date() });
		const tooOld = await completedRun({ createdAt: new Date(Date.now() - 13 * 3_600_000), finishedAt: new Date(Date.now() - 13 * 3_600_000 + 60_000) });
		const notCompleted = await completedRun({ status: "failed" });
		const foreign = await completedRun({ userId: userB });
		const alreadyPosted = await completedRun();
		await prisma.routineRun.update({ where: { id: alreadyPosted }, data: { briefStatus: "posted" } });
		const alreadyPending = await completedRun();
		await markBriefPending(userA, alreadyPending, "texto do caminho normal");

		assert.ok((await recoverUnstartedBriefs()) >= 2);

		const good_ = await rowOf(good);
		assert.equal(good_.briefStatus, "pending");
		assert.equal(good_.briefText, "Resumo recuperado");
		assert.equal((await rowOf(empty)).briefText, "Não consegui montar seu resumo de hoje.");
		for (const [name, id] of [["fresco demais", tooFresh], ["velho", tooOld], ["run não concluído", notCompleted], ["run de outro dono", foreign]] as const) {
			assert.equal((await rowOf(id)).briefStatus, null, name);
		}
		assert.equal((await rowOf(alreadyPosted)).briefStatus, "posted");
		assert.equal((await rowOf(alreadyPending)).briefText, "texto do caminho normal", "nunca sobrescreve");
		await recoverUnstartedBriefs();
		assert.equal((await rowOf(good)).briefText, "Resumo recuperado", "segunda passada é inofensiva");
	});

	test("recuperação de run que falhou: guarda a linha fixa de falha (ifUnset), sem texto parcial, respeitando janela e tolerância", async () => {
		const failedRun = async (over: { createdAt?: Date; finishedAt?: Date | null; routineId?: string; partial?: string | null } = {}) => {
			const agentRun = await prisma.agentRun.create({
				data: { userId: userA, conversationId: conversationA, objective: "o", model: "m", status: "failed", resultText: over.partial ?? null },
			});
			return (
				await prisma.routineRun.create({
					data: {
						routineId: over.routineId ?? routineA,
						agentRunId: agentRun.id,
						status: "failed",
						error: "limite de recuperação",
						createdAt: over.createdAt ?? new Date(Date.now() - 120_000),
						finishedAt: over.finishedAt === undefined ? new Date(Date.now() - 90_000) : over.finishedAt,
					},
					select: { id: true },
				})
			).id;
		};
		const orphan = await failedRun({ partial: "SEGREDO parcial do modelo" });
		const tooFresh = await failedRun({ finishedAt: new Date() });
		const tooOld = await failedRun({ createdAt: new Date(Date.now() - 13 * 3_600_000), finishedAt: new Date(Date.now() - 13 * 3_600_000 + 60_000) });
		const alreadyPending = await failedRun();
		await markBriefPending(userA, alreadyPending, "brief real pendente");
		const alreadyPosted = await failedRun();
		await prisma.routineRun.update({ where: { id: alreadyPosted }, data: { briefStatus: "posted" } });
		const plainRoutine = (await prisma.routine.create({ data: { userId: userA, botId: botA, name: "Comum (falha)", prompt: "p" } })).id;
		const notBrief = await failedRun({ routineId: plainRoutine });

		assert.ok((await recoverUnstartedBriefs()) >= 1);

		const recovered = await rowOf(orphan);
		assert.equal(recovered.briefStatus, "pending");
		assert.equal(recovered.briefText, BRIEF_FAILURE_LINE, "linha fixa, nunca o texto parcial");
		assert.equal((await rowOf(tooFresh)).briefStatus, null, "tolerância");
		assert.equal((await rowOf(tooOld)).briefStatus, null, "janela de 12 h");
		assert.equal((await rowOf(alreadyPending)).briefText, "brief real pendente", "nunca sobrescreve");
		assert.equal((await rowOf(alreadyPosted)).briefStatus, "posted");
		assert.equal((await rowOf(notBrief)).briefStatus, null, "só rotina do brief");
		assert.equal((await listPendingBriefs()).find((b) => b.routineRunId === orphan)?.userId, userA, "dono vem da rotina");
		await recoverUnstartedBriefs();
		assert.equal((await rowOf(orphan)).briefText, BRIEF_FAILURE_LINE, "segunda passada é inofensiva");
	});

	test("summary da execução: brief guarda só o rótulo fixo (o texto vai só ao chat); rotina comum guarda o resultado", async () => {
		const plain = (await prisma.routine.create({ data: { userId: userA, botId: botA, name: "Comum", prompt: "p" } })).id;
		const settle = async (routineId: string, status: string, resultText: string, error?: string) => {
			const agentRun = await prisma.agentRun.create({ data: { userId: userA, conversationId: conversationA, objective: "o", model: "m", status } });
			const run = await prisma.routineRun.create({ data: { routineId, agentRunId: agentRun.id, status: "running" }, select: { id: true } });
			await settleRoutineRunForAgentRun(agentRun.id, { status, resultText, error });
			return rowOf(run.id);
		};
		const ok = await settle(routineA, "completed", "SEGREDO: reunião com o cliente às 10h");
		assert.equal(ok.summary, BRIEF_RUN_SUMMARY_SENT);
		assert.equal(ok.status, "succeeded");
		const failed = await settle(routineA, "failed", "SEGREDO parcial", "boom");
		assert.equal(failed.summary, BRIEF_RUN_SUMMARY_FAILED);
		assert.equal(failed.error, "boom");
		const common = await settle(plain, "completed", "Resultado da rotina comum");
		assert.equal(common.summary, "Resultado da rotina comum");
	});
});
