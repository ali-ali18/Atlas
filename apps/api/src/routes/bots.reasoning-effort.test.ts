import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";

process.env.ATLAS_HOOK_PEPPER ??= "test-pepper-for-reasoning-effort";
process.env.ATLAS_OWNER_EMAIL ??= "owner@example.com";
process.env.BETTER_AUTH_SECRET ??= "test-secret-for-reasoning-effort-routes";

const { prisma } = await import("@workspace/db");
const { Hono } = await import("hono");
const { createBotRoutes, checkReasoningEffortPolicy } = await import("./bots.js");

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
const NOW = new Date("2026-10-11T12:00:00.000Z");
const botA: Row = {
	id: "bot-a", name: "A", snippet: "", color: "#fff", shape: "rond", description: null, openRouterModel: null,
	language: "pt-BR", pinned: false, pinOrder: null, sectionId: null, memberIds: [], conversationId: null,
	policyJson: { engine: "v2" }, ownerId: "user-a", createdAt: NOW, updatedAt: NOW, isPrimary: false,
};

function setup() {
	const row: Row = { ...botA };
	stubMethod(prisma.bot, "findFirst", async ({ where }: { where: Row }) => (where.ownerId === row.ownerId && where.id === row.id ? row : null));
	const tx = {
		$queryRaw: async () => [{ policyJson: row.policyJson }],
		bot: {
			updateMany: async () => ({ count: 0 }),
			update: async ({ data }: { data: Row }) => Object.assign(row, data),
		},
	};
	stubMethod(prisma, "$transaction", async (callback: (tx: unknown) => unknown) => callback(tx));
	stubMethod(prisma.conversationMessage, "findFirst", async () => null);
	return row;
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
const patch = (app: ReturnType<typeof appFor>, policyJson: unknown) =>
	app.request("/v1/bots/bot-a", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ policyJson }) });

test("checkReasoningEffortPolicy: aceita os quatro níveis, null e ausência; recusa o resto", () => {
	for (const level of ["off", "low", "medium", "high"]) assert.equal(checkReasoningEffortPolicy({ reasoningEffort: level }), null);
	assert.equal(checkReasoningEffortPolicy({ reasoningEffort: null }), null);
	assert.equal(checkReasoningEffortPolicy({ engine: "v2" }), null);
	assert.equal(checkReasoningEffortPolicy(null), null);
	for (const bad of ["max", "", "LOW", 2, true, {}]) assert.match(checkReasoningEffortPolicy({ reasoningEffort: bad }) ?? "", /reasoningEffort/);
});

test("PATCH /v1/bots/:id grava o padrão de raciocínio do bot na política", async () => {
	const row = setup();
	const response = await patch(appFor("user-a"), { engine: "v2", reasoningEffort: "low" });
	assert.equal(response.status, 200);
	assert.deepEqual(row.policyJson, { engine: "v2", reasoningEffort: "low" });
});

test("PATCH /v1/bots/:id recusa nível inválido sem gravar", async () => {
	const row = setup();
	const response = await patch(appFor("user-a"), { reasoningEffort: "extreme" });
	assert.equal(response.status, 400);
	assert.deepEqual(row.policyJson, { engine: "v2" });
});

test("usuário B não altera o raciocínio do bot de A (404, nada gravado)", async () => {
	const row = setup();
	const response = await patch(appFor("user-b"), { reasoningEffort: "high" });
	assert.equal(response.status, 404);
	assert.deepEqual(row.policyJson, { engine: "v2" });
});
