import assert from "node:assert/strict";
import { test } from "node:test";
import { Hono } from "hono";
import type { AuthEnv } from "../middleware/auth.js";

process.env.ATLAS_OWNER_EMAIL ||= "owner@example.com";
process.env.BETTER_AUTH_SECRET ||= "test-secret-long-enough-for-reactions";
const { createReactionRoutes } = await import("./reactions.js");

type Reaction = { actor: "user" | "bot"; emoji: string };
/** Banco falso com a mesma regra do real: só o dono da mensagem enxerga e reage. */
function fakeStore() {
	const owner = new Map([["msg-a", "user-a"]]);
	const rows = new Map<string, Reaction[]>();
	const list = (id: string) => rows.get(id) ?? [];
	return {
		rows,
		setUserReaction: async ({ userId, messageId, emoji }: { userId: string; messageId: string; emoji: string | null }) => {
			if (owner.get(messageId) !== userId) return null;
			const others = list(messageId).filter((r) => r.actor !== "user");
			rows.set(messageId, emoji ? [...others, { actor: "user" as const, emoji }] : others);
			return { conversationId: "c", reactions: list(messageId) };
		},
		getOwnedMessageReactions: async (userId: string, messageId: string) =>
			owner.get(messageId) === userId ? { conversationId: "c", reactions: list(messageId) } : null,
	};
}
function appFor(userId: string, store = fakeStore()) {
	const app = new Hono<AuthEnv>();
	app.use("*", async (c, next) => {
		c.set("session", { user: { id: userId } } as AuthEnv["Variables"]["session"]);
		await next();
	});
	app.route("/", createReactionRoutes(store as never));
	return app;
}
const json = (method: string, body?: unknown) => ({ method, headers: { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

test("o dono reage, troca e tira a reação", async () => {
	const store = fakeStore();
	const app = appFor("user-a", store);
	const put = await app.request("/v1/messages/msg-a/reaction", json("PUT", { emoji: "👍" }));
	assert.equal(put.status, 200);
	assert.deepEqual(await put.json(), { reactions: [{ actor: "user", emoji: "👍" }] });
	const swap = await app.request("/v1/messages/msg-a/reaction", json("PUT", { emoji: "❤️" }));
	assert.deepEqual(await swap.json(), { reactions: [{ actor: "user", emoji: "❤️" }] });
	const read = await app.request("/v1/messages/msg-a/reactions");
	assert.deepEqual(await read.json(), { reactions: [{ actor: "user", emoji: "❤️" }] });
	const del = await app.request("/v1/messages/msg-a/reaction", json("DELETE"));
	assert.deepEqual(await del.json(), { reactions: [] });
});

test("outro usuário recebe 404 em tudo e nada é gravado", async () => {
	const store = fakeStore();
	const app = appFor("user-b", store);
	assert.equal((await app.request("/v1/messages/msg-a/reaction", json("PUT", { emoji: "👍" }))).status, 404);
	assert.equal((await app.request("/v1/messages/msg-a/reaction", json("DELETE"))).status, 404);
	assert.equal((await app.request("/v1/messages/msg-a/reactions")).status, 404);
	assert.equal((await app.request("/v1/messages/nao-existe/reaction", json("PUT", { emoji: "👍" }))).status, 404);
	assert.equal(store.rows.size, 0);
});

test("emoji inválido ou corpo quebrado: 400", async () => {
	const app = appFor("user-a");
	for (const body of [{ emoji: "texto" }, { emoji: "" }, { emoji: 3 }, {}]) {
		assert.equal((await app.request("/v1/messages/msg-a/reaction", json("PUT", body))).status, 400);
	}
	const broken = await app.request("/v1/messages/msg-a/reaction", { method: "PUT", body: "{" });
	assert.equal(broken.status, 400);
});
