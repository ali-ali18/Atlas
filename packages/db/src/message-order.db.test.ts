/** Ordem da conversa com mensagens do usuário durante um run ativo (Postgres real): ordem do banco = ordem real. */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { prisma } from "./client.js";
import { appendRunAssistantSegment, listConversationMessages } from "./conversations.js";
import { completeAgentRunAtomically, createRunInput } from "./runs.js";
import { createTestUser, dbSkip } from "./testing/test-db.js";

const tick = () => new Promise((resolve) => setTimeout(resolve, 8));

describe("ordem das mensagens com run ativo (Postgres real)", { skip: dbSkip }, () => {
	let userId: string;
	let conversationId: string;
	let runId: string;

	before(async () => {
		userId = (await createTestUser("order")).id;
		conversationId = (await prisma.conversation.create({ data: { userId } })).id;
		await prisma.conversationMessage.create({ data: { conversationId, role: "user", content: "pedido inicial" } });
		await tick();
		runId = (
			await prisma.agentRun.create({
				data: { userId, conversationId, objective: "pedido inicial", status: "running", model: "m", origin: "chat" },
			})
		).id;
	});
	after(async () => {
		await prisma.$disconnect();
	});

	test("3 mensagens do usuário intercaladas com 4 falas do assistente: banco e listagem na ordem real", async () => {
		await tick();
		await createRunInput(runId, { content: "u1 vc n fez o login", mode: "join" }, userId);
		await tick();
		await appendRunAssistantSegment(conversationId, "a1 o cofre tem o login", { createdAt: new Date() });
		await tick();
		await createRunInput(runId, { content: "u2 n consegue ne", mode: "join" }, userId);
		await tick();
		await appendRunAssistantSegment(conversationId, "a2 a pagina ainda mostra login", { createdAt: new Date() });
		await tick();
		await createRunInput(runId, { content: "u3 mas eh falei do gpt", mode: "join" }, userId);
		await tick();
		await appendRunAssistantSegment(conversationId, "a3 consigo sim: claude", { createdAt: new Date() });
		await tick();
		await completeAgentRunAtomically({
			runId,
			conversationId,
			assistantText: "a4 resposta final",
			donePayload: { type: "done", message: { role: "assistant", content: "a4 resposta final" }, model: "m", usage: {} } as never,
		});

		const expected = [
			"pedido inicial",
			"u1 vc n fez o login",
			"a1 o cofre tem o login",
			"u2 n consegue ne",
			"a2 a pagina ainda mostra login",
			"u3 mas eh falei do gpt",
			"a3 consigo sim: claude",
			"a4 resposta final",
		];
		const rows = await prisma.conversationMessage.findMany({ where: { conversationId }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
		assert.deepEqual(rows.map((row) => row.content), expected);
		// API de listagem (janela móvel + cursor) devolve a mesma ordem, inclusive paginando para trás.
		const listed = await listConversationMessages(conversationId, 100);
		assert.deepEqual(listed.map((m) => m.content), expected);
		const tail = await listConversationMessages(conversationId, 3);
		const older = await listConversationMessages(conversationId, 100, { createdAt: tail[0]!.createdAt, id: tail[0]!.id });
		assert.deepEqual([...older, ...tail].map((m) => m.content), expected);
	});
});

describe("fala intermediária repetida (Postgres real)", { skip: dbSkip }, () => {
	test("a mesma fala logo depois dela mesma não é gravada de novo", async () => {
		const userId = (await createTestUser("dup")).id;
		const conversationId = (await prisma.conversation.create({ data: { userId } })).id;
		assert.ok(await appendRunAssistantSegment(conversationId, "ok, continuo"));
		assert.equal(await appendRunAssistantSegment(conversationId, "ok, continuo"), null);
		await prisma.conversationMessage.create({ data: { conversationId, role: "user", content: "e agora?" } });
		assert.ok(await appendRunAssistantSegment(conversationId, "ok, continuo"));
		assert.equal(await prisma.conversationMessage.count({ where: { conversationId, role: "assistant" } }), 2);
	});
});
