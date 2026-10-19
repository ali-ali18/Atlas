/**
 * Guia do conector: rotas de leitura/edição/geração/sugestões, escopadas por dono.
 * Dublê em memória dos delegates do prisma; nada toca banco, rede ou fila real.
 *
 * Runner: `NODE_ENV=test ATLAS_HOOK_PEPPER=test-pepper pnpm exec tsx --test src/routes/connector-guides.test.ts`
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { Hono } from "hono";

process.env.ATLAS_OWNER_EMAIL ||= "owner@example.com";
process.env.BETTER_AUTH_SECRET ||= "test-secret-long-enough-for-better-auth-middleware";
process.env.CONNECTOR_ENCRYPTION_KEY ||= randomBytes(32).toString("base64");

const { prisma } = await import("@workspace/db");
const { createConnectorGuideRoutes } = await import("./connector-guides.js");
const { setConnectorGuideEnqueuer } = await import("../connector-guide-queue.js");
const { CONNECTOR_GUIDE_MAX_CHARS } = await import("@workspace/shared");

type Row = Record<string, any>;

const A = "user-a-guia";
const B = "user-b-guia";

function stubable(obj: object, key: string): boolean {
	const descriptor = Object.getOwnPropertyDescriptor(obj, key);
	return Boolean(descriptor?.writable ?? descriptor?.configurable ?? true);
}
const SKIP = stubable(prisma.mcpConnection, "findFirst") && stubable(prisma.apiConnection, "findFirst") ? undefined : "exige delegates do prisma substituíveis";

function withDb(run: (rows: { mcp: Row[]; api: Row[] }) => Promise<void>) {
	return async () => {
		const rows = { mcp: [] as Row[], api: [] as Row[] };
		const originals: Array<[Record<string, unknown>, Record<string, unknown>]> = [];
		const install = (delegate: Record<string, unknown>, list: Row[]) => {
			originals.push([delegate, { findFirst: delegate.findFirst, updateMany: delegate.updateMany }]);
			const matches = (row: Row, where: Row) => Object.entries(where).every(([key, value]) => row[key] === value);
			delegate.findFirst = async ({ where }: { where: Row }) => list.find((row) => matches(row, where)) ?? null;
			delegate.updateMany = async ({ where, data }: { where: Row; data: Row }) => {
				const hit = list.filter((row) => matches(row, where));
				for (const row of hit) Object.assign(row, data);
				return { count: hit.length };
			};
		};
		install(prisma.mcpConnection as unknown as Record<string, unknown>, rows.mcp);
		install(prisma.apiConnection as unknown as Record<string, unknown>, rows.api);
		try {
			await run(rows);
		} finally {
			for (const [delegate, original] of originals) Object.assign(delegate, original);
			setConnectorGuideEnqueuer(null);
		}
	};
}

const row = (over: Row = {}): Row => ({
	id: "c1", userId: A, guideMd: null, guideSource: null, guideUpdatedAt: null, guideSuggestionsJson: null, ...over,
});

function appFor(userId: string) {
	const app = new Hono();
	app.use("*", async (c, next) => {
		c.set("session" as never, { user: { id: userId, email: "owner@example.com" } } as never);
		await next();
	});
	app.route("/", createConnectorGuideRoutes());
	return app;
}
const send = (app: Hono, path: string, method = "GET", body?: unknown) =>
	app.request(path, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

test("GET: dono lê; outro dono recebe 404; tipo inválido 400; sem guia = null", { skip: SKIP }, withDb(async (rows) => {
	rows.mcp.push(row({ guideMd: "- um", guideSource: "generated", guideUpdatedAt: new Date("2026-01-01T00:00:00Z") }));
	rows.api.push(row({ id: "a1" }));
	const ok = await send(appFor(A), "/v1/connectors/mcp/c1/guide");
	assert.equal(ok.status, 200);
	assert.deepEqual(((await ok.json()) as { guide: { text: string; source: string } }).guide.text, "- um");
	assert.equal((await send(appFor(B), "/v1/connectors/mcp/c1/guide")).status, 404);
	assert.equal((await send(appFor(A), "/v1/connectors/xyz/c1/guide")).status, 400);
	const empty = await send(appFor(A), "/v1/connectors/api/a1/guide");
	assert.equal(((await empty.json()) as { guide: unknown }).guide, null);
}));

test("PUT: salva como source=user, valida vazio e limite, só o dono", { skip: SKIP }, withDb(async (rows) => {
	rows.mcp.push(row({ guideMd: "- gerado", guideSource: "generated" }));
	const res = await send(appFor(A), "/v1/connectors/mcp/c1/guide", "PUT", { text: "- meu texto" });
	assert.equal(res.status, 200);
	assert.equal(rows.mcp[0]!.guideSource, "user");
	assert.equal(rows.mcp[0]!.guideMd, "- meu texto");
	assert.equal((await send(appFor(A), "/v1/connectors/mcp/c1/guide", "PUT", { text: "  " })).status, 400);
	assert.equal((await send(appFor(A), "/v1/connectors/mcp/c1/guide", "PUT", { text: "x".repeat(CONNECTOR_GUIDE_MAX_CHARS + 1) })).status, 400);
	assert.equal((await send(appFor(B), "/v1/connectors/mcp/c1/guide", "PUT", { text: "invasor" })).status, 404);
	assert.equal(rows.mcp[0]!.guideMd, "- meu texto");
}));

test("regenerate: guia editado exige confirmação (409); enfileira com force; sem fila 503", { skip: SKIP }, withDb(async (rows) => {
	rows.mcp.push(row({ guideMd: "- meu", guideSource: "user" }));
	const queued: Array<{ payload: Record<string, unknown>; jobId: string }> = [];
	setConnectorGuideEnqueuer(async (payload, jobId) => { queued.push({ payload: payload as unknown as Record<string, unknown>, jobId }); });
	const path = "/v1/connectors/mcp/c1/guide/regenerate";
	const refused = await send(appFor(A), path, "POST", {});
	assert.equal(refused.status, 409);
	assert.equal(((await refused.json()) as { code: string }).code, "confirm_required");
	assert.equal(queued.length, 0);
	assert.equal((await send(appFor(B), path, "POST", { confirm: true })).status, 404);
	const accepted = await send(appFor(A), path, "POST", { confirm: true });
	assert.equal(accepted.status, 202);
	assert.deepEqual(queued[0]!.payload, { kind: "mcp", connectionId: "c1", userId: A, force: true });
	setConnectorGuideEnqueuer(null);
	assert.equal((await send(appFor(A), path, "POST", { confirm: true })).status, 503);
}));

test("regenerate: guia gerado não pede confirmação", { skip: SKIP }, withDb(async (rows) => {
	rows.api.push(row({ id: "a1", guideMd: "- gerado", guideSource: "generated" }));
	let count = 0;
	setConnectorGuideEnqueuer(async () => { count += 1; });
	const res = await send(appFor(A), "/v1/connectors/api/a1/guide/regenerate", "POST");
	assert.equal(res.status, 202);
	assert.equal(count, 1);
}));

test("sugestões: aceitar acrescenta ao guia (vira user); descartar só remove; cheio = 409; inexistente = 404", { skip: SKIP }, withDb(async (rows) => {
	const suggestions = [
		{ id: "s1", text: "Use o id interno.", createdAt: "2026-01-01T00:00:00.000Z" },
		{ id: "s2", text: "Outra lição.", createdAt: "2026-01-01T00:00:00.000Z" },
	];
	rows.mcp.push(row({ guideMd: "- base", guideSource: "generated", guideSuggestionsJson: suggestions }));
	const accept = await send(appFor(A), "/v1/connectors/mcp/c1/guide/suggestions/s1/accept", "POST");
	assert.equal(accept.status, 200);
	assert.equal(rows.mcp[0]!.guideMd, "- base\n- Use o id interno.");
	assert.equal(rows.mcp[0]!.guideSource, "user");
	assert.equal(rows.mcp[0]!.guideSuggestionsJson.length, 1);
	const dismiss = await send(appFor(A), "/v1/connectors/mcp/c1/guide/suggestions/s2/dismiss", "POST");
	assert.equal(dismiss.status, 200);
	assert.equal(rows.mcp[0]!.guideSuggestionsJson.length, 0);
	assert.equal(rows.mcp[0]!.guideMd, "- base\n- Use o id interno.");
	assert.equal((await send(appFor(A), "/v1/connectors/mcp/c1/guide/suggestions/s2/accept", "POST")).status, 404);
	assert.equal((await send(appFor(B), "/v1/connectors/mcp/c1/guide/suggestions/s1/dismiss", "POST")).status, 404);

	rows.api.push(row({ id: "a1", guideMd: "a".repeat(CONNECTOR_GUIDE_MAX_CHARS - 5), guideSource: "user", guideSuggestionsJson: [{ id: "s9", text: "Lição que não cabe no limite.", createdAt: "2026-01-01T00:00:00.000Z" }] }));
	const full = await send(appFor(A), "/v1/connectors/api/a1/guide/suggestions/s9/accept", "POST");
	assert.equal(full.status, 409);
	assert.equal(rows.api[0]!.guideSuggestionsJson.length, 1, "sugestão fica pendente");
}));
