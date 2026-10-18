import assert from "node:assert/strict";
import { test } from "node:test";
import { Hono } from "hono";
import type { AuthEnv } from "../middleware/auth.js";

process.env.ATLAS_OWNER_EMAIL ||= "owner@example.com";
process.env.BETTER_AUTH_SECRET ||= "test-secret-long-enough-for-better-auth-middleware";
process.env.ATLAS_HOOK_PEPPER ||= "test-pepper";

const { prisma } = await import("@workspace/db");
const { createConversationRoutes } = await import("./conversations.js");

const USER_A = "user-a-ficticio";
const USER_B = "user-b-ficticio";

function appFor(userId: string) {
	const outer = new Hono<AuthEnv>();
	outer.use("*", async (c, next) => {
		c.set("session", { user: { id: userId } } as AuthEnv["Variables"]["session"]);
		await next();
	});
	outer.route("/", createConversationRoutes());
	return outer;
}

test("resultados vistos: B não limpa o badge do A; A limpa o seu", async () => {
	const deliveries = [{ id: "d1", userId: USER_A, conversationId: "conv-a", seenAt: null as Date | null }];
	const originals = {
		convFindFirst: prisma.conversation.findFirst,
		updateMany: prisma.runDelivery.updateMany,
	};
	prisma.conversation.findFirst = (async (args: { where: { id: string; userId: string } }) =>
		args.where.id === "conv-a" && args.where.userId === USER_A ? { id: "conv-a" } : null) as unknown as typeof prisma.conversation.findFirst;
	prisma.runDelivery.updateMany = (async (args: { where: { userId: string; conversationId: string }; data: { seenAt: Date } }) => {
		const rows = deliveries.filter((row) => row.userId === args.where.userId && row.conversationId === args.where.conversationId && row.seenAt === null);
		for (const row of rows) row.seenAt = args.data.seenAt;
		return { count: rows.length };
	}) as unknown as typeof prisma.runDelivery.updateMany;
	try {
		const asB = await appFor(USER_B).request("/v1/conversations/conv-a/results/seen", { method: "POST" });
		assert.equal(asB.status, 404);
		assert.equal(deliveries[0]!.seenAt, null);
		const asA = await appFor(USER_A).request("/v1/conversations/conv-a/results/seen", { method: "POST" });
		assert.equal(asA.status, 200);
		assert.deepEqual(await asA.json(), { seen: 1 });
		assert.ok(deliveries[0]!.seenAt);
	} finally {
		prisma.conversation.findFirst = originals.convFindFirst;
		prisma.runDelivery.updateMany = originals.updateMany;
	}
});
