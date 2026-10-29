/** Idioma detectado no Postgres real: escopo por usuário (IDOR) e valores inválidos. */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { prisma } from "./client.js";
import { createBot, getBotProfile } from "./bots.js";
import { createGroup, postGroupUserMessage } from "./bot-groups.js";
import { createAgentRun, createRunInput } from "./runs.js";
import { getLanguageContext, noteBrowserLanguage, readLanguageStates, recordUserLanguage, writeLanguageStates } from "./user-language.js";
import { createTestUser, dbSkip } from "./testing/test-db.js";

describe("idioma detectado (Postgres real)", { skip: dbSkip }, () => {
	test("bot com auto é lido como auto e o bot antigo mantém o idioma fixo", async () => {
		const owner = await createTestUser("lang-bot");
		const fresh = await createBot({ name: "Novo", language: "auto" }, owner.id);
		assert.equal(fresh.language, "auto");
		assert.equal((await getBotProfile(fresh.id, owner.id))?.language, "auto");
		const fixed = await createBot({ name: "Fixo", language: "en-US" }, owner.id);
		assert.equal((await getBotProfile(fixed.id, owner.id))?.language, "en-US");
		// linha antiga (criada antes de "auto" existir) segue valendo
		await prisma.bot.update({ where: { id: fixed.id }, data: { language: "pt-BR" } });
		assert.equal((await getBotProfile(fixed.id, owner.id))?.language, "pt-BR");
		// valor desconhecido (versão futura) vale como pt-BR, como o código antigo fazia
		await prisma.bot.update({ where: { id: fixed.id }, data: { language: "xx-XX" } });
		assert.equal((await getBotProfile(fixed.id, owner.id))?.language, "pt-BR");
	});

	test("grava e lê por conversa e por conta; a conversa vence a conta; locale vem do navegador", async () => {
		const owner = await createTestUser("lang-rw");
		const bot = await createBot({ name: "Bot" }, owner.id);
		assert.deepEqual(await getLanguageContext(owner.id, bot.conversationId), { lastLanguage: null, accountLocale: null });
		await writeLanguageStates({ userId: owner.id, conversationId: bot.conversationId, user: { last: "pt-BR", pending: null }, browserLocale: "es-ES" });
		assert.deepEqual(await getLanguageContext(owner.id, null), { lastLanguage: "pt-BR", accountLocale: "es-ES" });
		await writeLanguageStates({ userId: owner.id, conversationId: bot.conversationId, conversation: { last: "en-US", pending: "pt-BR" } });
		assert.deepEqual(await getLanguageContext(owner.id, bot.conversationId), { lastLanguage: "en-US", accountLocale: "es-ES" });
		const states = await readLanguageStates(owner.id, bot.conversationId);
		assert.deepEqual(states.conversation, { last: "en-US", pending: "pt-BR" });
		assert.deepEqual(states.user, { last: "pt-BR", pending: null });
		// o locale escolhido na interface vence o do navegador
		await prisma.userSettings.update({ where: { userId: owner.id }, data: { uiLocale: "en-GB" } });
		assert.equal((await getLanguageContext(owner.id)).accountLocale, "en-GB");
	});

	test("idioma fora do registro não é gravado", async () => {
		const owner = await createTestUser("lang-bad");
		const bot = await createBot({ name: "Bot" }, owner.id);
		await writeLanguageStates({ userId: owner.id, conversationId: bot.conversationId, user: { last: "fr-FR", pending: "auto" }, conversation: { last: "klingon", pending: null }, browserLocale: "fr-FR" });
		assert.deepEqual(await getLanguageContext(owner.id, bot.conversationId), { lastLanguage: null, accountLocale: null });
	});

	test("usuário B não lê nem grava o idioma do usuário A, nem pela conversa dele", async () => {
		const a = await createTestUser("lang-a");
		const b = await createTestUser("lang-b");
		const botA = await createBot({ name: "A" }, a.id);
		await writeLanguageStates({ userId: a.id, conversationId: botA.conversationId, user: { last: "en-US", pending: null }, conversation: { last: "en-US", pending: null }, browserLocale: "en-US" });

		// B pede a conversa de A: não enxerga a conversa nem a conta de A
		const read = await readLanguageStates(b.id, botA.conversationId);
		assert.equal(read.conversation, null);
		assert.deepEqual(read.user, { last: null, pending: null });
		assert.deepEqual(await getLanguageContext(b.id, botA.conversationId), { lastLanguage: null, accountLocale: null });

		// B tenta gravar na conversa de A: nada muda
		await writeLanguageStates({ userId: b.id, conversationId: botA.conversationId, conversation: { last: "es-ES", pending: "es-ES" } });
		assert.deepEqual((await readLanguageStates(a.id, botA.conversationId)).conversation, { last: "en-US", pending: null });

		// sem identidade válida nada é lido nem gravado
		for (const userId of [undefined, "", "default"]) {
			assert.deepEqual(await getLanguageContext(userId, botA.conversationId), { lastLanguage: null, accountLocale: null });
			await writeLanguageStates({ userId, conversationId: botA.conversationId, conversation: { last: "es-ES", pending: null }, user: { last: "es-ES", pending: null } });
		}
		assert.deepEqual((await readLanguageStates(a.id, botA.conversationId)).conversation, { last: "en-US", pending: null });
		assert.equal((await prisma.userSettings.findUnique({ where: { userId: a.id } }))?.lastLanguage, "en-US");
	});

	const EN = "I need you to show me the orders from today and also the stock of the best selling products";
	const PT = "Preciso que você me mostre os pedidos de hoje e também o estoque dos produtos mais vendidos";

	test("recordUserLanguage grava por conversa e por conta, com a regra das 2 confirmações", async () => {
		const owner = await createTestUser("lang-rec");
		const bot = await createBot({ name: "Bot" }, owner.id);
		const record = (text: string) => recordUserLanguage({ userId: owner.id, conversationId: bot.conversationId, text });
		await record("ok");
		assert.deepEqual(await getLanguageContext(owner.id, bot.conversationId), { lastLanguage: null, accountLocale: null });
		await record(EN);
		assert.equal((await getLanguageContext(owner.id, bot.conversationId)).lastLanguage, "en-US");
		await record(PT);
		await record("👍");
		assert.equal((await getLanguageContext(owner.id, bot.conversationId)).lastLanguage, "en-US");
		await record(PT);
		const states = await readLanguageStates(owner.id, bot.conversationId);
		assert.deepEqual(states.conversation, { last: "pt-BR", pending: null });
		assert.deepEqual(states.user, { last: "pt-BR", pending: null });
	});

	test("só mensagem digitada no chat grava: rotina, silenciosa e proativa não", async () => {
		const owner = await createTestUser("lang-run");
		const bot = await createBot({ name: "Bot" }, owner.id);
		const base = { conversationId: bot.conversationId!, botId: bot.id, messages: [{ role: "user" as const, content: EN }] };
		const run = (over: Record<string, unknown>) => createAgentRun({ userId: owner.id, model: "m", request: { ...base, ...over } as never });
		for (const over of [{ origin: "routine" }, { origin: "chat", silent: true }, { origin: "proactive", silent: true }, { origin: "bot", silent: true }]) {
			const created = await run(over);
			await prisma.agentRun.update({ where: { id: created.id }, data: { status: "completed" } });
		}
		assert.deepEqual(await getLanguageContext(owner.id, bot.conversationId), { lastLanguage: null, accountLocale: null });
		const typed = await run({ origin: "chat" });
		assert.equal((await getLanguageContext(owner.id, bot.conversationId)).lastLanguage, "en-US");
		// mensagem digitada no meio do run (join) também conta, e o segundo idioma precisa de confirmação
		await createRunInput(typed.id, { content: PT, mode: "join" }, owner.id);
		assert.deepEqual((await readLanguageStates(owner.id, bot.conversationId)).conversation, { last: "en-US", pending: "pt-BR" });
		await createRunInput(typed.id, { content: PT, mode: "join" }, owner.id);
		assert.equal((await getLanguageContext(owner.id, bot.conversationId)).lastLanguage, "pt-BR");
	});

	test("usuário B não grava idioma na conversa de A (nem pelo run nem pelo registro)", async () => {
		const a = await createTestUser("lang-ra");
		const b = await createTestUser("lang-rb");
		const botA = await createBot({ name: "A" }, a.id);
		await recordUserLanguage({ userId: b.id, conversationId: botA.conversationId, text: EN });
		assert.deepEqual((await readLanguageStates(a.id, botA.conversationId)).conversation, { last: null, pending: null });
		await assert.rejects(createAgentRun({ userId: b.id, model: "m", request: { conversationId: botA.conversationId!, messages: [{ role: "user", content: EN }], origin: "chat" } as never }));
		assert.deepEqual((await readLanguageStates(a.id, botA.conversationId)).conversation, { last: null, pending: null });
		assert.equal((await prisma.userSettings.findUnique({ where: { userId: a.id } }))?.lastLanguage ?? null, null);
	});

	test("noteBrowserLanguage grava o idioma do navegador só quando muda", async () => {
		const owner = await createTestUser("lang-br");
		await noteBrowserLanguage(owner.id, null);
		assert.equal((await readLanguageStates(owner.id)).browserLocale, null);
		await noteBrowserLanguage(owner.id, "es-ES");
		assert.equal((await readLanguageStates(owner.id)).browserLocale, "es-ES");
		await noteBrowserLanguage("default", "en-US");
		assert.equal((await readLanguageStates(owner.id)).browserLocale, "es-ES");
	});

	test("grupo: o idioma é por conversa e segue quem falou por último", async () => {
		const owner = await createTestUser("lang-grp");
		const solo = await createBot({ name: "Solo" }, owner.id);
		const m1 = await createBot({ name: "Bia" }, owner.id);
		const m2 = await createBot({ name: "Caio" }, owner.id);
		const group = await createGroup(owner.id, { name: "Time", memberIds: [m1.id, m2.id] });
		const say = (content: string) => postGroupUserMessage({ userId: owner.id, groupId: group.id, content });
		await say(EN);
		const groupConversation = (await prisma.bot.findUnique({ where: { id: group.id }, select: { conversationId: true } }))!.conversationId!;
		assert.equal((await getLanguageContext(owner.id, groupConversation)).lastLanguage, "en-US");
		// duas falas seguidas no outro idioma trocam; uma só (ou um "ok") não
		await prisma.groupTurn.updateMany({ where: { groupId: group.id }, data: { status: "done" } });
		await say(PT);
		await say("ok");
		assert.equal((await getLanguageContext(owner.id, groupConversation)).lastLanguage, "en-US");
		await prisma.groupTurn.updateMany({ where: { groupId: group.id }, data: { status: "done" } });
		await say(PT);
		assert.equal((await getLanguageContext(owner.id, groupConversation)).lastLanguage, "pt-BR");
		// a conversa de outro bot do mesmo usuário não é afetada
		assert.equal((await readLanguageStates(owner.id, solo.conversationId)).conversation?.last ?? null, null);
	});
});
