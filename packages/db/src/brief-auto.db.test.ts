/** "Seu dia" ligado por padrão no Postgres real: opt-out por todos os caminhos, aviso único e escopo por dono. */
import assert from "node:assert/strict";
import { describe, test, before, mock } from "node:test";
import { BRIEF_NOTICE_SHOWN_KEY, BRIEF_OPT_OUT_KEY, BRIEF_CHECKED_AT_KEY, DAILY_BRIEF_TEMPLATE, readBriefNoticeShown, readBriefOptOut } from "@workspace/shared";
import { prisma } from "./client.js";
import { claimBriefNotice, listAutoBriefCandidates, loadAutoBriefSignals, markBriefAutoChecked, markBriefOptOut, releaseBriefNotice, withBriefAutoLock } from "./brief-auto.js";
import { deleteRoutineGroup } from "./routine-groups.js";
import { deleteRoutine, updateRoutine } from "./routines.js";
import { updateBot } from "./bots.js";
import { createTestBot, createTestUser, dbSkip } from "./testing/test-db.js";

describe("Seu dia por padrão (Postgres real)", { skip: dbSkip }, () => {
	let userA: string;
	let userB: string;

	before(async () => {
		userA = (await createTestUser("auto-a")).id;
		userB = (await createTestUser("auto-b")).id;
	});

	const newBot = async (userId: string, policyJson?: object, isPrimary = false) => {
		const bot = await createTestBot(userId, { isPrimary });
		if (policyJson) await prisma.bot.update({ where: { id: bot.id }, data: { policyJson } });
		return bot.id;
	};
	const policyOf = async (botId: string) => (await prisma.bot.findUniqueOrThrow({ where: { id: botId }, select: { policyJson: true } })).policyJson;
	const newBrief = (userId: string, botId: string, over: { createdBy?: string; groupId?: string; template?: string | null } = {}) =>
		prisma.routine.create({
			data: {
				userId,
				botId,
				name: "Seu dia",
				prompt: "p",
				template: over.template === undefined ? DAILY_BRIEF_TEMPLATE : over.template,
				createdBy: over.createdBy ?? "bot",
				triggerType: "cron",
				schedule: "30 7 * * *",
				...(over.groupId ? { groupId: over.groupId } : {}),
			},
			select: { id: true },
		});

	test("markBriefOptOut grava só a chave, preserva o resto do policyJson e é idempotente", async () => {
		const botId = await newBot(userA, { proactive: { enabled: true }, decideForOtherBots: true });
		await markBriefOptOut(userA, botId);
		await markBriefOptOut(userA, botId);
		const policy = (await policyOf(botId)) as Record<string, unknown>;
		assert.equal(policy[BRIEF_OPT_OUT_KEY], true);
		assert.equal(policy.decideForOtherBots, true);
		assert.deepEqual(policy.proactive, { enabled: true });
	});

	test("policyJson nulo ou fora de objeto vira objeto com a chave", async () => {
		const nulo = await newBot(userA);
		await markBriefOptOut(userA, nulo);
		assert.equal(readBriefOptOut(await policyOf(nulo)), true);
		const lista = await newBot(userA, ["x"] as unknown as object);
		await markBriefOptOut(userA, lista);
		assert.equal(readBriefOptOut(await policyOf(lista)), true);
	});

	test("pausar o Seu dia (updateRoutine enabled=false) marca o opt-out; editar o horário ou reativar não", async () => {
		const botId = await newBot(userA, undefined, false);
		const routine = await newBrief(userA, botId);
		await updateRoutine(userA, botId, routine.id, { schedule: "0 8 * * *" });
		await updateRoutine(userA, botId, routine.id, { enabled: true });
		assert.equal(readBriefOptOut(await policyOf(botId)), false);
		await updateRoutine(userA, botId, routine.id, { enabled: false });
		assert.equal(readBriefOptOut(await policyOf(botId)), true);
	});

	test("opt-out que não grava aborta a pausa e a exclusão: o Seu dia fica como estava", async () => {
		const botId = await newBot(userA);
		const routine = await newBrief(userA, botId);
		const original = Reflect.get(prisma, "$executeRaw");
		Object.assign(prisma, { $executeRaw: async () => { throw new Error("db fora"); } });
		try {
			await assert.rejects(markBriefOptOut(userA, botId), /db fora/);
			await assert.rejects(updateRoutine(userA, botId, routine.id, { enabled: false }), /db fora/);
			await assert.rejects(deleteRoutine(userA, botId, routine.id), /db fora/);
		} finally {
			Object.assign(prisma, { $executeRaw: original });
		}
		const kept = await prisma.routine.findUniqueOrThrow({ where: { id: routine.id } });
		assert.equal(kept.enabled, true, "não pausou");
		assert.equal(readBriefOptOut(await policyOf(botId)), false);
	});

	test("pausar uma rotina comum não marca o opt-out", async () => {
		const botId = await newBot(userA);
		const routine = await newBrief(userA, botId, { template: null });
		await updateRoutine(userA, botId, routine.id, { enabled: false });
		assert.equal(readBriefOptOut(await policyOf(botId)), false);
	});

	test("apagar o Seu dia (deleteRoutine) marca o opt-out; apagar rotina comum não", async () => {
		const botId = await newBot(userA);
		const common = await newBrief(userA, botId, { template: null });
		assert.equal(await deleteRoutine(userA, botId, common.id), true);
		assert.equal(readBriefOptOut(await policyOf(botId)), false);
		const brief = await newBrief(userA, botId);
		assert.equal(await deleteRoutine(userA, botId, brief.id), true);
		assert.equal(readBriefOptOut(await policyOf(botId)), true);
	});

	test("apagar o grupo junto com as rotinas, com o Seu dia dentro, marca o opt-out", async () => {
		const botId = await newBot(userA);
		const group = await prisma.routineGroup.create({ data: { userId: userA, botId, name: "g" }, select: { id: true } });
		await newBrief(userA, botId, { groupId: group.id });
		await deleteRoutineGroup(userA, botId, group.id, { deleteRoutines: true });
		assert.equal(readBriefOptOut(await policyOf(botId)), true);
	});

	test("outro usuário não pausa, não apaga nem marca o opt-out do bot do A", async () => {
		const botId = await newBot(userA);
		const routine = await newBrief(userA, botId);
		assert.equal(await updateRoutine(userB, botId, routine.id, { enabled: false }), null);
		assert.equal(await deleteRoutine(userB, botId, routine.id), false);
		await markBriefOptOut(userB, botId);
		assert.equal(readBriefOptOut(await policyOf(botId)), false);
		assert.ok(await prisma.routine.findUnique({ where: { id: routine.id } }));
	});

	test("updateBot (policyJson da UI) preserva briefOptOut/briefNoticeShown/briefAutoCheckedAt e ignora o que o cliente manda", async () => {
		const botId = await newBot(userA, { proactive: { enabled: true }, [BRIEF_OPT_OUT_KEY]: true, [BRIEF_NOTICE_SHOWN_KEY]: true, [BRIEF_CHECKED_AT_KEY]: "2026-10-01" });
		// PATCH da tela de configurações: não conhece as chaves do servidor
		await updateBot(botId, { policyJson: { proactive: { enabled: false } } }, userA);
		assert.deepEqual(await policyOf(botId), { proactive: { enabled: false }, [BRIEF_OPT_OUT_KEY]: true, [BRIEF_NOTICE_SHOWN_KEY]: true, [BRIEF_CHECKED_AT_KEY]: "2026-10-01" });
		// cliente tentando limpar ou forjar as chaves: ignorado
		await updateBot(botId, { policyJson: { [BRIEF_OPT_OUT_KEY]: false, [BRIEF_NOTICE_SHOWN_KEY]: false, [BRIEF_CHECKED_AT_KEY]: "x", a: 1 } }, userA);
		assert.deepEqual(await policyOf(botId), { a: 1, [BRIEF_OPT_OUT_KEY]: true, [BRIEF_NOTICE_SHOWN_KEY]: true, [BRIEF_CHECKED_AT_KEY]: "2026-10-01" });
		// null do cliente zera só o que é dele
		await updateBot(botId, { policyJson: null }, userA);
		assert.deepEqual(await policyOf(botId), { [BRIEF_OPT_OUT_KEY]: true, [BRIEF_NOTICE_SHOWN_KEY]: true, [BRIEF_CHECKED_AT_KEY]: "2026-10-01" });
	});

	test("updateBot: cliente não cria as chaves do servidor; bot sem policyJson e null continua null; outro dono é 404", async () => {
		const botId = await newBot(userA);
		await updateBot(botId, { policyJson: { [BRIEF_OPT_OUT_KEY]: true, b: 2 } }, userA);
		assert.deepEqual(await policyOf(botId), { b: 2 });
		const vazio = await newBot(userA);
		await updateBot(vazio, { policyJson: null }, userA);
		assert.equal(await policyOf(vazio), null);
		await assert.rejects(updateBot(botId, { policyJson: { c: 1 } }, userB), /Bot not found/);
		assert.deepEqual(await policyOf(botId), { b: 2 });
	});

	test("claimBriefNotice: uma vez por bot, só para o brief criado pelo bot, só pelo dono", async () => {
		const botId = await newBot(userA);
		const auto = await newBrief(userA, botId, { createdBy: "bot" });
		const run1 = (await prisma.routineRun.create({ data: { routineId: auto.id }, select: { id: true } })).id;
		const run2 = (await prisma.routineRun.create({ data: { routineId: auto.id }, select: { id: true } })).id;
		assert.equal(await claimBriefNotice(userB, run1), false);
		assert.equal(readBriefNoticeShown(await policyOf(botId)), false);
		assert.equal(await claimBriefNotice(userA, run1), true);
		assert.equal(await claimBriefNotice(userA, run2), false);
		assert.equal(readBriefNoticeShown(await policyOf(botId)), true);
		// devolver o aviso (brief não guardado) permite mostrar de novo
		await releaseBriefNotice(userA, run1);
		assert.equal(await claimBriefNotice(userA, run2), true);

		const botUser = await newBot(userA);
		const asked = await newBrief(userA, botUser, { createdBy: "user" });
		const askedRun = (await prisma.routineRun.create({ data: { routineId: asked.id }, select: { id: true } })).id;
		assert.equal(await claimBriefNotice(userA, askedRun), false);
		assert.equal(((await policyOf(botUser)) as Record<string, unknown> | null)?.[BRIEF_NOTICE_SHOWN_KEY], undefined);
	});

	test("claimBriefNotice concorrente: só um ganha", async () => {
		const botId = await newBot(userA);
		const auto = await newBrief(userA, botId);
		const runs = await Promise.all([1, 2, 3, 4].map(() => prisma.routineRun.create({ data: { routineId: auto.id }, select: { id: true } })));
		const results = await Promise.all(runs.map((run) => claimBriefNotice(userA, run.id)));
		assert.equal(results.filter(Boolean).length, 1);
	});

	const allCandidates = async () => {
		const all: Awaited<ReturnType<typeof listAutoBriefCandidates>> = [];
		for (let afterId: string | undefined; ; ) {
			const page = await listAutoBriefCandidates({ afterId, limit: 500 });
			all.push(...page);
			if (page.length < 500) return all;
			afterId = page[page.length - 1]!.id;
		}
	};

	test("listAutoBriefCandidates pagina por cursor de id (ordem estável, sem repetir nem pular)", async () => {
		const owners = await Promise.all([1, 2, 3].map((n) => createTestUser(`auto-page-${n}`)));
		const ids = (await Promise.all(owners.map((owner) => newBot(owner.id, undefined, true)))).sort();
		const walked: string[] = [];
		for (let afterId: string | undefined; ; ) {
			const page = await listAutoBriefCandidates({ afterId, limit: 2 });
			walked.push(...page.map((bot) => bot.id));
			if (page.length < 2) break;
			afterId = page[page.length - 1]!.id;
		}
		assert.deepEqual(walked, [...walked].sort(), "ordem de id");
		assert.equal(new Set(walked).size, walked.length, "sem repetir");
		for (const id of ids) assert.ok(walked.includes(id));
	});

	test("markBriefAutoChecked grava só a data, preserva o resto e só vale para o dono", async () => {
		const botId = await newBot(userA, { proactive: { enabled: true } });
		await markBriefAutoChecked(userA, botId, "2026-10-27");
		assert.deepEqual(await policyOf(botId), { proactive: { enabled: true }, [BRIEF_CHECKED_AT_KEY]: "2026-10-27" });
		await markBriefAutoChecked(userB, botId, "2030-01-01");
		assert.equal((await policyOf(botId) as Record<string, unknown>)[BRIEF_CHECKED_AT_KEY], "2026-10-27");
	});

	test("listAutoBriefCandidates: só principais sem Seu dia, de dono real", async () => {
		const withBrief = await newBot(userA, undefined, true);
		await newBrief(userA, withBrief);
		const user = (await createTestUser("auto-c")).id;
		const free = await newBot(user, undefined, true);
		const secondary = await newBot((await createTestUser("auto-d")).id, undefined, false);
		const ids = (await allCandidates()).map((bot) => bot.id);
		assert.ok(ids.includes(free));
		assert.ok(!ids.includes(withBrief));
		assert.ok(!ids.includes(secondary));
	});

	test("loadAutoBriefSignals: mensagens do usuário em 14 dias, pendências só do dono", async () => {
		const user = (await createTestUser("auto-e")).id;
		const botId = await newBot(user, undefined, true);
		const conversation = await prisma.conversation.create({ data: { userId: user } });
		const now = new Date("2026-10-27T15:00:00Z");
		const at = (days: number) => new Date(now.getTime() - days * 86_400_000);
		await prisma.conversationMessage.createMany({
			data: [
				{ conversationId: conversation.id, role: "user", content: "oi", createdAt: at(1) },
				{ conversationId: conversation.id, role: "user", content: "velha", createdAt: at(20) },
				{ conversationId: conversation.id, role: "assistant", content: "resp", createdAt: at(1) },
				{ conversationId: conversation.id, role: "user", content: "da rotina", origin: "routine", createdAt: at(2) },
			],
		});
		const empty = await loadAutoBriefSignals({ userId: user, botId, conversationId: conversation.id, now });
		assert.equal(empty.userMessageAts.length, 1);
		assert.equal(empty.hasPendingWork, false);
		await prisma.routine.create({ data: { userId: user, botId, name: "R", prompt: "p", triggerType: "cron", schedule: "0 9 * * *" } });
		assert.equal((await loadAutoBriefSignals({ userId: user, botId, conversationId: conversation.id, now })).hasPendingWork, true);
		// outro usuário: a conversa do A não aparece
		const other = await loadAutoBriefSignals({ userId: userB, botId, conversationId: conversation.id, now });
		assert.equal(other.userMessageAts.length, 0);
		assert.equal(other.hasPendingWork, false);
	});

	test("withBriefAutoLock serializa duas execuções do mesmo bot", async () => {
		const events: string[] = [];
		const run = (name: string) =>
			withBriefAutoLock("bot-lock-test", async () => {
				events.push(`${name}:in`);
				await new Promise((resolve) => setTimeout(resolve, 80));
				events.push(`${name}:out`);
			});
		await Promise.all([run("a"), run("b")]);
		assert.ok(events[0]!.endsWith(":in") && events[1] === `${events[0]!.split(":")[0]}:out`, events.join(","));
	});
});
