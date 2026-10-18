/** Histórico entre turnos chega ao modelo uma vez só (Postgres real), no fluxo do worker. */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { estimateTokens } from "@workspace/shared";
import { prisma } from "./client.js";
import { loadRecentConversationMessages } from "./conversations.js";
import { buildMemoryAugmentedMessages } from "./memory-context.js";
import { createTestUser, dbSkip } from "./testing/test-db.js";

describe("histórico sem duplicar (Postgres real)", { skip: dbSkip }, () => {
	let userId: string;
	let conversationId: string;
	const objective = "msg-39 pedido atual do usuário";

	before(async () => {
		userId = (await createTestUser("history-once")).id;
		conversationId = (await prisma.conversation.create({ data: { userId } })).id;
		const base = Date.now() - 100_000;
		for (let i = 0; i < 40; i += 1) {
			await prisma.conversationMessage.create({
				data: {
					conversationId,
					role: i % 2 === 0 ? "user" : "assistant",
					content: i === 39 ? objective : `msg-${i} ${"conteúdo de uma fala típica da conversa. ".repeat(12)}`,
					createdAt: new Date(base + i * 1000),
				},
			});
		}
	});
	after(async () => {
		await prisma.$disconnect();
	});

	for (const compact of [false]) {
		test("cada fala anterior aparece uma vez no pacote do modelo (fluxo do worker)", async () => {
			// Igual ao agent-run: histórico carregado + objetivo, depois o contexto de memória.
			const recent = await loadRecentConversationMessages(conversationId, 40);
			const history = recent.map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));
			// Como o appendObjective do worker: o objetivo não repete a última fala já salva.
			const incoming = history.at(-1)?.content === objective ? history : [...history, { role: "user" as const, content: objective }];
			const out = await buildMemoryAugmentedMessages(incoming, { userId, conversationId, compact });
			const conversation = out.filter((m) => m.role !== "system");
			for (let i = 0; i < 39; i += 1) {
				const hits = conversation.filter((m) => m.content.startsWith(`msg-${i} `)).length;
				assert.equal(hits, 1, `msg-${i} apareceu ${hits}x`);
			}
			assert.equal(conversation.filter((m) => m.content === objective).length, 1);
			console.log(`[history-once] mensagens=${conversation.length} tokens~${estimateTokens(JSON.stringify(conversation))}`);
		});
	}
});
