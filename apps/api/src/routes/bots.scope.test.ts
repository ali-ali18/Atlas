import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";

process.env.ATLAS_OWNER_EMAIL ||= "owner@example.com";
process.env.BETTER_AUTH_SECRET ||= "test-secret-long-enough-for-better-auth-middleware";

const { prisma } = await import("@workspace/db");
const { Hono } = await import("hono");
const { createBotRoutes } = await import("./bots.js");

const restores: Array<() => void> = [];
function stubMethod(target: object, name: string, implementation: (...args: never[]) => unknown) {
	const original = Reflect.get(target, name);
	Object.assign(target, { [name]: mock.fn(implementation) });
	restores.push(() => Object.assign(target, { [name]: original }));
}
afterEach(() => {
	for (const restore of restores.splice(0).reverse()) restore();
	mock.restoreAll();
});

type Row = Record<string, unknown>;
function matches(row: Row, where: Row = {}): boolean {
	return Object.entries(where).every(([key, expected]) => {
		if (expected && typeof expected === "object" && "in" in (expected as object)) {
			return ((expected as { in: unknown[] }).in).includes(row[key]);
		}
		return row[key] === expected;
	});
}

const NOW = new Date("2026-10-11T12:00:00.000Z");
const botRow = (id: string, ownerId: string | null): Row => ({
	id, name: id, snippet: "", color: "#fff", shape: "rond", description: null, openRouterModel: null,
	language: "pt-BR", pinned: false, pinOrder: null, sectionId: null, memberIds: [], conversationId: null,
	policyJson: null, ownerId, createdAt: NOW, updatedAt: NOW,
});

function setup() {
	const bots = [botRow("bot-a", "user-a"), botRow("bot-b", "user-b"), botRow("bot-legacy", null)];
	stubMethod(prisma.bot, "findMany", async ({ where }: { where?: Row }) => bots.filter((row) => matches(row, where)));
	stubMethod(prisma.bot, "findFirst", async ({ where }: { where?: Row }) => bots.find((row) => matches(row, where)) ?? null);
	stubMethod(prisma.bot, "update", async ({ where, data }: { where: Row; data: Row }) => {
		const row = bots.find((item) => matches(item, where));
		if (!row) throw Object.assign(new Error("not found"), { code: "P2025" });
		return Object.assign(row, data);
	});
	stubMethod(prisma.bot, "delete", async ({ where }: { where: Row }) => {
		const index = bots.findIndex((item) => matches(item, where));
		if (index < 0) throw Object.assign(new Error("not found"), { code: "P2025" });
		bots.splice(index, 1);
		return {};
	});
	stubMethod(prisma.conversationMessage, "findFirst", async () => null);
	stubMethod(prisma.conversation, "delete", async () => ({}));
	stubMethod(prisma.runDelivery, "findMany", async () => []);
	return bots;
}

function appFor(userId: string) {
	const app = new Hono();
	app.use("*", async (c, next) => {
		(c as unknown as { set: (k: string, v: unknown) => void }).set("session", { user: { id: userId } });
		await next();
	});
	app.route("/", createBotRoutes());
	return app;
}

const json = { "Content-Type": "application/json" };

test("GET /v1/bots: cada usuário lista só os próprios bots (legado sem dono não vaza)", async () => {
	setup();
	const a = (await (await appFor("user-a").request("/v1/bots")).json()) as { bots: Array<{ id: string }> };
	const b = (await (await appFor("user-b").request("/v1/bots")).json()) as { bots: Array<{ id: string }> };
	assert.deepEqual(a.bots.map((bot) => bot.id), ["bot-a"]);
	assert.deepEqual(b.bots.map((bot) => bot.id), ["bot-b"]);
});

test("PATCH /v1/bots/:id: usuário B recebe 404 no bot de A (e no legado); A edita o seu", async () => {
	const bots = setup();
	const patch = (app: ReturnType<typeof appFor>, id: string) =>
		app.request(`/v1/bots/${id}`, { method: "PATCH", headers: json, body: JSON.stringify({ name: "novo" }) });
	assert.equal((await patch(appFor("user-b"), "bot-a")).status, 404);
	assert.equal((await patch(appFor("user-b"), "bot-legacy")).status, 404);
	assert.equal(bots.find((row) => row.id === "bot-a")?.name, "bot-a");
	assert.equal((await patch(appFor("user-a"), "bot-a")).status, 200);
});

test("DELETE /v1/bots/:id: usuário B recebe 404 no bot de A (e no legado); A apaga o seu", async () => {
	const bots = setup();
	const del = (app: ReturnType<typeof appFor>, id: string) => app.request(`/v1/bots/${id}`, { method: "DELETE" });
	assert.equal((await del(appFor("user-b"), "bot-a")).status, 404);
	assert.equal((await del(appFor("user-b"), "bot-legacy")).status, 404);
	assert.equal(bots.length, 3);
	assert.equal((await del(appFor("user-a"), "bot-a")).status, 200);
	assert.equal(bots.length, 2);
});
