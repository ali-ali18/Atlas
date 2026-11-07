/**
 * Caderno ponta a ponta contra Postgres real: rotas com o db de verdade, dois usuários e o desfazer (F5.1/F5.3).
 * Pulado sem ATLAS_TEST_DB_URL (e DATABASE_URL igual, nome do banco com "test").
 * Runner: ATLAS_TEST_DB_URL=... DATABASE_URL=... NODE_ENV=test ATLAS_HOOK_PEPPER=test-pepper pnpm exec tsx --test src/routes/notes.db.test.ts
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";
import { Hono } from "hono";

process.env.ATLAS_OWNER_EMAIL ||= "owner@example.com";
process.env.BETTER_AUTH_SECRET ||= "test-secret-long-enough-for-better-auth-middleware";

const url = process.env.ATLAS_TEST_DB_URL?.trim() ?? "";
const skip = !url || !/test/i.test(new URL(url).pathname) || process.env.DATABASE_URL !== url ? "banco de teste ausente (ATLAS_TEST_DB_URL = DATABASE_URL, nome com 'test')" : false;

const { prisma, addMemoryEntry } = await import("@workspace/db");
const { createNoteRoutes } = await import("./notes.js");
const { createMemoryRoutes } = await import("./memory.js");
const { createSleepRoutes } = await import("./sleep.js");
const { createBotRuleRoutes } = await import("./bot-rules.js");

type Env = import("../middleware/auth.js").AuthEnv;

function appFor(userId: string) {
	const app = new Hono<Env>();
	app.use("*", async (c, next) => {
		c.set("session", { user: { id: userId } } as Env["Variables"]["session"]);
		await next();
	});
	app.route("/", createNoteRoutes());
	app.route("/", createMemoryRoutes());
	app.route("/", createSleepRoutes());
	app.route("/", createBotRuleRoutes());
	return app;
}
const send = (method: string, body?: unknown) => ({ method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const json = async (response: Response) => (await response.json()) as Record<string, any>;

describe("caderno, sono e regras pelas rotas (Postgres real)", { skip }, () => {
	const a = `api-a-${randomUUID()}`;
	const b = `api-b-${randomUUID()}`;
	let botA: string;

	before(async () => {
		for (const id of [a, b]) await prisma.user.create({ data: { id, name: id, email: `${id}@test.local` } });
		botA = (await prisma.bot.create({ data: { ownerId: a, name: "A", policyJson: { rules: [{ match: "gmail_send", effect: "send", verdict: "approve" }] } }, select: { id: true } })).id;
	});
	after(async () => {
		await prisma.$disconnect();
	});

	test("A cria; B não vê, lê, edita, fixa, apaga nem desfaz; A edita e desfaz", async () => {
		const appA = appFor(a);
		const appB = appFor(b);
		const created = await json(await appA.request("/v1/notes", send("POST", { title: "Segredo do A", body: "conteúdo privado do A", botId: botA })));
		const id = created.note.id as string;
		assert.equal(created.note.source, "owner");

		assert.deepEqual((await json(await appB.request("/v1/notes"))).notes, []);
		for (const [method, body] of [["GET"], ["PATCH", { body: "invadido" }], ["PATCH", { pinned: true }], ["DELETE"]] as const) assert.equal((await appB.request(`/v1/notes/${id}`, send(method, body))).status, 404, method);
		assert.equal((await appB.request("/v1/notes", send("POST", { title: "x", body: "y", botId: botA }))).status, 404);
		assert.equal((await appB.request(`/v1/notes?botId=${botA}`)).status, 404);

		const edited = await appA.request(`/v1/notes/${id}`, send("PATCH", { body: "texto novo", pinned: true }));
		assert.equal(edited.status, 200);
		const changes = await json(await appA.request(`/v1/notes/changes?botId=${botA}`));
		const editChange = changes.changes.find((c: any) => c.action === "replace");
		assert.deepEqual([editChange.target, editChange.before, editChange.after, editChange.afterNote], ["note", "conteúdo privado do A", "texto novo", { title: "Segredo do A", pinned: true }]);

		assert.equal((await appB.request(`/v1/memory/changes/${editChange.id}/undo`, send("POST"))).status, 404);
		assert.equal((await json(await appA.request(`/v1/notes/${id}`))).note.body, "texto novo");
		const undone = await appA.request(`/v1/memory/changes/${editChange.id}/undo`, send("POST"));
		assert.equal(undone.status, 200);
		assert.deepEqual([(await json(await appA.request(`/v1/notes/${id}`))).note.body, (await json(await appA.request(`/v1/notes/${id}`))).note.pinned], ["conteúdo privado do A", false]);
		assert.equal((await appA.request(`/v1/memory/changes/${editChange.id}/undo`, send("POST"))).status, 409);
		assert.equal((await appB.request("/v1/notes/changes")).status, 200);
		assert.deepEqual((await json(await appB.request("/v1/notes/changes"))).changes, []);
	});

	test("mudanças do sono: só o dono vê e desfaz (fato de memória e nota)", async () => {
		const appA = appFor(a);
		const appB = appFor(b);
		const fact = await addMemoryEntry({ userId: a, botId: botA, target: "memory", content: "usa Linux", source: "sleep", origin: "sleep", reportId: "rep-1" });
		assert.ok(fact.ok);
		const page = await json(await appA.request(`/v1/sleep/changes?botId=${botA}&reportId=rep-1`));
		assert.equal(page.changes.length, 1);
		assert.deepEqual((await json(await appB.request("/v1/sleep/changes"))).changes, []);
		assert.equal((await appB.request(`/v1/memory/changes/${page.changes[0].id}/undo`, send("POST"))).status, 404);
		assert.equal((await appA.request(`/v1/memory/changes/${page.changes[0].id}/undo`, send("POST"))).status, 200);
		assert.equal(await prisma.memoryEntry.count({ where: { userId: a, content: "usa Linux" } }), 0);
	});

	test("regras do bot: A edita e apaga; B recebe 404", async () => {
		const appA = appFor(a);
		const appB = appFor(b);
		const listed = await json(await appA.request(`/v1/bots/${botA}/rules`));
		const ruleId = listed.rules[0].id as string;
		assert.equal((await appB.request(`/v1/bots/${botA}/rules`)).status, 404);
		assert.equal((await appB.request(`/v1/bots/${botA}/rules/${ruleId}`, send("PATCH", { verdict: "run" }))).status, 404);
		assert.equal((await appB.request(`/v1/bots/${botA}/rules/${ruleId}`, send("DELETE"))).status, 404);
		assert.equal((await json(await appA.request(`/v1/bots/${botA}/rules/${ruleId}`, send("PATCH", { verdict: "deny" })))).rule.verdict, "deny");
		assert.equal((await appA.request(`/v1/bots/${botA}/rules/${ruleId}`, send("DELETE"))).status, 200);
		assert.deepEqual((await json(await appA.request(`/v1/bots/${botA}/rules`))).rules, []);
	});
});
