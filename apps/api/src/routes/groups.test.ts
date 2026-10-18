import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";

process.env.ATLAS_OWNER_EMAIL ||= "owner@example.com";
process.env.BETTER_AUTH_SECRET ||= "test-secret-long-enough-for-better-auth-middleware";

const { GroupError, prisma } = await import("@workspace/db");
const { Hono } = await import("hono");
const { createGroupRoutes, parseCreateGroup } = await import("./groups.js");
const { createBotRoutes } = await import("./bots.js");
const { resolveGroupRunTarget } = await import("../chat/group-run.js");

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

const json = { "Content-Type": "application/json" };

function appFor(userId: string, deps: Parameters<typeof createGroupRoutes>[0] = {}) {
	const app = new Hono();
	app.use("*", async (c, next) => {
		(c as unknown as { set: (k: string, v: unknown) => void }).set("session", { user: { id: userId } });
		await next();
	});
	app.route("/", createGroupRoutes(deps));
	app.route("/", createBotRoutes());
	return app;
}

const call = (app: ReturnType<typeof appFor>, method: string, path: string, body?: unknown) =>
	app.request(path, { method, headers: json, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

test("parseCreateGroup exige nome e lista de membros e filtra forma inválida", () => {
	assert.equal(parseCreateGroup(null), null);
	assert.equal(parseCreateGroup({ name: "  ", memberIds: ["a", "b"] }), null);
	assert.equal(parseCreateGroup({ name: "Time" }), null);
	assert.deepEqual(parseCreateGroup({ name: " Time ", memberIds: ["a", "b"], color: " #fff ", shape: "nao-existe" }), {
		name: "Time",
		memberIds: ["a", "b"],
		color: "#fff",
	});
});

test("POST /v1/groups cria com o userId da sessão e devolve 201", async () => {
	let seen: { userId: string; name: string } | null = null;
	const app = appFor("user-a", {
		createGroup: (async (userId: string, input: { name: string }) => {
			seen = { userId, name: input.name };
			return { id: "g1", name: input.name, memberIds: ["a", "b"] };
		}) as never,
	});
	const res = await call(app, "POST", "/v1/groups", { name: "Time", memberIds: ["a", "b"] });
	assert.equal(res.status, 201);
	assert.deepEqual(seen, { userId: "user-a", name: "Time" });
	assert.equal((await call(app, "POST", "/v1/groups", { name: "Time" })).status, 400);
});

test("erros de domínio viram 400/404/429; falha inesperada vira 503", async () => {
	const failing = (error: unknown) => appFor("user-a", { postGroupUserMessage: (async () => { throw error; }) as never });
	assert.equal((await call(failing(new GroupError("x")), "POST", "/v1/groups/g/messages", { content: "oi" })).status, 400);
	assert.equal((await call(failing(new GroupError("x", "not_found")), "POST", "/v1/groups/g/messages", { content: "oi" })).status, 404);
	assert.equal((await call(failing(new GroupError("x", "busy")), "POST", "/v1/groups/g/messages", { content: "oi" })).status, 429);
	const silent = mock.method(console, "error", () => undefined);
	assert.equal((await call(failing(new Error("boom")), "POST", "/v1/groups/g/messages", { content: "oi" })).status, 503);
	silent.mock.restore();
	assert.equal((await call(appFor("user-a"), "POST", "/v1/groups/g/messages", { text: "oi" })).status, 400);
});

test("membros: adicionar, remover e trocar usam o dono da sessão", async () => {
	const seen: string[] = [];
	const app = appFor("user-a", {
		addGroupMember: (async (u: string, g: string, b: string) => (seen.push(`add:${u}:${g}:${b}`), { id: g })) as never,
		removeGroupMember: (async (u: string, g: string, b: string) => (seen.push(`rm:${u}:${g}:${b}`), { id: g })) as never,
		setGroupMembers: (async (u: string, g: string, ids: string[]) => (seen.push(`set:${u}:${g}:${ids.join(",")}`), { id: g })) as never,
	});
	assert.equal((await call(app, "POST", "/v1/groups/g/members", { botId: "c" })).status, 201);
	assert.equal((await call(app, "DELETE", "/v1/groups/g/members/c")).status, 200);
	assert.equal((await call(app, "PUT", "/v1/groups/g/members", { memberIds: ["a", "b"] })).status, 200);
	assert.equal((await call(app, "POST", "/v1/groups/g/members", {})).status, 400);
	assert.equal((await call(app, "PUT", "/v1/groups/g/members", { memberIds: "a" })).status, 400);
	assert.deepEqual(seen, ["add:user-a:g:c", "rm:user-a:g:c", "set:user-a:g:a,b"]);
});

test("GET /v1/groups/:id/state: 404 quando não é grupo do usuário", async () => {
	const app = appFor("user-a", { getGroupState: (async (u: string) => (u === "user-a" ? { routing: false, replies: [] } : null)) as never });
	const ok = await call(app, "GET", "/v1/groups/g/state");
	assert.deepEqual(await ok.json(), { routing: false, replies: [] });
	assert.equal((await call(appFor("user-b", { getGroupState: (async () => null) as never }), "GET", "/v1/groups/g/state")).status, 404);
});

test("PATCH /v1/bots/:id memberIds: só em grupo, só bots do dono; bot comum recebe 400", async () => {
	const rows: Array<Record<string, unknown>> = [
		{ id: "ana", ownerId: "user-a", memberIds: [] },
		{ id: "bia", ownerId: "user-a", memberIds: [] },
		{ id: "time", ownerId: "user-a", memberIds: ["ana", "bia"] },
		{ id: "outro", ownerId: "user-a", memberIds: ["ana", "bia"] },
	];
	stubMethod(prisma.bot, "findFirst", async ({ where }: { where: Record<string, unknown> }) => rows.find((row) => row.id === where.id && row.ownerId === where.ownerId) ?? null);
	stubMethod(prisma.bot, "findMany", async ({ where }: { where: { id: { in: string[] }; ownerId: { in: string[] } } }) =>
		rows.filter((row) => where.id.in.includes(row.id as string) && where.ownerId.in.includes(row.ownerId as string) && (row.memberIds as string[]).length === 0),
	);
	const app = appFor("user-a");
	assert.equal((await call(app, "PATCH", "/v1/bots/ana", { memberIds: ["bia", "time"] })).status, 400);
	assert.equal((await call(app, "PATCH", "/v1/bots/time", { memberIds: ["ana", "outro"] })).status, 404, "grupo não pode ser membro");
	assert.equal((await call(app, "PATCH", "/v1/bots/time", { memberIds: ["ana"] })).status, 400, "mínimo de 2");
	assert.equal((await call(app, "PATCH", "/v1/bots/time", { isPrimary: true })).status, 400, "grupo não é bot principal");
});

test("POST /v1/runs com botId de grupo: só clique de confirmação passa, e vira run do membro dono do pedido", async () => {
	const members = [{ id: "ana", name: "Ana" }, { id: "bia", name: "Bia" }];
	const group = (async () => ({ group: { id: "time", name: "Time", conversationId: "c-time", memberIds: ["ana", "bia"] }, members })) as never;
	const pending = (owner?: string) => (async () => (owner ? { payload: { botId: owner } } : null)) as never;
	const msg = (content: string) => ({ botId: "time", messages: [{ role: "user", content }] });

	assert.deepEqual(await resolveGroupRunTarget({ messages: [] }, "u"), { kind: "pass" });
	assert.deepEqual(await resolveGroupRunTarget({ botId: "ana", messages: [] }, "u", { group: (async () => null) as never }), { kind: "pass" });
	assert.equal((await resolveGroupRunTarget(msg("oi pessoal"), "u", { group, pending: pending("bia") })).kind, "reject");
	assert.deepEqual(await resolveGroupRunTarget(msg("confirmado: enviar e-mail"), "u", { group, pending: pending("bia") }), {
		kind: "member",
		botId: "bia",
		conversationId: "c-time",
	});
	assert.equal((await resolveGroupRunTarget(msg("cancela isso"), "u", { group, pending: pending("ana") })).kind, "member");
	assert.equal((await resolveGroupRunTarget(msg("confirmado: x"), "u", { group, pending: pending() })).kind, "reject", "nada pendente");
	assert.equal((await resolveGroupRunTarget(msg("confirmado: x"), "u", { group, pending: pending("intruso") })).kind, "reject", "dono do pedido precisa ser membro");
});
