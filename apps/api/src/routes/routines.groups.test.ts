import assert from "node:assert/strict";
import { test } from "node:test";
process.env.ATLAS_OWNER_EMAIL ||= "owner@example.com";
process.env.BETTER_AUTH_SECRET ||=
	"test-secret-long-enough-for-better-auth-middleware";
const { parseCreateBody, parseUpdateBody } = await import("./routines.js");

type AuthEnv = import("../middleware/auth.js").AuthEnv;

async function appFor(userId: string) {
	const { Hono } = await import("hono");
	const { createRoutineRoutes } = await import("./routines.js");
	const app = new Hono<AuthEnv>();
	app.use("*", async (c, next) => {
		c.set("session", { user: { id: userId } } as AuthEnv["Variables"]["session"]);
		await next();
	});
	app.route("/", createRoutineRoutes(null));
	return app;
}

const json = (body: unknown) => ({
	method: "POST",
	headers: { "content-type": "application/json" },
	body: JSON.stringify(body),
});

function routineRow(userId: string, groupId: string | null) {
	return {
		id: "routine-b",
		userId,
		botId: "bot-b",
		conversationId: null,
		groupId,
		name: "Rotina",
		prompt: "Faça algo",
		model: "",
		allowChatgptPlan: false,
		enabled: true,
		triggerType: "cron",
		schedule: "0 9 * * *",
		timezone: "America/Sao_Paulo",
		triggerJson: null,
		createdBy: "user",
		lastRunAt: null,
		createdAt: new Date(0),
		updatedAt: new Date(0),
	};
}

test("groupId é aceito no create e no patch (null tira do grupo)", () => {
	const created = parseCreateBody("bot", {
		name: "T",
		prompt: "P",
		enabled: false,
		triggerType: "cron",
		schedule: null,
		groupId: " g1 ",
	});
	assert.ok(!("error" in created));
	assert.equal(created.groupId, "g1");
	assert.deepEqual(parseUpdateBody({ groupId: "g2" }), { groupId: "g2" });
	assert.deepEqual(parseUpdateBody({ groupId: null }), { groupId: null });
	assert.ok("error" in parseUpdateBody({ groupId: 3 }));
	assert.ok("error" in parseUpdateBody({ groupId: "  " }));
});

test("lista de grupos é filtrada pelo usuário da sessão", async () => {
	const { prisma } = await import("@workspace/db");
	const original = prisma.routineGroup.findMany;
	let seen: Record<string, unknown> | undefined;
	Reflect.set(prisma.routineGroup, "findMany", async ({ where }: { where: Record<string, unknown> }) => {
		seen = where;
		return [
			{
				id: "g1",
				botId: "bot-b",
				name: "Vendas",
				description: "",
				createdAt: new Date(0),
				updatedAt: new Date(0),
				routines: [{ enabled: true }, { enabled: false }],
			},
		];
	});
	try {
		const app = await appFor("b");
		const res = await app.request("/v1/bots/bot-b/routine-groups");
		assert.equal(res.status, 200);
		const body = (await res.json()) as { groups: Array<{ routineCount: number; enabledCount: number }> };
		assert.deepEqual(seen, { botId: "bot-b", userId: { in: ["b"] } });
		assert.equal(body.groups[0]?.routineCount, 2);
		assert.equal(body.groups[0]?.enabledCount, 1);
	} finally {
		prisma.routineGroup.findMany = original;
	}
});

test("B não move rotina para grupo de A (404) e nada é gravado", async () => {
	const { prisma } = await import("@workspace/db");
	const routineFind = prisma.routine.findFirst;
	const routineUpdate = prisma.routine.update;
	const groupFind = prisma.routineGroup.findFirst;
	let updated = false;
	Reflect.set(prisma.routine, "findFirst", async () => routineRow("b", null));
	Reflect.set(prisma.routineRun, "findFirst", async () => null);
	Reflect.set(prisma.routine, "update", async () => {
		updated = true;
		return routineRow("b", "group-a");
	});
	Reflect.set(prisma.routineGroup, "findFirst", async ({ where }: { where: Record<string, unknown> }) => {
		assert.deepEqual(where.userId, { in: ["b"] });
		return null; // o grupo-a pertence a A: não casa com userId=b
	});
	try {
		const app = await appFor("b");
		const res = await app.request("/v1/bots/bot-b/routines/routine-b", {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ groupId: "group-a" }),
		});
		assert.equal(res.status, 404);
		assert.equal(updated, false);
	} finally {
		prisma.routine.findFirst = routineFind;
		prisma.routine.update = routineUpdate;
		prisma.routineGroup.findFirst = groupFind;
	}
});

test("mover rotina para grupo do próprio usuário conecta o grupo", async () => {
	const { prisma } = await import("@workspace/db");
	const routineFind = prisma.routine.findFirst;
	const routineUpdate = prisma.routine.update;
	const groupFind = prisma.routineGroup.findFirst;
	let data: Record<string, unknown> | undefined;
	Reflect.set(prisma.routine, "findFirst", async () => routineRow("b", null));
	Reflect.set(prisma.routineRun, "findFirst", async () => null);
	Reflect.set(prisma.routine, "update", async (args: { data: Record<string, unknown> }) => {
		data = args.data;
		return routineRow("b", "group-b");
	});
	Reflect.set(prisma.routineGroup, "findFirst", async () => ({ id: "group-b" }));
	try {
		const app = await appFor("b");
		const res = await app.request("/v1/bots/bot-b/routines/routine-b", {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ groupId: "group-b" }),
		});
		assert.equal(res.status, 200);
		assert.deepEqual(data?.group, { connect: { id: "group-b" } });
	} finally {
		prisma.routine.findFirst = routineFind;
		prisma.routine.update = routineUpdate;
		prisma.routineGroup.findFirst = groupFind;
	}
});

test("B recebe 404 ao renomear, pausar ou apagar grupo de A", async () => {
	const { prisma } = await import("@workspace/db");
	const groupFind = prisma.routineGroup.findFirst;
	const groupDelete = prisma.routineGroup.deleteMany;
	const routineDelete = prisma.routine.deleteMany;
	let deleted = false;
	Reflect.set(prisma.routineGroup, "findFirst", async ({ where }: { where: Record<string, unknown> }) => {
		assert.equal(where.userId, "b");
		return null;
	});
	Reflect.set(prisma.routineGroup, "deleteMany", async () => {
		deleted = true;
		return { count: 1 };
	});
	Reflect.set(prisma.routine, "deleteMany", async () => {
		deleted = true;
		return { count: 1 };
	});
	try {
		const app = await appFor("b");
		const rename = await app.request("/v1/bots/bot-a/routine-groups/group-a", {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ name: "Novo" }),
		});
		assert.equal(rename.status, 404);
		const pause = await app.request("/v1/bots/bot-a/routine-groups/group-a/enabled", json({ enabled: false }));
		assert.equal(pause.status, 404);
		const del = await app.request("/v1/bots/bot-a/routine-groups/group-a?deleteRoutines=true", { method: "DELETE" });
		assert.equal(del.status, 404);
		assert.equal(deleted, false);
	} finally {
		prisma.routineGroup.findFirst = groupFind;
		prisma.routineGroup.deleteMany = groupDelete;
		prisma.routine.deleteMany = routineDelete;
	}
});

test("apagar grupo mantém as rotinas por padrão e as apaga com deleteRoutines", async () => {
	const { prisma } = await import("@workspace/db");
	const groupFind = prisma.routineGroup.findFirst;
	const groupDelete = prisma.routineGroup.deleteMany;
	const routineDelete = prisma.routine.deleteMany;
	const routineMany = prisma.routine.findMany;
	let groupDeletes = 0;
	let routineDeletes = 0;
	Reflect.set(prisma.routineGroup, "findFirst", async () => ({ id: "group-b" }));
	Reflect.set(prisma.routineGroup, "deleteMany", async () => {
		groupDeletes += 1;
		return { count: 1 };
	});
	Reflect.set(prisma.routine, "deleteMany", async () => {
		routineDeletes += 1;
		return { count: 1 };
	});
	Reflect.set(prisma.routine, "findMany", async () => [
		{ ...routineRow("b", "group-b"), runs: [], group: { id: "group-b", name: "Vendas" } },
	]);
	try {
		const app = await appFor("b");
		const keep = await app.request("/v1/bots/bot-b/routine-groups/group-b", { method: "DELETE" });
		assert.equal(keep.status, 200);
		assert.deepEqual(await keep.json(), { ok: true, deletedRoutines: 0 });
		assert.equal(groupDeletes, 1);
		assert.equal(routineDeletes, 0);
		const all = await app.request("/v1/bots/bot-b/routine-groups/group-b?deleteRoutines=true", { method: "DELETE" });
		assert.equal(all.status, 200);
		assert.deepEqual(await all.json(), { ok: true, deletedRoutines: 1 });
		assert.equal(groupDeletes, 2);
		assert.equal(routineDeletes, 1);
	} finally {
		prisma.routineGroup.findFirst = groupFind;
		prisma.routineGroup.deleteMany = groupDelete;
		prisma.routine.deleteMany = routineDelete;
		prisma.routine.findMany = routineMany;
	}
});

test("criar grupo exige bot do usuário e recusa nome repetido (sem caixa/espaços)", async () => {
	const { prisma } = await import("@workspace/db");
	const botFind = prisma.bot.findFirst;
	const groupMany = prisma.routineGroup.findMany;
	const groupCreate = prisma.routineGroup.create;
	let created = 0;
	Reflect.set(prisma.bot, "findFirst", async ({ where }: { where: Record<string, unknown> }) =>
		where.ownerId === "b" && where.id === "bot-b" ? { id: "bot-b" } : null,
	);
	Reflect.set(prisma.routineGroup, "findMany", async () => [
		{ id: "g1", botId: "bot-b", name: "Relatório  Diário", description: "", createdAt: new Date(0), updatedAt: new Date(0), routines: [] },
	]);
	Reflect.set(prisma.routineGroup, "create", async ({ data }: { data: Record<string, unknown> }) => {
		created += 1;
		return { id: "g2", createdAt: new Date(0), updatedAt: new Date(0), ...data };
	});
	try {
		const app = await appFor("b");
		const other = await app.request("/v1/bots/bot-a/routine-groups", json({ name: "X" }));
		assert.equal(other.status, 404);
		const dup = await app.request("/v1/bots/bot-b/routine-groups", json({ name: " relatório diário " }));
		assert.equal(dup.status, 409);
		const ok = await app.request("/v1/bots/bot-b/routine-groups", json({ name: "Outro", description: "d" }));
		assert.equal(ok.status, 201);
		assert.equal(created, 1);
	} finally {
		prisma.bot.findFirst = botFind;
		prisma.routineGroup.findMany = groupMany;
		prisma.routineGroup.create = groupCreate;
	}
});
