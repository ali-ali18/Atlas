/** Configurações do bot lidas pelo v4 (Postgres real): só o dono lê; outro dono e id inexistente dão o mesmo `null`. */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { getAgentV4BotSettings } from "./agent-v4-bot-settings.js";
import { prisma } from "./client.js";
import { createTestUser, dbSkip } from "./testing/test-db.js";

describe("getAgentV4BotSettings (Postgres real)", { skip: dbSkip }, () => {
	let ownerId: string;
	let otherId: string;
	let botId: string;

	before(async () => {
		ownerId = (await createTestUser("v4-settings")).id;
		otherId = (await createTestUser("v4-settings-other")).id;
		const conversation = await prisma.conversation.create({ data: { userId: ownerId } });
		botId = (await prisma.bot.create({ data: { ownerId, name: "Atlas", snippet: "Resumo", language: "auto", notify: false, conversationId: conversation.id }, select: { id: true } })).id;
	});
	after(async () => {
		await prisma.$disconnect();
	});

	test("o dono lê nome, resumo, idioma e notificação", async () => {
		assert.deepEqual(await getAgentV4BotSettings(ownerId, botId), { name: "Atlas", snippet: "Resumo", description: null, language: "auto", notify: false });
	});

	test("IDOR: outro dono, id inexistente e dono vazio ou legado dão null", async () => {
		assert.equal(await getAgentV4BotSettings(otherId, botId), null);
		assert.equal(await getAgentV4BotSettings(ownerId, "nao-existe"), null);
		assert.equal(await getAgentV4BotSettings("", botId), null);
		assert.equal(await getAgentV4BotSettings("default", botId), null);
	});
});
