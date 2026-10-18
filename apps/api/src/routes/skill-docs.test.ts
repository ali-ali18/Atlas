/**
 * Rotas /v1/skills (PLANO-SKILLS K0): caminho feliz, validação, import/export e
 * isolamento entre donos. Prisma em memória (FakeTable do db), sem banco.
 * Runner: `NODE_ENV=test ATLAS_HOOK_PEPPER=test-pepper pnpm exec tsx --test src/routes/skill-docs.test.ts`.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { Hono } from "hono";
import type { AuthEnv } from "../middleware/auth.js";

process.env.ATLAS_OWNER_EMAIL ||= "owner@example.com";
process.env.BETTER_AUTH_SECRET ||= "test-secret-long-enough-for-better-auth-middleware";
process.env.ATLAS_HOOK_PEPPER ||= "test-pepper";

const { FakeTable, installFakes } = await import("@workspace/db/testing");
const { createSkillDocRoutes } = await import("./skill-docs.js");

const USER_A = "user-a-ficticio";
const USER_B = "user-b-ficticio";

let installed: { restore: () => void };
let docs: InstanceType<typeof FakeTable>;

beforeEach(() => {
	docs = new FakeTable([], () => ({
		createdAt: new Date(),
		updatedAt: new Date(),
		revision: 1,
		enabled: true,
		status: "active",
		createdBy: "user",
		tools: [],
		botId: null,
	}));
	installed = installFakes({
		skillDoc: docs,
		skillRevision: new FakeTable(),
		bot: new FakeTable([
			{ id: "bot-a", ownerId: USER_A },
			{ id: "bot-b", ownerId: USER_B },
		]),
	});
});
afterEach(() => installed.restore());

function appFor(userId: string) {
	const outer = new Hono<AuthEnv>();
	outer.use("*", async (c, next) => {
		c.set("session", { user: { id: userId } } as AuthEnv["Variables"]["session"]);
		await next();
	});
	outer.route("/", createSkillDocRoutes());
	return outer;
}

const json = (method: string, body: unknown) => ({
	method,
	headers: { "Content-Type": "application/json" },
	body: JSON.stringify(body),
});
const markdown = (name: string, body = "1. passo") => `---\nname: ${name}\ndescription: Quando usar ${name}\ntools: [github]\n---\n${body}`;

async function createAs(userId: string, name: string, extra: object = {}) {
	const res = await appFor(userId).request("/v1/skills", json("POST", { name, description: `usar ${name}`, body: "passo a passo", ...extra }));
	assert.equal(res.status, 201);
	return ((await res.json()) as { skill: { id: string } }).skill;
}

test("cria por campos, lê, lista (sem corpo) e apaga", async () => {
	const app = appFor(USER_A);
	const skill = await createAs(USER_A, "relatorio");
	const one = await app.request(`/v1/skills/${skill.id}`);
	assert.equal(one.status, 200);
	assert.equal(((await one.json()) as { skill: { body: string } }).skill.body, "passo a passo");
	const list = (await (await app.request("/v1/skills")).json()) as { skills: Array<Record<string, unknown>> };
	assert.equal(list.skills.length, 1);
	assert.ok(!("body" in list.skills[0]!));
	assert.equal((await app.request(`/v1/skills/${skill.id}`, { method: "DELETE" })).status, 200);
	assert.equal((await app.request(`/v1/skills/${skill.id}`)).status, 404);
});

test("cria por markdown (text/markdown) e filtra a lista por botId", async () => {
	const app = appFor(USER_A);
	const res = await app.request("/v1/skills?botId=bot-a", { method: "POST", headers: { "Content-Type": "text/markdown" }, body: markdown("do-bot") });
	assert.equal(res.status, 201);
	await createAs(USER_A, "da-conta");
	const onlyBot = (await (await app.request("/v1/skills?botId=bot-a")).json()) as { skills: Array<{ name: string }> };
	assert.deepEqual(onlyBot.skills.map((s) => s.name), ["do-bot"]);
	const all = (await (await app.request("/v1/skills")).json()) as { skills: unknown[] };
	assert.equal(all.skills.length, 2);
});

test("B não lê, lista, altera, desliga, exporta nem apaga a skill de A (404)", async () => {
	const skill = await createAs(USER_A, "privada");
	const b = appFor(USER_B);
	assert.equal((await b.request(`/v1/skills/${skill.id}`)).status, 404);
	assert.equal((await b.request(`/v1/skills/${skill.id}/export`)).status, 404);
	assert.equal((await b.request(`/v1/skills/${skill.id}`, json("PUT", { body: "invadido" }))).status, 404);
	assert.equal((await b.request(`/v1/skills/${skill.id}`, json("PUT", { enabled: false }))).status, 404);
	assert.equal((await b.request(`/v1/skills/${skill.id}`, { method: "DELETE" })).status, 404);
	assert.deepEqual(((await (await b.request("/v1/skills")).json()) as { skills: unknown[] }).skills, []);
	const mine = (await (await appFor(USER_A).request(`/v1/skills/${skill.id}`)).json()) as { skill: { body: string; enabled: boolean } };
	assert.equal(mine.skill.body, "passo a passo");
	assert.equal(mine.skill.enabled, true);
});

test("userId vindo do body é ignorado e bot de outro dono dá 404", async () => {
	const res = await appFor(USER_B).request("/v1/skills", json("POST", { name: "x", description: "d", body: "b", userId: USER_A, ownerId: USER_A }));
	assert.equal(res.status, 201);
	assert.equal(docs.rows[0]?.userId, USER_B);
	const other = await appFor(USER_B).request("/v1/skills", json("POST", { name: "y", description: "d", body: "b", botId: "bot-a" }));
	assert.equal(other.status, 404);
});

test("valida corpo: slug, descrição, JSON inválido, markdown inválido e tamanho", async () => {
	const app = appFor(USER_A);
	const bad = await app.request("/v1/skills", json("POST", { name: "Nome Ruim", description: "d", body: "b" }));
	assert.equal(bad.status, 400);
	assert.match(((await bad.json()) as { error: string }).error, /slug/);
	assert.equal((await app.request("/v1/skills", json("POST", { name: "a", description: "x".repeat(301), body: "b" }))).status, 400);
	assert.equal((await app.request("/v1/skills", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{nope" })).status, 400);
	assert.equal((await app.request("/v1/skills", { method: "POST", headers: { "Content-Type": "text/markdown" }, body: "sem frontmatter" })).status, 400);
	const huge = await app.request("/v1/skills", { method: "POST", headers: { "Content-Type": "text/markdown" }, body: markdown("grande", "x".repeat(70_000)) });
	assert.equal(huge.status, 413);
	assert.equal(docs.rows.length, 0);
});

test("nome duplicado responde 409; revisão desatualizada no PUT responde 409", async () => {
	const app = appFor(USER_A);
	const skill = await createAs(USER_A, "dup");
	assert.equal((await app.request("/v1/skills", json("POST", { name: "dup", description: "d", body: "b" }))).status, 409);
	assert.equal((await app.request(`/v1/skills/${skill.id}`, json("PUT", { body: "v2", revision: 1 }))).status, 200);
	assert.equal((await app.request(`/v1/skills/${skill.id}`, json("PUT", { body: "v3", revision: 1 }))).status, 409);
});

test("PUT edita conteúdo e liga/desliga sem exigir os demais campos", async () => {
	const app = appFor(USER_A);
	const skill = await createAs(USER_A, "edita");
	const edited = (await (await app.request(`/v1/skills/${skill.id}`, json("PUT", { description: "nova descrição" }))).json()) as { skill: { description: string; revision: number; body: string } };
	assert.equal(edited.skill.description, "nova descrição");
	assert.equal(edited.skill.body, "passo a passo");
	assert.equal(edited.skill.revision, 2);
	const off = (await (await app.request(`/v1/skills/${skill.id}`, json("PUT", { enabled: false }))).json()) as { skill: { enabled: boolean; revision: number } };
	assert.equal(off.skill.enabled, false);
	assert.equal(off.skill.revision, 2);
	assert.equal((await app.request(`/v1/skills/${skill.id}`, json("PUT", {}))).status, 400);
});

test("segredo no corpo é redigido ao salvar", async () => {
	const token = `ghp_${"b".repeat(30)}`;
	const skill = await createAs(USER_A, "segredo", { body: `use ${token}` });
	const read = (await (await appFor(USER_A).request(`/v1/skills/${skill.id}`)).json()) as { skill: { body: string } };
	assert.ok(!read.skill.body.includes(token));
});

test("exporta .md saneado e reimporta como rascunho desligado", async () => {
	const app = appFor(USER_A);
	const skill = await createAs(USER_A, "exporta", { tools: ["github"] });
	const exported = await app.request(`/v1/skills/${skill.id}/export`);
	assert.equal(exported.status, 200);
	assert.match(exported.headers.get("Content-Type") ?? "", /^text\/markdown/);
	assert.match(exported.headers.get("Content-Disposition") ?? "", /filename="exporta\.md"/);
	const text = await exported.text();
	assert.match(text, /^---\nname: exporta\n/);

	await app.request(`/v1/skills/${skill.id}`, { method: "DELETE" });
	const imported = await app.request("/v1/skills/import", { method: "POST", headers: { "Content-Type": "text/markdown" }, body: text });
	assert.equal(imported.status, 201);
	const result = (await imported.json()) as { source: string; skill: { status: string; enabled: boolean; tools: string[] } };
	assert.equal(result.source, "imported");
	assert.equal(result.skill.status, "draft");
	assert.equal(result.skill.enabled, false);
	assert.deepEqual(result.skill.tools, ["github"]);
});

test("import por JSON { markdown } valida e rejeita documento inválido", async () => {
	const app = appFor(USER_A);
	assert.equal((await app.request("/v1/skills/import", json("POST", { markdown: markdown("via-json") }))).status, 201);
	const bad = await app.request("/v1/skills/import", json("POST", { markdown: "---\nname: a\ntriggers: x\n---\nb" }));
	assert.equal(bad.status, 400);
	assert.match(((await bad.json()) as { error: string }).error, /Chave desconhecida/);
});

test("apagar rascunhos em lote: só os do dono da sessão; B não apaga os de A", async () => {
	const a = appFor(USER_A);
	await createAs(USER_A, "ativa");
	const importDraft = async (name: string, query = "") =>
		a.request(`/v1/skills/import${query}`, { method: "POST", headers: { "Content-Type": "text/markdown" }, body: markdown(name) });
	assert.equal((await importDraft("rasc-conta")).status, 201);
	assert.equal((await importDraft("rasc-bot", "?botId=bot-a")).status, 201);

	const b = appFor(USER_B);
	const denied = await b.request("/v1/skills/delete-drafts?botId=bot-a", { method: "POST" });
	assert.equal(((await denied.json()) as { deleted: number }).deleted, 0);
	assert.equal(((await (await b.request("/v1/skills/delete-drafts", { method: "POST" })).json()) as { deleted: number }).deleted, 0);
	assert.equal(docs.rows.length, 3, "nada de A foi apagado por B");

	const scoped = await a.request("/v1/skills/delete-drafts?scope=account", { method: "POST" });
	assert.deepEqual(await scoped.json(), { ok: true, deleted: 1 });
	const rest = await a.request("/v1/skills/delete-drafts", { method: "POST" });
	assert.deepEqual(await rest.json(), { ok: true, deleted: 1 });
	assert.deepEqual(docs.rows.map((row) => row.name), ["ativa"]);
});
