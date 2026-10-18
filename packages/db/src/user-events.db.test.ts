/** Gatilhos do log de eventos (user_events) contra Postgres real: seq sem buracos, rollback sem evento, isolamento, sem conteúdo. */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { prisma } from "./client.js";
import { createTestBot, createTestUser, dbSkip } from "./testing/test-db.js";

const eventsOf = (userId: string) => prisma.userEvent.findMany({ where: { userId }, orderBy: { seq: "asc" } });

describe("user_events (Postgres real)", { skip: dbSkip }, () => {
	let userId: string;
	let otherId: string;
	let conversationId: string;
	let botId: string;

	before(async () => {
		userId = (await createTestUser("evt")).id;
		otherId = (await createTestUser("evt-other")).id;
		botId = (await createTestBot(userId)).id;
		await createTestBot(otherId);
		conversationId = (await prisma.conversation.create({ data: { userId } })).id;
	});
	after(async () => {
		await prisma.$disconnect();
	});

	test("mensagem, run e leitura geram eventos com seq 1..N sem buracos, só com ids", async () => {
		const SECRET_TEXT = "senha-super-secreta-123";
		await prisma.conversationMessage.create({ data: { conversationId, role: "user", content: SECRET_TEXT } });
		const run = await prisma.agentRun.create({ data: { userId, botId, conversationId, objective: SECRET_TEXT, status: "queued", model: "m" } });
		await prisma.agentRun.update({ where: { id: run.id }, data: { status: "running" } });
		await prisma.conversationRead.create({ data: { userId, conversationId, lastReadAt: new Date() } });

		const events = await eventsOf(userId);
		const types = events.map((e) => e.type);
		for (const t of ["message", "run", "read"]) assert.ok(types.includes(t), `faltou evento ${t}: ${types.join(",")}`);
		assert.deepEqual(events.map((e) => e.seq), events.map((_, i) => i + 1), "seq deve ser 1..N sem buracos");
		const run2 = events.filter((e) => e.type === "run").map((e) => (e.payload as { status: string }).status);
		assert.ok(run2.includes("running"));
		assert.ok(!JSON.stringify(events).includes(SECRET_TEXT), "payload não pode carregar conteúdo");
	});

	test("rollback não deixa evento nem consome seq", async () => {
		const before = await eventsOf(userId);
		await assert.rejects(
			prisma.$transaction(async (tx) => {
				await tx.conversationMessage.create({ data: { conversationId, role: "assistant", content: "descartada" } });
				throw new Error("desfaz");
			}),
			/desfaz/,
		);
		const afterRollback = await eventsOf(userId);
		assert.equal(afterRollback.length, before.length);
		await prisma.conversationMessage.create({ data: { conversationId, role: "assistant", content: "ok" } });
		const next = await eventsOf(userId);
		assert.equal(next.at(-1)!.seq, before.at(-1)!.seq + 1, "seq continua sem buraco depois do rollback");
	});

	test("isolamento: eventos de um usuário não aparecem para o outro", async () => {
		const baseline = (await eventsOf(otherId)).length; // criar o bot do outro j� publicou "bot"
		assert.ok((await eventsOf(otherId)).every((e) => e.type === "bot"));
		const otherConv = await prisma.conversation.create({ data: { userId: otherId } });
		await prisma.conversationMessage.create({ data: { conversationId: otherConv.id, role: "user", content: "x" } });
		const other = await eventsOf(otherId);
		assert.deepEqual(other.map((e) => e.seq), other.map((_, i) => i + 1));
		assert.equal(other.length, baseline + 1);
		assert.ok(!(await eventsOf(userId)).some((e) => (e.payload as { conversationId?: string }).conversationId === otherConv.id));
	});

	test("escritas concorrentes do mesmo usuário continuam sem buracos nem duplicatas", async () => {
		const start = (await eventsOf(userId)).length;
		await Promise.all(Array.from({ length: 10 }, (_, i) => prisma.conversationMessage.create({ data: { conversationId, role: "user", content: `c${i}` } })));
		const events = await eventsOf(userId);
		assert.equal(events.length, start + 10);
		assert.deepEqual(events.map((e) => e.seq), events.map((_, i) => i + 1));
	});
});
