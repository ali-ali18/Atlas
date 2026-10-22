/** Rotina ligada a uma página: só páginas do mesmo usuário e bot (IDOR), sem apagadas, e o vínculo aparece no registro. */
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { prisma } from "./client.js";
import { FakeTable, installFakes } from "./testing/fake-tables.js";
import { assertPageUsable } from "./pages.js";
import { createRoutine, updateRoutine } from "./routines.js";

let pages: FakeTable;
let bots: FakeTable;
let installed: { restore: () => void };
const created: Array<Record<string, unknown>> = [];
const originals: Record<string, unknown> = {};

beforeEach(() => {
	created.length = 0;
	bots = new FakeTable([
		{ id: "bot-a", ownerId: "user-a", conversationId: null, openRouterModel: "m" },
		{ id: "bot-a2", ownerId: "user-a", conversationId: null, openRouterModel: "m" },
		{ id: "bot-b", ownerId: "user-b", conversationId: null, openRouterModel: "m" },
	]);
	pages = new FakeTable([
		{ id: "page-a", userId: "user-a", botId: "bot-a", deletedAt: null },
		{ id: "page-a-other-bot", userId: "user-a", botId: "bot-a2", deletedAt: null },
		{ id: "page-a-gone", userId: "user-a", botId: "bot-a", deletedAt: new Date() },
		{ id: "page-b", userId: "user-b", botId: "bot-b", deletedAt: null },
	]);
	installed = installFakes({ bot: bots, page: pages });
	const client = prisma as unknown as Record<string, Record<string, unknown>>;
	originals.routine = client.routine;
	client.routine = {
		create: async ({ data }: { data: Record<string, unknown> }) => {
			created.push(data);
			return { id: "r1", createdAt: new Date(), updatedAt: new Date(), lastRunAt: null, enabled: true, triggerType: "cron", timezone: "America/Sao_Paulo", model: "m", notify: "always", createdBy: "user", triggerJson: null, ...data };
		},
		findFirst: async () => ({ id: "r1", userId: "user-a", triggerType: "cron", triggerJson: null, schedule: "0 8 * * 1" }),
		update: async ({ data }: { data: Record<string, unknown> }) => {
			created.push(data);
			return { id: "r1", userId: "user-a", botId: "bot-a", createdAt: new Date(), updatedAt: new Date(), lastRunAt: null, enabled: true, triggerType: "cron", timezone: "America/Sao_Paulo", model: "m", notify: "always", createdBy: "user", triggerJson: null, name: "x", prompt: "y", schedule: "0 8 * * 1", pageId: "page-a" };
		},
	};
	client.routineRun = { ...(client.routineRun ?? {}), findFirst: async () => null };
});
afterEach(() => {
	installed.restore();
	(prisma as unknown as Record<string, unknown>).routine = originals.routine;
});

const base = { botId: "bot-a", name: "Painel", prompt: "refaça", triggerType: "cron" as const, schedule: "0 8 * * 1" };

test("assertPageUsable aceita a página do dono e recusa outro dono, outro bot, apagada e legado", async () => {
	assert.equal(await assertPageUsable("user-a", "bot-a", "page-a"), "page-a");
	await assert.rejects(() => assertPageUsable("user-b", "bot-a", "page-a"), /Página não encontrada/);
	await assert.rejects(() => assertPageUsable("user-a", "bot-a", "page-b"), /Página não encontrada/);
	await assert.rejects(() => assertPageUsable("user-a", "bot-a", "page-a-other-bot"), /Página não encontrada/);
	await assert.rejects(() => assertPageUsable("user-a", "bot-a", "page-a-gone"), /Página não encontrada/);
	await assert.rejects(() => assertPageUsable("default", "bot-a", "page-a"), /Página não encontrada/);
});

test("createRoutine grava o pageId da página do dono e devolve no registro", async () => {
	const { routine } = await createRoutine("user-a", { ...base, pageId: "page-a" });
	assert.equal(created[0]!.pageId, "page-a");
	assert.equal(routine.pageId, "page-a");
});

test("createRoutine sem pageId grava null", async () => {
	await createRoutine("user-a", base);
	assert.equal(created[0]!.pageId, null);
});

test("createRoutine recusa a página de outro usuário sem criar a rotina", async () => {
	await assert.rejects(() => createRoutine("user-a", { ...base, pageId: "page-b" }), /Página não encontrada/);
	await assert.rejects(() => createRoutine("user-b", { ...base, botId: "bot-b", pageId: "page-a" }), /Página não encontrada/);
	await assert.rejects(() => createRoutine("user-a", { ...base, pageId: "page-a-other-bot" }), /Página não encontrada/);
	await assert.rejects(() => createRoutine("user-a", { ...base, pageId: "page-a-gone" }), /Página não encontrada/);
	assert.equal(created.length, 0);
});

test("updateRoutine liga a página do dono, desliga com null e recusa a de outro", async () => {
	await updateRoutine("user-a", "bot-a", "r1", { pageId: "page-a" });
	assert.deepEqual(created.at(-1)!.page, { connect: { id: "page-a" } });
	await updateRoutine("user-a", "bot-a", "r1", { pageId: null });
	assert.deepEqual(created.at(-1)!.page, { disconnect: true });
	const before = created.length;
	await assert.rejects(() => updateRoutine("user-a", "bot-a", "r1", { pageId: "page-b" }), /Página não encontrada/);
	assert.equal(created.length, before);
	await updateRoutine("user-a", "bot-a", "r1", { name: "outro" });
	assert.equal("page" in created.at(-1)!, false, "omitido mantém o vínculo");
});
