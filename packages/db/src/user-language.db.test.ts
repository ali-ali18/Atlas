/** Idioma detectado no Postgres real: escopo por usuário (IDOR) e valores inválidos. */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { prisma } from "./client.js";
import { createBot, getBotProfile } from "./bots.js";
import { getLanguageContext, readLanguageStates, writeLanguageStates } from "./user-language.js";
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
});
