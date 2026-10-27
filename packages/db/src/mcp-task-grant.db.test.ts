/** Aprovação por tarefa contra Postgres real: escopo por dono/conversa, expiração e teto. Pulado sem ATLAS_TEST_DB_URL. */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { prisma } from "./client.js";
import { consumeMcpTaskGrant, grantMcpTask } from "./mcp-task-grant.js";
import { createTestUser, dbSkip } from "./testing/test-db.js";

async function conversation(userId: string) {
	return prisma.conversation.create({ data: { userId } });
}

describe("aprovação por tarefa (Postgres real)", { skip: dbSkip }, () => {
	test("concede, consome até o teto e respeita dono, conversa e validade", async () => {
		const a = (await createTestUser("grant-a")).id;
		const b = (await createTestUser("grant-b")).id;
		const conv = await conversation(a);
		const other = await conversation(a);
		const key = { userId: a, conversationId: conv.id, connectionId: "conn-1", exposedName: "mcp__cal__create_event" };
		const now = new Date("2026-10-27T12:00:00Z");

		assert.equal(await grantMcpTask({ ...key, userId: b, now }), null, "outro usuário não concede na conversa alheia");
		assert.equal((await grantMcpTask({ ...key, maxUses: 3, now }))?.uses, 1);
		assert.equal((await consumeMcpTaskGrant({ ...key, now }))?.uses, 2);
		assert.equal(await consumeMcpTaskGrant({ ...key, userId: b, now }), null);
		assert.equal(await consumeMcpTaskGrant({ ...key, conversationId: other.id, now }), null);
		assert.equal(await consumeMcpTaskGrant({ ...key, exposedName: "mcp__cal__delete_event", now }), null);
		assert.equal(await consumeMcpTaskGrant({ ...key, connectionId: "conn-2", now }), null);
		assert.equal((await consumeMcpTaskGrant({ ...key, now }))?.uses, 3);
		assert.equal(await consumeMcpTaskGrant({ ...key, now }), null, "teto de usos");
		await grantMcpTask({ ...key, now });
		assert.equal(await consumeMcpTaskGrant({ ...key, now: new Date(now.getTime() + 31 * 60_000) }), null, "vencida");
	});
});
