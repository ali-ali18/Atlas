/** Lista de bots (prévia + não lidas) e busca de conversas no Postgres real: mesmo resultado de antes, sem N+1. */
import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import { BOT_LINK_ROLE } from "@workspace/shared";
import { listBots, lastConversationMessages, BOT_PREVIEW_MAX_CHARS } from "./bots.js";
import { prisma } from "./client.js";
import { getUnreadStates, setReadStateMigratedAtForTests } from "./read-state.js";
import { searchConversationMessages } from "./search.js";
import { createTestUser, dbSkip } from "./testing/test-db.js";

const t0 = new Date("2026-10-01T10:00:00.000Z");
const at = (seconds: number) => new Date(t0.getTime() + seconds * 1000);

describe("bots: prévia e não lidas em lote (Postgres real)", { skip: dbSkip }, () => {
	let userId: string;
	let otherId: string;
	const conv: Record<string, string> = {};
	const bots: Record<string, string> = {};

	const mkBot = async (owner: string, name: string) => {
		const conversation = await prisma.conversation.create({ data: { userId: owner, createdAt: at(0) } });
		const bot = await prisma.bot.create({ data: { ownerId: owner, name, conversationId: conversation.id }, select: { id: true } });
		bots[name] = bot.id;
		conv[name] = conversation.id;
	};
	const msg = (name: string, role: string, content: string, seconds: number, extra: Record<string, unknown> = {}) =>
		prisma.conversationMessage.create({ data: { conversationId: conv[name]!, role, content, createdAt: at(seconds), ...extra } });

	before(async () => {
		// Estado de leitura inicial = criação da conversa (nada de "legado conta como lido").
		setReadStateMigratedAtForTests(null);
		userId = (await createTestUser("lq")).id;
		otherId = (await createTestUser("lq-other")).id;
		for (const name of ["ana", "bia", "vazio", "muitas"]) await mkBot(userId, name);
		await mkBot(otherId, "alheio");
		await msg("ana", "user", "oi", 1);
		await msg("ana", "assistant", "primeira resposta", 2);
		await msg("ana", "assistant", "x".repeat(500), 3, { sourceKind: "routine", sourceLabel: "Resumo", sourceAt: at(3) });
		// O marcador interno de "enviou mensagem para X" nunca é prévia.
		await msg("ana", BOT_LINK_ROLE, "link", 4);
		await msg("bia", "assistant", "só uma", 5);
		await msg("alheio", "assistant", "segredo do outro usuário", 6);
	});

	test("prévia: última mensagem sem bot-link, cortada em 200 caracteres, com origem; vazio => null", async () => {
		const list = await listBots(userId);
		const byName = new Map(list.map((b) => [b.name, b]));
		const ana = byName.get("ana")!.lastMessage!;
		assert.equal(ana.role, "assistant");
		assert.equal(ana.content.length, BOT_PREVIEW_MAX_CHARS);
		assert.deepEqual(ana.source, { kind: "routine", label: "Resumo" });
		assert.equal(byName.get("bia")!.lastMessage!.content, "só uma");
		assert.equal(byName.get("vazio")!.lastMessage, null);
	});

	test("isolamento por dono: o outro usuário não aparece na lista nem na prévia", async () => {
		const list = await listBots(userId);
		assert.ok(!list.some((b) => b.name === "alheio"));
		assert.ok(!JSON.stringify(list).includes("segredo do outro usuário"));
		const previews = await lastConversationMessages([conv.ana!, conv.alheio!]);
		assert.equal(previews.size, 2); // a função recebe ids já autorizados pela lista do dono
		assert.equal((await listBots(otherId)).length, 1);
	});

	test("não lidas: conta só fala do assistente depois da leitura e aponta a primeira", async () => {
		const states = await getUnreadStates(userId, [conv.ana!, conv.bia!, conv.vazio!]);
		assert.deepEqual(states.get(conv.ana!)!.unreadCount, 2);
		assert.equal(states.get(conv.bia!)!.unreadCount, 1);
		assert.equal(states.get(conv.vazio!)!.unreadCount, 0);
		assert.equal(states.get(conv.vazio!)!.firstUnreadMessageId, null);
		const first = await prisma.conversationMessage.findFirst({ where: { conversationId: conv.ana!, role: "assistant" }, orderBy: { createdAt: "asc" } });
		assert.equal(states.get(conv.ana!)!.firstUnreadMessageId, first!.id);
		// Linhas de leitura criadas em lote e idempotentes.
		const again = await getUnreadStates(userId, [conv.ana!, conv.bia!]);
		assert.equal(again.get(conv.ana!)!.unreadCount, 2);
		assert.equal(await prisma.conversationRead.count({ where: { userId } }), 4);
	});

	test("não lidas: lastReadAt e manualUnread respeitados", async () => {
		await prisma.conversationRead.update({
			where: { userId_conversationId: { userId, conversationId: conv.ana! } },
			data: { lastReadAt: at(2), manualUnread: true },
		});
		const state = (await getUnreadStates(userId, [conv.ana!])).get(conv.ana!)!;
		assert.equal(state.unreadCount, 1); // só a de t=3 (> lastReadAt)
		assert.equal(state.manualUnread, true);
	});

	test("não lidas: acima de 5000 mensagens a contagem continua exata", async () => {
		const total = 5200;
		await prisma.conversationMessage.createMany({
			data: Array.from({ length: total }, (_, i) => ({ conversationId: conv.muitas!, role: "assistant", content: `m${i}`, createdAt: at(10 + i) })),
		});
		const state = (await getUnreadStates(userId, [conv.muitas!])).get(conv.muitas!)!;
		assert.equal(state.unreadCount, total);
		const list = await listBots(userId);
		assert.equal(list.find((b) => b.name === "muitas")!.unreadCount, total);
	});
});

describe("busca de conversas: escopo por dono/bot antes do casamento (Postgres real)", { skip: dbSkip }, () => {
	let userId: string;
	let otherId: string;
	let convA: string;
	let convB: string;
	let convOther: string;
	let botA: string;
	let botB: string;

	before(async () => {
		userId = (await createTestUser("sr")).id;
		otherId = (await createTestUser("sr-other")).id;
		const mk = async (owner: string, name: string) => {
			const conversation = await prisma.conversation.create({ data: { userId: owner } });
			const bot = await prisma.bot.create({ data: { ownerId: owner, name, conversationId: conversation.id }, select: { id: true } });
			return { conversationId: conversation.id, botId: bot.id };
		};
		const a = await mk(userId, "a");
		const b = await mk(userId, "b");
		const o = await mk(otherId, "o");
		[convA, botA, convB, botB, convOther] = [a.conversationId, a.botId, b.conversationId, b.botId, o.conversationId];
		const add = (conversationId: string, content: string, seconds: number, role = "user") =>
			prisma.conversationMessage.create({ data: { conversationId, role, content, createdAt: at(seconds) } });
		await add(convA, "planejamento da viagem para Lisboa", 1);
		await add(convB, "viagem de trabalho e Lisboa em março", 2);
		await add(convOther, "viagem secreta para Lisboa", 3);
		await add(convA, "ILIKE-token-xyz123 no meio", 4);
	});

	test("só devolve conversas do dono; sem vazamento do outro usuário", async () => {
		const hits = await searchConversationMessages("viagem Lisboa", { userId, limit: 10 });
		assert.deepEqual(hits.map((h) => h.conversationId).sort(), [convA, convB].sort());
		assert.ok(!hits.some((h) => h.conversationId === convOther));
	});

	test("botId restringe à conversa do bot; excludeConversationId exclui", async () => {
		const onlyA = await searchConversationMessages("viagem Lisboa", { userId, botId: botA, limit: 10 });
		assert.deepEqual(onlyA.map((h) => h.conversationId), [convA]);
		const noA = await searchConversationMessages("viagem Lisboa", { userId, excludeConversationId: convA, limit: 10 });
		assert.deepEqual(noA.map((h) => h.conversationId), [convB]);
		const bOnly = await searchConversationMessages("Lisboa", { userId, botId: botB, limit: 10 });
		assert.deepEqual(bOnly.map((h) => h.conversationId), [convB]);
	});

	test("fallback ILIKE segue escopado (fragmento que o tsvector não casa)", async () => {
		const hits = await searchConversationMessages("token-xyz12", { userId, limit: 10 });
		assert.deepEqual(hits.map((h) => h.conversationId), [convA]);
		const alheio = await searchConversationMessages("token-xyz12", { userId: otherId, limit: 10 });
		assert.deepEqual(alheio, []);
	});

	test("o índice GIN e os HNSW existem após as migrations", async () => {
		const rows = await prisma.$queryRaw<Array<{ indexname: string }>>`
			SELECT indexname FROM pg_indexes
			WHERE indexname IN ('conversation_messages_content_fts_idx', 'memory_entries_embedding_hnsw_idx', 'skill_versions_embedding_hnsw_idx')`;
		assert.equal(rows.length, 3);
	});
});
