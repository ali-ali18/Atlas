import assert from "node:assert/strict";
import { test } from "node:test";
import { Hono } from "hono";
import type { AuthEnv } from "../middleware/auth.js";

process.env.ATLAS_OWNER_EMAIL ||= "owner@example.com";
process.env.BETTER_AUTH_SECRET ||= "test-secret-long-enough-for-better-auth-middleware";
process.env.ATLAS_HOOK_PEPPER ||= "test-pepper";

const { prisma } = await import("@workspace/db");
const { FakeTable, installFakes } = await import("@workspace/db/testing");
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

test("ler e marcar como não lido: só o dono; leitura monotônica", async () => {
	const base = Date.now() - 3 * 3_600_000;
	const T = (time: string) => new Date(base + Number(time.split(":")[0]) * 60_000 + Number(time.split(":")[1]) * 1000);
	const reads = new FakeTable([{ id: "r1", userId: USER_A, conversationId: "conv-a", lastReadAt: T("08:00"), lastReadMessageId: null, manualUnread: false, updatedAt: new Date() }], () => ({ lastReadMessageId: null, manualUnread: false, updatedAt: new Date() }));
	const conversations = new FakeTable([{ id: "conv-a", userId: USER_A, createdAt: T("08:00") }]);
	const messages = new FakeTable([
		{ id: "m1", conversationId: "conv-a", role: "assistant", createdAt: T("09:00") },
		{ id: "m2", conversationId: "conv-a", role: "assistant", createdAt: T("09:10") },
	]);
	const installed = installFakes({ conversationRead: reads, conversation: conversations, conversationMessage: messages, runDelivery: new FakeTable([]) });
	const originalFindFirst = prisma.conversation.findFirst;
	// getOwnedConversation filtra por dono; o fake ignora o OR do bot, então só confere id + userId.
	prisma.conversation.findFirst = (async (args: { where: { id: string; userId: string } }) =>
		args.where.id === "conv-a" && args.where.userId === USER_A ? { id: "conv-a" } : null) as unknown as typeof prisma.conversation.findFirst;
	try {
		for (const path of ["read", "unread"]) {
			const denied = await appFor(USER_B).request(`/v1/conversations/conv-a/${path}`, { method: "POST" });
			assert.equal(denied.status, 404, path);
		}
		assert.equal(reads.rows.length, 1);
		const state = await appFor(USER_A).request("/v1/conversations/conv-a/read");
		assert.deepEqual(await state.json(), { unreadCount: 2, firstUnreadMessageId: "m1", manualUnread: false });
		const partial = await appFor(USER_A).request("/v1/conversations/conv-a/read", { method: "POST", body: JSON.stringify({ upToMessageId: "m1" }) });
		assert.deepEqual(await partial.json(), { unreadCount: 1, firstUnreadMessageId: "m2", manualUnread: false });
		const all = await appFor(USER_A).request("/v1/conversations/conv-a/read", { method: "POST", body: JSON.stringify({ upToMessageId: "m2" }) });
		assert.equal(((await all.json()) as { unreadCount: number }).unreadCount, 0);
		const back = await appFor(USER_A).request("/v1/conversations/conv-a/read", { method: "POST", body: JSON.stringify({ upToMessageId: "m1" }) });
		assert.equal(((await back.json()) as { unreadCount: number }).unreadCount, 0);
		assert.equal((await appFor(USER_A).request("/v1/conversations/conv-a/read", { method: "POST", body: JSON.stringify({ upToMessageId: "nope" }) })).status, 404);
		assert.equal((await appFor(USER_A).request("/v1/conversations/conv-a/read", { method: "POST", body: JSON.stringify({ upToAt: "xx" }) })).status, 400);
		const manual = await appFor(USER_A).request("/v1/conversations/conv-a/unread", { method: "POST" });
		assert.equal(((await manual.json()) as { manualUnread: boolean }).manualUnread, true);
	} finally {
		prisma.conversation.findFirst = originalFindFirst;
		installed.restore();
	}
});
