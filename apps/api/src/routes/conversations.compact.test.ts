import assert from "node:assert/strict";
import { test } from "node:test";
import { Hono } from "hono";
import type { AuthEnv } from "../middleware/auth.js";

process.env.ATLAS_OWNER_EMAIL ||= "owner@example.com";
process.env.BETTER_AUTH_SECRET ||= "test-secret-long-enough-for-better-auth-middleware";
process.env.ATLAS_HOOK_PEPPER ||= "test-pepper";

const { prisma } = await import("@workspace/db");
const { createConversationRoutes } = await import("./conversations.js");
type Compact = NonNullable<Parameters<typeof createConversationRoutes>[0]>["compact"];

const USER_A = "user-a-ficticio";
const USER_B = "user-b-ficticio";

function appFor(userId: string, compact: NonNullable<Compact>) {
	const outer = new Hono<AuthEnv>();
	outer.use("*", async (c, next) => {
		c.set("session", { user: { id: userId } } as AuthEnv["Variables"]["session"]);
		await next();
	});
	outer.route("/", createConversationRoutes({ compact }));
	return outer;
}

const post = (app: Hono<AuthEnv>, body?: unknown) =>
	app.request("/v1/conversations/conv-a/compact", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });

async function withOwner<T>(run: () => Promise<T>): Promise<T> {
	const original = prisma.conversation.findFirst;
	prisma.conversation.findFirst = (async (args: { where: { id: string; userId: string } }) =>
		args.where.id === "conv-a" && args.where.userId === USER_A ? { id: "conv-a" } : null) as unknown as typeof prisma.conversation.findFirst;
	try {
		return await run();
	} finally {
		prisma.conversation.findFirst = original;
	}
}

test("compactar: só o dono; outro usuário recebe 404 e nada é executado", async () => {
	await withOwner(async () => {
		const calls: unknown[] = [];
		const compact: NonNullable<Compact> = async (input) => { calls.push(input); return { kind: "noop", reason: "too_small", message: "curta" }; };
		const asB = await post(appFor(USER_B, compact));
		assert.equal(asB.status, 404);
		assert.equal(calls.length, 0);
		const asA = await post(appFor(USER_A, compact), { focus: "preços" });
		assert.equal(asA.status, 200);
		assert.deepEqual(calls, [{ userId: USER_A, conversationId: "conv-a", focus: "preços" }]);
	});
});

test("compactar: respostas por desfecho (compactada, aviso, bloqueio 409, falha 503 com a mensagem)", async () => {
	await withOwner(async () => {
		const card = { v: 1 as const, kind: "compaction" as const, before: 48_200, after: 6_100, summary: "Resumo." };
		const compacted = await post(appFor(USER_A, async () => ({ kind: "compacted", before: 48_200, after: 6_100, percent: 87, messageId: "m1", card })));
		assert.equal(compacted.status, 200);
		assert.deepEqual(await compacted.json(), { status: "compacted", before: 48_200, after: 6_100, percent: 87, messageId: "m1", card });
		const noop = await post(appFor(USER_A, async () => ({ kind: "noop", reason: "already_compact", message: "A conversa já está compacta." })));
		assert.deepEqual(await noop.json(), { status: "noop", reason: "already_compact", message: "A conversa já está compacta." });
		const blocked = await post(appFor(USER_A, async () => ({ kind: "blocked", reason: "approval_pending", message: "Há uma aprovação pendente nesta conversa. Responda a ela antes de compactar." })));
		assert.equal(blocked.status, 409);
		assert.deepEqual(await blocked.json(), { error: "Há uma aprovação pendente nesta conversa. Responda a ela antes de compactar.", reason: "approval_pending" });
		const failed = await post(appFor(USER_A, async () => ({ kind: "failed", message: "Não consegui resumir a conversa agora. Tente de novo em instantes." })));
		// 503, não 502: proxies de borda trocam o corpo de 502/504 pela própria página e a mensagem se perde.
		assert.equal(failed.status, 503);
		assert.deepEqual(await failed.json(), { error: "Não consegui resumir a conversa agora. Tente de novo em instantes." });
		const crashed = await post(appFor(USER_A, async () => { throw new Error("db caiu"); }));
		assert.equal(crashed.status, 503);
		assert.deepEqual(await crashed.json(), { error: "Não consegui resumir a conversa agora. Tente de novo em instantes." });
	});
});
