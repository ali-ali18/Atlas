/**
 * Fonte de dados com chave (brapi) no Marketplace: a chave vai para o cofre do dono, só dele, e é lida só pelo
 * servidor ao conferir os alertas dele. Dublê em memória do delegate `prisma.mcpConnection`; nada toca banco ou rede.
 *
 * Runner: `NODE_ENV=test ATLAS_HOOK_PEPPER=test-pepper pnpm exec tsx --test src/routes/mcp-data-source.test.ts`
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { Hono } from "hono";

process.env.ATLAS_OWNER_EMAIL ||= "owner@example.com";
process.env.BETTER_AUTH_SECRET ||= "test-secret-long-enough-for-better-auth-middleware";
process.env.CONNECTOR_ENCRYPTION_KEY ||= randomBytes(32).toString("base64");

const { prisma } = await import("@workspace/db");
const { createMcpRoutes } = await import("./mcp.js");
const { openSecrets, resolveMarketKeys } = await import("@workspace/agent-runtime");

type Row = Record<string, any>;

function stubable(obj: object, key: string): boolean {
	const descriptor = Object.getOwnPropertyDescriptor(obj, key);
	return Boolean(descriptor?.writable ?? descriptor?.configurable ?? true);
}
const CAN_STUB = ["findMany", "findFirst", "create", "update"].every((key) => stubable(prisma.mcpConnection, key));
const SKIP = CAN_STUB ? undefined : "exige delegates do prisma substituíveis";

const A = "user-a-brapi";
const B = "user-b-brapi";
const KEY_A = "brapi-token-do-usuario-A-111111";

function withMemoryDb(run: (rows: Row[]) => Promise<void>) {
	return async () => {
		const rows: Row[] = [];
		let seq = 0;
		const delegate = prisma.mcpConnection as unknown as Record<string, unknown>;
		const original = Object.fromEntries(["findMany", "findFirst", "create", "update"].map((key) => [key, delegate[key]]));
		const matches = (row: Row, where: Row = {}): boolean =>
			Object.entries(where).every(([key, expected]) => {
				if (expected && typeof expected === "object" && "in" in (expected as object)) return ((expected as { in: unknown[] }).in).includes(row[key]);
				return row[key] === expected;
			});
		const sorted = (list: Row[]) => [...list].sort((x, y) => x.createdAt.getTime() - y.createdAt.getTime());
		delegate.findMany = async (args: { where?: Row } = {}) => sorted(rows.filter((row) => matches(row, args.where)));
		delegate.findFirst = async (args: { where?: Row } = {}) => sorted(rows.filter((row) => matches(row, args.where)))[0] ?? null;
		delegate.create = async ({ data }: { data: Row }) => {
			seq += 1;
			const row: Row = { id: `conn-${seq}`, toolsCacheJson: null, disabledTools: [], confirmWrites: true, lastError: null, oauthStateHash: null, secretsEnc: null, accountLabel: null, createdAt: new Date(2026, 0, 1, 0, 0, seq), updatedAt: new Date(2026, 0, 1, 0, 0, seq), ...data };
			rows.push(row);
			return row;
		};
		delegate.update = async ({ where, data }: { where: Row; data: Row }) => {
			const row = rows.find((item) => matches(item, where));
			if (!row) throw Object.assign(new Error("missing"), { code: "P2025" });
			Object.assign(row, data);
			return row;
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

function appFor(userId: string, probe: (catalogId: string, key: string) => Promise<void>) {
	const app = new Hono();
	app.use("*", async (c, next) => {
		c.set("session" as never, { user: { id: userId, email: "owner@example.com" } } as never);
		await next();
	});
	app.route("/", createMcpRoutes({ probeDataSource: probe }));
	return app;
}

const post = (app: Hono, body: unknown) => app.request("/v1/mcp/connections", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test("conectar a brapi testa a chave, guarda cifrada no dono e não devolve a chave", { skip: SKIP }, withMemoryDb(async (rows) => {
	const probed: string[] = [];
	const res = await post(appFor(A, async (id, key) => void probed.push(`${id}:${key}`)), { catalogId: "brapi", apiKey: KEY_A });
	assert.equal(res.status, 201);
	const text = await res.text();
	assert.ok(!text.includes(KEY_A), "a resposta não pode conter a chave");
	assert.deepEqual(probed, [`brapi:${KEY_A}`]);
	assert.equal(rows.length, 1);
	assert.equal(rows[0]!.userId, A);
	assert.equal(rows[0]!.status, "connected");
	assert.ok(!JSON.stringify(rows[0]).includes(KEY_A), "a chave não pode ficar em claro na linha");
	assert.equal(openSecrets(rows[0]!.secretsEnc).apiKey, KEY_A);
	assert.deepEqual(rows[0]!.toolsCacheJson, []);
}));

test("chave recusada pela brapi: 422 com mensagem simples, sem gravar e sem eco da chave", { skip: SKIP }, withMemoryDb(async (rows) => {
	const res = await post(appFor(A, async () => { throw new Error(`A brapi recusou essa chave ${KEY_A}`); }), { catalogId: "brapi", apiKey: KEY_A });
	assert.equal(res.status, 422);
	assert.ok(!(await res.text()).includes(KEY_A));
	assert.equal(rows.length, 0);
}));

test("sem chave não conecta a brapi", { skip: SKIP }, withMemoryDb(async (rows) => {
	const res = await post(appFor(A, async () => undefined), { catalogId: "brapi" });
	assert.ok(res.status >= 400 && res.status < 500);
	assert.equal(rows.length, 0);
}));

test("o catálogo mostra a brapi como fonte de dados e a conexão do dono, nunca a de outro", { skip: SKIP }, withMemoryDb(async () => {
	await post(appFor(A, async () => undefined), { catalogId: "brapi", apiKey: KEY_A });
	const asA = (await (await appFor(A, async () => undefined).request("/v1/mcp/catalog")).json()) as { entries: Array<{ id: string; kind?: string; status: string | null; apiKey?: object }> };
	const asB = (await (await appFor(B, async () => undefined).request("/v1/mcp/catalog")).json()) as typeof asA;
	const brapiA = asA.entries.find((entry) => entry.id === "brapi")!;
	assert.equal(brapiA.kind, "data_source");
	assert.equal(brapiA.status, "connected");
	assert.equal(asB.entries.find((entry) => entry.id === "brapi")!.status, null);
}));

test("resolveMarketKeys: cada dono lê só a própria chave (usuário B nunca recebe a do A)", { skip: SKIP }, withMemoryDb(async () => {
	await post(appFor(A, async () => undefined), { catalogId: "brapi", apiKey: KEY_A });
	assert.deepEqual(await resolveMarketKeys(A), { brapi: KEY_A });
	assert.deepEqual(await resolveMarketKeys(B), {});
	assert.deepEqual(await resolveMarketKeys("default"), {});
	assert.deepEqual(await resolveMarketKeys(undefined), {});
	await post(appFor(B, async () => undefined), { catalogId: "brapi", apiKey: "brapi-token-do-usuario-B-222222" });
	assert.deepEqual(await resolveMarketKeys(B), { brapi: "brapi-token-do-usuario-B-222222" });
	assert.deepEqual(await resolveMarketKeys(A), { brapi: KEY_A });
}));

test("conexão que não está ativa (erro ou desconectada) não entrega chave", { skip: SKIP }, withMemoryDb(async (rows) => {
	await post(appFor(A, async () => undefined), { catalogId: "brapi", apiKey: KEY_A });
	rows[0]!.status = "error";
	assert.deepEqual(await resolveMarketKeys(A), {});
}));

test("atualizar a conexão confere a chave de novo e marca erro se não vale mais", { skip: SKIP }, withMemoryDb(async (rows) => {
	await post(appFor(A, async () => undefined), { catalogId: "brapi", apiKey: KEY_A });
	const id = rows[0]!.id as string;
	const bad = await appFor(A, async () => { throw new Error("A brapi recusou essa chave."); }).request(`/v1/mcp/connections/${id}/refresh`, { method: "POST" });
	assert.equal(bad.status, 200);
	assert.equal(rows[0]!.status, "error");
	const other = await appFor(B, async () => undefined).request(`/v1/mcp/connections/${id}/refresh`, { method: "POST" });
	assert.equal(other.status, 404, "outro dono não atualiza nem vê a conexão");
}));
