/**
 * Várias contas do mesmo conector MCP (ex.: duas contas Notion).
 * Dublê em memória do delegate `prisma.mcpConnection`; nada toca banco ou rede.
 *
 * Runner: `NODE_ENV=test ATLAS_HOOK_PEPPER=test-pepper pnpm exec tsx --test src/routes/mcp-multi-account.test.ts`
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { Hono } from "hono";

process.env.ATLAS_OWNER_EMAIL ||= "owner@example.com";
process.env.BETTER_AUTH_SECRET ||= "test-secret-long-enough-for-better-auth-middleware";
process.env.CONNECTOR_ENCRYPTION_KEY ||= randomBytes(32).toString("base64");

const { prisma, createMcpConnection, listMcpConnectionsByCatalogId, listConnectedMcpConnections, getMcpConnection } = await import("@workspace/db");
const { createMcpRoutes, parseCreateMcpBody, parsePatchMcpBody } = await import("./mcp.js");
const { hashMcpOAuthState, sealSecrets, accountLabelFromTokens, isAutoAccountLabel } = await import("@workspace/agent-runtime");

type Row = Record<string, any>;

function stubable(obj: object, key: string): boolean {
	const descriptor = Object.getOwnPropertyDescriptor(obj, key);
	return Boolean(descriptor?.writable ?? descriptor?.configurable ?? true);
}
const CAN_STUB = ["findMany", "findFirst", "create", "update", "updateMany", "delete"].every((key) => stubable(prisma.mcpConnection, key));
const SKIP = CAN_STUB ? undefined : "exige delegates do prisma substituíveis";

const A = "user-a-multi";
const B = "user-b-multi";

/** Substitui o delegate por um banco em memória com filtros simples (userId/id/catalogId/slug/oauthStateHash/status). */
function withMemoryDb(run: (rows: Row[]) => Promise<void>) {
	return async () => {
		const rows: Row[] = [];
		let seq = 0;
		const delegate = prisma.mcpConnection as unknown as Record<string, unknown>;
		const original = Object.fromEntries(["findMany", "findFirst", "create", "update", "updateMany", "delete"].map((key) => [key, delegate[key]]));
		const matches = (row: Row, where: Row = {}): boolean =>
			Object.entries(where).every(([key, expected]) => {
				if (expected && typeof expected === "object" && "in" in (expected as object)) return ((expected as { in: unknown[] }).in).includes(row[key]);
				if (expected && typeof expected === "object" && "startsWith" in (expected as object)) return String(row[key]).startsWith((expected as { startsWith: string }).startsWith);
				if (expected && typeof expected === "object" && "not" in (expected as object)) return row[key] !== (expected as { not: unknown }).not;
				return row[key] === expected;
			});
		const sorted = (list: Row[]) => [...list].sort((x, y) => x.createdAt.getTime() - y.createdAt.getTime());
		delegate.findMany = async (args: { where?: Row; select?: Row } = {}) => sorted(rows.filter((row) => matches(row, args.where)));
		delegate.findFirst = async (args: { where?: Row } = {}) => sorted(rows.filter((row) => matches(row, args.where)))[0] ?? null;
		delegate.create = async ({ data }: { data: Row }) => {
			seq += 1;
			if (rows.some((row) => row.userId === data.userId && row.slug === data.slug)) throw Object.assign(new Error("unique"), { code: "P2002" });
			const row: Row = {
				id: `conn-${seq}`, toolsCacheJson: null, disabledTools: [], confirmWrites: true, lastError: null, oauthStateHash: null,
				secretsEnc: null, accountLabel: null, createdAt: new Date(2026, 0, 1, 0, 0, seq), updatedAt: new Date(2026, 0, 1, 0, 0, seq), ...data,
			};
			rows.push(row);
			return row;
		};
		delegate.update = async ({ where, data }: { where: Row; data: Row }) => {
			const row = rows.find((item) => matches(item, where));
			if (!row) throw Object.assign(new Error("missing"), { code: "P2025" });
			Object.assign(row, data);
			return row;
		};
		delegate.updateMany = async ({ where, data }: { where: Row; data: Row }) => {
			const hit = rows.filter((item) => matches(item, where));
			for (const row of hit) Object.assign(row, data);
			return { count: hit.length };
		};
		delegate.delete = async ({ where }: { where: Row }) => {
			const index = rows.findIndex((item) => matches(item, where));
			if (index < 0) throw Object.assign(new Error("missing"), { code: "P2025" });
			rows.splice(index, 1);
			return {};
		};
		const apiDelegate = prisma.apiConnection as unknown as Record<string, unknown>;
		const apiFindFirst = apiDelegate.findFirst;
		apiDelegate.findFirst = async () => null;
		try {
			await run(rows);
		} finally {
			Object.assign(delegate, original);
			apiDelegate.findFirst = apiFindFirst;
		}
	};
}

function appFor(userId: string) {
	const app = new Hono();
	app.use("*", async (c, next) => {
		c.set("session" as never, { user: { id: userId, email: "owner@example.com" } } as never);
		await next();
	});
	app.route("/", createMcpRoutes());
	return app;
}

const base = { catalogId: "notion", name: "Notion", url: "https://mcp.notion.com/mcp", authType: "oauth" as const };

test("duas contas do mesmo catálogo: slugs distintos (notion, notion-2, notion-3) e apelido guardado", { skip: SKIP }, withMemoryDb(async () => {
	const first = await createMcpConnection({ ...base, userId: A, slug: "notion" });
	const second = await createMcpConnection({ ...base, userId: A, slug: "notion", accountLabel: "Notion pessoal" });
	const third = await createMcpConnection({ ...base, userId: A, slug: "notion", accountLabel: "Conta 3" });
	assert.deepEqual([first.slug, second.slug, third.slug], ["notion", "notion-2", "notion-3"]);
	assert.deepEqual([first.accountLabel, second.accountLabel, third.accountLabel], [null, "Notion pessoal", "Conta 3"]);
	assert.equal(new Set([first.id, second.id, third.id]).size, 3);
}));

test("slug longo: o sufixo cabe no limite do prefixo das tools e continua único", { skip: SKIP }, withMemoryDb(async () => {
	const long = "google_workspace_abcdefgh";
	const one = await createMcpConnection({ ...base, userId: A, catalogId: null, slug: long });
	const two = await createMcpConnection({ ...base, userId: A, catalogId: null, slug: long });
	assert.ok(one.slug.length <= 20 && two.slug.length <= 20);
	assert.notEqual(one.slug, two.slug);
	assert.match(two.slug, /-2$/);
}));

test("listas devolvem todas as contas do dono (sem deduplicar por catálogo) e isolam por dono", { skip: SKIP }, withMemoryDb(async () => {
	const one = await createMcpConnection({ ...base, userId: A, slug: "notion", status: "connected" });
	const two = await createMcpConnection({ ...base, userId: A, slug: "notion", status: "connected" });
	const other = await createMcpConnection({ ...base, userId: B, slug: "notion", status: "connected" });
	assert.equal(other.slug, "notion", "o slug é por dono");
	assert.deepEqual((await listMcpConnectionsByCatalogId("notion", A)).map((row) => row.id), [one.id, two.id]);
	assert.deepEqual((await listConnectedMcpConnections(A)).map((row) => row.id), [one.id, two.id]);
	assert.deepEqual((await listConnectedMcpConnections(B)).map((row) => row.id), [other.id]);
	assert.deepEqual(await listMcpConnectionsByCatalogId("notion", undefined), []);
}));

test("renomear a conta: PATCH accountLabel, null limpa, só o dono (404), apelido inválido recusado", { skip: SKIP }, withMemoryDb(async () => {
	const conn = await createMcpConnection({ ...base, userId: A, slug: "notion", status: "connected" });
	const patch = (app: Hono, body: unknown) => app.request(`/v1/mcp/connections/${conn.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
	const ok = await patch(appFor(A), { accountLabel: "  Notion   pessoal " });
	assert.equal(ok.status, 200);
	assert.equal(((await ok.json()) as { connection: { accountLabel: string } }).connection.accountLabel, "Notion pessoal");
	assert.equal((await patch(appFor(B), { accountLabel: "invasor" })).status, 404);
	assert.equal((await getMcpConnection(conn.id, A))?.accountLabel, "Notion pessoal");
	assert.equal((await patch(appFor(A), { accountLabel: 12 })).status, 400);
	await patch(appFor(A), { accountLabel: null });
	assert.equal((await getMcpConnection(conn.id, A))?.accountLabel, null);
}));

test("GET connections e catálogo: as duas contas aparecem, com contagem; resposta sem segredo", { skip: SKIP }, withMemoryDb(async () => {
	await createMcpConnection({ ...base, userId: A, slug: "notion", status: "connected", secretsEnc: "SEGREDO-CIFRADO" });
	await createMcpConnection({ ...base, userId: A, slug: "notion", status: "pending_auth", accountLabel: "Conta 2" });
	const list = await appFor(A).request("/v1/mcp/connections");
	const text = await list.text();
	assert.ok(!text.includes("SEGREDO-CIFRADO"));
	const connections = (JSON.parse(text) as { connections: { slug: string; accountLabel: string | null }[] }).connections;
	assert.deepEqual(connections.map((c) => [c.slug, c.accountLabel]), [["notion", null], ["notion-2", "Conta 2"]]);
	const catalog = (await (await appFor(A).request("/v1/mcp/catalog")).json()) as { entries: { id: string; accountCount: number; status: string | null }[] };
	const notion = catalog.entries.find((entry) => entry.id === "notion");
	assert.equal(notion?.accountCount, 2);
	assert.equal(notion?.status, "connected", "o cartão do catálogo mostra a conta conectada");
	assert.equal((await (await appFor(B).request("/v1/mcp/connections")).json() as { connections: unknown[] }).connections.length, 0);
}));

test("callback com 2 contas pendentes do mesmo catálogo resolve pela conexão do state (a outra segue pendente)", { skip: SKIP }, withMemoryDb(async (rows) => {
	const one = await createMcpConnection({ ...base, userId: A, slug: "notion" });
	const two = await createMcpConnection({ ...base, userId: A, slug: "notion", accountLabel: "Conta 2" });
	const sealed = sealSecrets({ oauth: { stateCreatedAt: Date.now() } });
	for (const [conn, state] of [[one, "state-um"], [two, "state-dois"]] as const) {
		Object.assign(rows.find((row) => row.id === conn.id)!, { oauthStateHash: hashMcpOAuthState(state), secretsEnc: sealed, status: "pending_auth" });
	}
	// Dono errado não consome o state.
	const intruder = await appFor(B).request("/v1/mcp/oauth/callback?state=state-dois&error=access_denied");
	assert.equal(intruder.status, 400);
	assert.ok(rows.find((row) => row.id === two.id)!.oauthStateHash, "state de outro dono não é consumido");
	const res = await appFor(A).request("/v1/mcp/oauth/callback?state=state-dois&error=access_denied");
	assert.equal(res.status, 400);
	assert.ok((await res.text()).includes("login cancelado"));
	const rowOne = rows.find((row) => row.id === one.id)!;
	const rowTwo = rows.find((row) => row.id === two.id)!;
	assert.equal(rowTwo.status, "error");
	assert.equal(rowTwo.oauthStateHash, null, "state de uso único");
	assert.equal(rowOne.status, "pending_auth");
	assert.equal(rowOne.oauthStateHash, hashMcpOAuthState("state-um"));
}));

test("corpo de criação aceita newAccount/accountLabel e normaliza o apelido", () => {
	assert.deepEqual(parseCreateMcpBody({ catalogId: "notion", newAccount: true, accountLabel: "  Notion   pessoal " }).value, { catalogId: "notion", apiKey: undefined, newAccount: true, accountLabel: "Notion pessoal" });
	assert.ok(parseCreateMcpBody({ catalogId: "notion", newAccount: "sim" }).error);
	assert.ok(parseCreateMcpBody({ catalogId: "notion", accountLabel: "x".repeat(121) }).error);
	assert.deepEqual(parsePatchMcpBody({ accountLabel: "A".repeat(100) }).value, { accountLabel: "A".repeat(60) });
});

test("identidade da conta a partir do token: id_token (e-mail), campos conhecidos; sem pista = null", () => {
	const jwt = (claims: object) => `x.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.y`;
	assert.equal(accountLabelFromTokens({ id_token: jwt({ email: "ana@exemplo.com", name: "Ana" }) }), "ana@exemplo.com");
	assert.equal(accountLabelFromTokens({ id_token: jwt({ name: "Ana" }) }), "Ana");
	assert.equal(accountLabelFromTokens({ owner: { user: { person: { email: "bia@exemplo.com" } } } }), "bia@exemplo.com");
	assert.equal(accountLabelFromTokens({ workspace_name: "Time Loja" }), "Time Loja");
	assert.equal(accountLabelFromTokens({ access_token: "abc" }), null);
	assert.equal(accountLabelFromTokens(undefined), null);
	assert.equal(isAutoAccountLabel("Conta 2"), true);
	assert.equal(isAutoAccountLabel(null), true);
	assert.equal(isAutoAccountLabel("Notion pessoal"), false);
});
