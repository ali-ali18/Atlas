/** Reações e "responder só com reação" (Postgres real): dono, uma por ator, evento no hub, travas e reflexão. */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { prisma } from "./client.js";
import { appendConversationCard, appendConversationMessage, listConversationMessages } from "./conversations.js";
import { getOwnedMessageReactions, listDislikedReplies, setBotReaction, setUserReaction } from "./message-reactions.js";
import { getReactionStateContext, recordReactionOnlyReply } from "./reaction-only.js";
import { createTestBot, createTestUser, dbSkip } from "./testing/test-db.js";

describe("reações (Postgres real)", { skip: dbSkip }, () => {
	let userId: string;
	let otherId: string;
	let botId: string;
	let conversationId: string;
	let assistantId: string;
	let userMsgId: string;

	before(async () => {
		userId = (await createTestUser("rx")).id;
		otherId = (await createTestUser("rx-other")).id;
		botId = (await createTestBot(userId)).id;
		conversationId = (await prisma.conversation.create({ data: { userId } })).id;
		await prisma.bot.update({ where: { id: botId }, data: { conversationId } });
		userMsgId = (await appendConversationMessage(conversationId, "user", "oi")).id;
		assistantId = (await appendConversationMessage(conversationId, "assistant", "Pronto, enviei o relatório.")).id;
	});
	after(async () => {
		await prisma.$disconnect();
	});

	test("uma reação por ator: trocar substitui, tirar remove", async () => {
		const first = await setUserReaction({ userId, messageId: assistantId, emoji: "👍" });
		assert.deepEqual(first?.reactions, [{ actor: "user", emoji: "👍" }]);
		const swapped = await setUserReaction({ userId, messageId: assistantId, emoji: "❤️" });
		assert.deepEqual(swapped?.reactions, [{ actor: "user", emoji: "❤️" }]);
		assert.equal(await prisma.messageReaction.count({ where: { messageId: assistantId } }), 1);
		assert.ok(await setBotReaction({ userId, botId, messageId: assistantId, emoji: "🌙" }));
		const both = await getOwnedMessageReactions(userId, assistantId);
		assert.deepEqual(both?.reactions.map((r) => `${r.actor}:${r.emoji}`).sort(), ["bot:👍", "user:❤️"]);
		const cleared = await setUserReaction({ userId, messageId: assistantId, emoji: null });
		assert.deepEqual(cleared?.reactions, [{ actor: "bot", emoji: "👍" }]);
	});

	test("isolamento: outro usuário não reage nem lê; emoji inválido e cartão recusados", async () => {
		assert.equal(await setUserReaction({ userId: otherId, messageId: assistantId, emoji: "👍" }), null);
		assert.equal(await getOwnedMessageReactions(otherId, assistantId), null);
		assert.equal(await setUserReaction({ userId, messageId: "nao-existe", emoji: "👍" }), null);
		await assert.rejects(setUserReaction({ userId, messageId: assistantId, emoji: "texto" }), RangeError);
		const card = await appendConversationCard(conversationId, { v: 1, kind: "confirm", confirmId: "c1", title: "Enviar?", status: "pending" });
		assert.equal(await setUserReaction({ userId, messageId: card.id, emoji: "👍" }), null);
		assert.equal(await setBotReaction({ userId: otherId, botId, messageId: assistantId, emoji: "👍" }), false);
	});

	test("a lista de mensagens traz as reações", async () => {
		await setUserReaction({ userId, messageId: userMsgId, emoji: "😂" });
		const rows = await listConversationMessages(conversationId, 50);
		assert.deepEqual(rows.find((m) => m.id === userMsgId)?.reactions, [{ actor: "user", emoji: "😂" }]);
		assert.equal(rows.find((m) => m.id === assistantId)?.reactions?.[0]?.actor, "bot");
	});

	test("reagir publica evento 'message' (op reaction) para o dono", async () => {
		const before = (await prisma.userEventCounter.findUnique({ where: { userId } }))?.seq ?? 0;
		await setUserReaction({ userId, messageId: userMsgId, emoji: "🙏" });
		const events = await prisma.userEvent.findMany({ where: { userId, seq: { gt: before } }, orderBy: { seq: "asc" } });
		const hit = events.find((e) => (e.payload as { op?: string }).op === "reaction");
		assert.ok(hit);
		assert.equal(hit.type, "message");
		assert.equal((hit.payload as { messageId?: string }).messageId, userMsgId);
		assert.equal((hit.payload as { conversationId?: string }).conversationId, conversationId);
	});

	test("apagar a mensagem apaga as reações (cascata)", async () => {
		const temp = await appendConversationMessage(conversationId, "assistant", "temporária");
		await setUserReaction({ userId, messageId: temp.id, emoji: "👍" });
		await prisma.conversationMessage.delete({ where: { id: temp.id } });
		assert.equal(await prisma.messageReaction.count({ where: { messageId: temp.id } }), 0);
	});

	test("👎 em fala do assistente vira nota para a reflexão", async () => {
		const reply = await appendConversationMessage(conversationId, "assistant", "Resposta ruim.");
		await setUserReaction({ userId, messageId: reply.id, emoji: "👎" });
		const notes = await listDislikedReplies({ userId, conversationIds: [conversationId], since: new Date(Date.now() - 60_000) });
		assert.deepEqual(notes.map((n) => n.text), ["Resposta ruim."]);
		assert.deepEqual(await listDislikedReplies({ userId, conversationIds: [conversationId], since: new Date(Date.now() + 60_000) }), []);
	});

	describe("estado para as travas e gravação sem run", () => {
		let convId: string;
		before(async () => {
			convId = (await prisma.conversation.create({ data: { userId } })).id;
			await appendConversationMessage(convId, "user", "me manda o relatório");
			await appendConversationMessage(convId, "assistant", "Enviei o relatório.");
		});

		test("conversa calma: sem run, sem cartão, última fala é do assistente", async () => {
			const ctx = await getReactionStateContext({ userId, conversationId: convId });
			assert.equal(ctx.hasActiveRun, false);
			assert.equal(ctx.hasPendingCard, false);
			assert.equal(ctx.isGroup, false);
			assert.equal(ctx.previous?.role, "assistant");
		});

		test("cartão pendente trava; resolvido não", async () => {
			const card = await appendConversationCard(convId, { v: 1, kind: "confirm", confirmId: "cf-1", title: "Enviar e-mail?", status: "pending" });
			assert.equal((await getReactionStateContext({ userId, conversationId: convId })).hasPendingCard, true);
			await prisma.conversationMessage.update({ where: { id: card.id }, data: { content: JSON.stringify({ v: 1, kind: "confirm", confirmId: "cf-1", title: "Enviar e-mail?", status: "approved" }) } });
			assert.equal((await getReactionStateContext({ userId, conversationId: convId })).hasPendingCard, false);
		});

		test("run ativo trava e a gravação recusa (volta ao fluxo normal)", async () => {
			const run = await prisma.agentRun.create({ data: { userId, conversationId, objective: "x", status: "running", model: "m", origin: "chat" } });
			assert.equal((await getReactionStateContext({ userId, conversationId })).hasActiveRun, true);
			assert.equal(await recordReactionOnlyReply({ userId, botId, conversationId, content: "valeu", emoji: "❤️" }), null);
			await prisma.agentRun.update({ where: { id: run.id }, data: { status: "completed" } });
		});

		test("grava a mensagem do usuário e a reação do bot, sem criar run", async () => {
			await prisma.bot.update({ where: { id: botId }, data: { conversationId: convId } });
			const runsBefore = await prisma.agentRun.count({ where: { conversationId: convId } });
			const result = await recordReactionOnlyReply({ userId, botId, conversationId: convId, content: "valeu!", emoji: "❤️" });
			assert.ok(result);
			assert.equal(await prisma.agentRun.count({ where: { conversationId: convId } }), runsBefore);
			const rows = await listConversationMessages(convId, 10);
			const last = rows[rows.length - 1]!;
			assert.equal(last.content, "valeu!");
			assert.equal(last.role, "user");
			assert.deepEqual(last.reactions, [{ actor: "bot", emoji: "❤️" }]);
		});

		test("bot de outro usuário não reage", async () => {
			const count = await prisma.conversationMessage.count({ where: { conversationId: convId } });
			assert.equal(await recordReactionOnlyReply({ userId: otherId, botId, conversationId: convId, content: "oi", emoji: "👍" }), null);
			assert.equal(await prisma.conversationMessage.count({ where: { conversationId: convId } }), count);
		});
	});
});
