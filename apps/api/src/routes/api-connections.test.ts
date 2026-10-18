/**
 * Conexões de API (OpenAPI): aprovação do card, OAuth, isolamento por dono.
 * Banco e rede são dublês em memória; nada toca serviço real.
 *
 * Runner: `NODE_ENV=test ATLAS_HOOK_PEPPER=test-pepper pnpm exec tsx --test src/routes/api-connections.test.ts`
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { Hono } from "hono";

process.env.ATLAS_OWNER_EMAIL ||= "owner@example.com";
process.env.BETTER_AUTH_SECRET ||= "test-secret-long-enough-for-better-auth-middleware";
process.env.CONNECTOR_ENCRYPTION_KEY ||= randomBytes(32).toString("base64");

const { createApiConnectionRoutes, completeApiOAuthCallback, parseCreateApiConnectionBody, parsePatchApiConnectionBody } = await import("./api-connections.js");
const { parseOpenApiDocument, summarizeApiGroups, readableApiTags } = await import("@workspace/shared");
const { openApiSecrets } = await import("@workspace/agent-runtime");
const { hashMcpOAuthState } = await import("@workspace/agent-runtime");
import type { ApiConnectionRecord } from "@workspace/db";
import type { ApiConnectionRouteDeps } from "./api-connections.js";

const SPEC_URL = "https://developer.exemplo.test/openapi.json";
const spec = parseOpenApiDocument(
	{
		openapi: "3.0.0",
		info: { title: "Exemplo ERP" },
		servers: [{ url: "https://api.exemplo.test/v3" }],
		security: [{ OAuth2: [] }],
		components: { securitySchemes: { OAuth2: { type: "oauth2", flows: { authorizationCode: { authorizationUrl: "https://www.exemplo.test/oauth/authorize", tokenUrl: "https://www.exemplo.test/oauth/token", scopes: {} } } } } },
		paths: {
			"/pedidos": { get: { operationId: "getPedidos", tags: ["Pedidos"] }, post: { operationId: "postPedidos", tags: ["Pedidos"] } },
			"/notas": { post: { operationId: "postNotas", tags: ["Notas"] } },
			"/produtos": { get: { operationId: "getProdutos", tags: ["Produtos"] } },
		},
	},
	{ specUrl: SPEC_URL },
);
if (!spec.ok) throw new Error(spec.error);
const blingSpec = spec.spec;
const apiKeySpec = parseOpenApiDocument(
	{ openapi: "3.0.0", info: { title: "Loja" }, servers: [{ url: "https://api.loja.test" }], components: { securitySchemes: { k: { type: "apiKey", in: "header", name: "X-Key" } } }, security: [{ k: [] }], paths: { "/itens": { get: { operationId: "getItens", tags: ["Itens"] } } } },
	{ specUrl: "https://docs.loja.test/spec.json" },
);
if (!apiKeySpec.ok) throw new Error(apiKeySpec.error);
const apiKeySpecParsed = apiKeySpec.spec;

const CLIENT_SECRET = "client-secret-DO-NOT-LEAK-123";
const API_KEY = "api-key-DO-NOT-LEAK-456";

type Row = ApiConnectionRecord & { owner: string };

function fakeDeps(over: Partial<ApiConnectionRouteDeps> = {}) {
	const rows = new Map<string, Row>();
	const created: string[] = [];
	let seq = 0;
	const toRecord = (row: Row): ApiConnectionRecord => {
		const { owner: _owner, ...record } = row;
		return record;
	};
	const store: ApiConnectionRouteDeps["store"] = {
		list: async (userId) => [...rows.values()].filter((row) => row.owner === userId).map(toRecord),
		get: async (id, userId) => {
			const row = rows.get(id);
			return row && row.owner === userId ? toRecord(row) : null;
		},
		getWithCatalog: async (id, userId) => {
			const row = rows.get(id);
			return row && row.owner === userId ? { ...toRecord(row), catalog: blingSpec.operations } : null;
		},
		getByBaseUrl: async (baseUrl, userId) => {
			const row = [...rows.values()].find((item) => item.baseUrl === baseUrl && item.owner === userId);
			return row ? toRecord(row) : null;
		},
		listByBaseUrl: async (baseUrl, userId) => [...rows.values()].filter((item) => item.baseUrl === baseUrl && item.owner === userId).map(toRecord),
		create: async (input) => {
			seq += 1;
			created.push(input.userId ?? "");
			// Espelha o banco: slug único por dono (api, api-2, ...).
			const taken = new Set([...rows.values()].filter((item) => item.owner === input.userId).map((item) => item.slug));
			let slug = input.slug;
			for (let n = 2; taken.has(slug); n += 1) slug = `${input.slug}-${n}`;
			const row: Row = {
				id: `api-${seq}`,
				owner: input.userId ?? "",
				slug,
				accountLabel: input.accountLabel ?? null,
				name: input.name,
				domain: new URL(input.baseUrl).hostname,
				baseUrl: input.baseUrl,
				authKind: input.auth.kind,
				status: input.status ?? "pending_auth",
				lastError: null,
				groups: input.groups,
				allowedTags: input.allowedTags,
				operationCount: input.catalog.length,
				rateLimitRps: 3,
				createdAt: "2026-01-01T00:00:00.000Z",
				updatedAt: "2026-01-01T00:00:00.000Z",
				specUrl: input.specUrl,
				auth: input.auth,
				secretsEnc: input.secretsEnc ?? null,
				oauthStateHash: null,
			};
			rows.set(row.id, row);
			return toRecord(row);
		},
		update: async (id, patch, userId) => {
			const row = rows.get(id);
			if (!row || row.owner !== userId) return null;
			if (patch.status) row.status = patch.status;
			if (patch.secretsEnc !== undefined) row.secretsEnc = patch.secretsEnc;
			if (patch.oauthStateHash !== undefined) row.oauthStateHash = patch.oauthStateHash;
			if (patch.allowedTags) row.allowedTags = patch.allowedTags;
			if (patch.name) row.name = patch.name;
			if (patch.accountLabel !== undefined) row.accountLabel = patch.accountLabel;
			if (patch.lastError !== undefined) row.lastError = patch.lastError;
			if (patch.spec) {
				row.specUrl = patch.spec.specUrl;
				row.auth = patch.spec.auth;
				row.groups = patch.spec.groups;
				row.operationCount = patch.spec.catalog.length;
			}
			return toRecord(row);
		},
		delete: async (id, userId) => {
			const row = rows.get(id);
			if (!row || row.owner !== userId) return false;
			rows.delete(id);
			return true;
		},
		claimByState: async (hash, userId) => {
			const row = [...rows.values()].find((item) => item.oauthStateHash === hash && item.owner === userId);
			if (!row) return null;
			row.oauthStateHash = null;
			return toRecord(row);
		},
	};
	const exchanged: unknown[] = [];
	const revoked: unknown[] = [];
	const deps: Partial<ApiConnectionRouteDeps> = {
		store,
		discover: async (url) => (url.includes("loja") ? { spec: apiKeySpecParsed, specUrl: url, crossHost: false } : { spec: blingSpec, specUrl: SPEC_URL, crossHost: false }),
		detectPkce: async () => true,
		exchange: async (input) => {
			exchanged.push(input);
			return { access_token: "access-token-fixture-1", refresh_token: "refresh-token-fixture-1", expires_at: 9_999_999_999_999 };
		},
		revoke: async (input) => {
			revoked.push(input);
			return true;
		},
		redirectUrl: () => "https://atlas.test/v1/mcp/oauth/callback",
		secretBoxReady: () => true,
		now: () => 1_000_000,
		...over,
	};
	return { deps, rows, created, exchanged, revoked };
}

function appFor(userId: string, deps: Partial<ApiConnectionRouteDeps>) {
	const app = new Hono();
	app.use("*", async (c, next) => {
		c.set("session" as never, { user: { id: userId, email: "owner@example.com" } } as never);
		await next();
	});
	app.route("/", createApiConnectionRoutes(deps));
	return app;
}

const post = (app: Hono, path: string, body: unknown) => app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test("validação do corpo: limites e tipos", () => {
	assert.ok(parseCreateApiConnectionBody({}).error);
	assert.ok(parseCreateApiConnectionBody({ specUrl: "x".repeat(501) }).error);
	assert.ok(parseCreateApiConnectionBody({ specUrl: SPEC_URL, clientSecret: "" }).error);
	assert.ok(parseCreateApiConnectionBody({ specUrl: SPEC_URL, apiKey: "k".repeat(601) }).error);
	assert.ok(parseCreateApiConnectionBody({ specUrl: SPEC_URL, allowedTags: [1] }).error);
	assert.ok(parsePatchApiConnectionBody({ rateLimitRps: "x" }).error);
	assert.equal(parsePatchApiConnectionBody({ rateLimitRps: 99 }).value?.rateLimitRps, 20);
});

test("nada é criado antes da aprovação: listar vazio, e sem credenciais a criação é recusada", async () => {
	const { deps, created } = fakeDeps();
	const app = appFor("user-a", deps);
	assert.deepEqual(await (await app.request("/v1/api-connections")).json(), { connections: [] });
	const response = await post(app, "/v1/api-connections", { specUrl: SPEC_URL });
	assert.equal(response.status, 400);
	assert.deepEqual(created, []);
});

test("aprovação OAuth2: cria pendente, devolve a URL de login e nunca ecoa ou guarda segredo em claro", async () => {
	const { deps, rows } = fakeDeps();
	const app = appFor("user-a", deps);
	const response = await post(app, "/v1/api-connections", { specUrl: SPEC_URL, clientId: "client-id-visible", clientSecret: CLIENT_SECRET });
	assert.equal(response.status, 202);
	const text = await response.text();
	assert.ok(!text.includes(CLIENT_SECRET), "resposta não pode conter o client secret");
	const body = JSON.parse(text) as { connection: { status: string; allowedTags: string[]; domain: string }; authorizeUrl: string };
	assert.equal(body.connection.status, "pending_auth");
	assert.equal(body.connection.domain, "api.exemplo.test");
	// Etapa 1: só grupos com leitura (Notas só tem escrita).
	assert.deepEqual(body.connection.allowedTags, ["Pedidos", "Produtos"]);
	const url = new URL(body.authorizeUrl);
	assert.equal(url.searchParams.get("redirect_uri"), "https://atlas.test/v1/mcp/oauth/callback");
	assert.equal(url.searchParams.get("client_id"), "client-id-visible");
	assert.equal(url.searchParams.get("code_challenge_method"), "S256");
	assert.ok(url.searchParams.get("state"));
	const row = [...rows.values()][0]!;
	assert.ok(row.secretsEnc && !row.secretsEnc.includes(CLIENT_SECRET) && !row.secretsEnc.includes("client-id-visible"));
	assert.equal(openApiSecrets(row.secretsEnc).oauth?.clientSecret, CLIENT_SECRET);
	assert.ok(row.oauthStateHash);
});

test("grupos pedidos que só têm escrita ou não existem são descartados", async () => {
	const { deps } = fakeDeps();
	const app = appFor("user-a", deps);
	const response = await post(app, "/v1/api-connections", { specUrl: SPEC_URL, clientId: "cid-123456", clientSecret: CLIENT_SECRET, allowedTags: ["Pedidos", "Notas", "Inexistente"] });
	assert.deepEqual(((await response.json()) as { connection: { allowedTags: string[] } }).connection.allowedTags, ["Pedidos"]);
});

test("chave de API conecta direto, exige a chave e não a devolve", async () => {
	const { deps, rows } = fakeDeps();
	const app = appFor("user-a", deps);
	assert.equal((await post(app, "/v1/api-connections", { specUrl: "https://docs.loja.test/spec.json" })).status, 400);
	const response = await post(app, "/v1/api-connections", { specUrl: "https://docs.loja.test/spec.json", apiKey: API_KEY });
	assert.equal(response.status, 201);
	const text = await response.text();
	assert.ok(!text.includes(API_KEY));
	assert.equal((JSON.parse(text) as { connection: { status: string } }).connection.status, "connected");
	assert.equal(openApiSecrets([...rows.values()][0]!.secretsEnc).apiKey, API_KEY);
});

test("callback OAuth conclui a conexão do dono, uma vez só, e guarda os tokens cifrados", async () => {
	const { deps, rows, exchanged } = fakeDeps();
	const app = appFor("user-a", deps);
	const created = (await (await post(app, "/v1/api-connections", { specUrl: SPEC_URL, clientId: "cid-123456", clientSecret: CLIENT_SECRET })).json()) as { authorizeUrl: string };
	const state = new URL(created.authorizeUrl).searchParams.get("state")!;
	const full = deps as ApiConnectionRouteDeps;

	// Outro usuário com o mesmo state não reivindica.
	assert.equal(await completeApiOAuthCallback({ state, code: "code-1", userId: "user-b" }, full), null);
	const done = await completeApiOAuthCallback({ state, code: "code-1", userId: "user-a" }, full);
	assert.equal(done?.ok, true);
	assert.equal(exchanged.length, 1);
	const row = [...rows.values()][0]!;
	assert.equal(row.status, "connected");
	const saved = openApiSecrets(row.secretsEnc);
	assert.equal(saved.oauth?.tokens?.access_token, "access-token-fixture-1");
	assert.equal(saved.oauth?.clientSecret, CLIENT_SECRET);
	// state é de uso único.
	assert.equal(await completeApiOAuthCallback({ state, code: "code-1", userId: "user-a" }, full), null);
	// state que não é de API segue para o fluxo dos MCP.
	assert.equal(await completeApiOAuthCallback({ state: "outro", code: "c", userId: "user-a" }, full), null);
	assert.equal(hashMcpOAuthState("x").length > 10, true);
});

test("callback com login cancelado, state velho ou troca recusada marca erro sem vazar segredo", async () => {
	const base = fakeDeps();
	const app = appFor("user-a", base.deps);
	const make = async () => new URL(((await (await post(app, "/v1/api-connections", { specUrl: SPEC_URL, clientId: "cid-123456", clientSecret: CLIENT_SECRET })).json()) as { authorizeUrl: string }).authorizeUrl).searchParams.get("state")!;
	const full = base.deps as ApiConnectionRouteDeps;
	const cancelled = await completeApiOAuthCallback({ state: await make(), error: "access_denied", userId: "user-a" }, full);
	assert.equal(cancelled?.ok, false);
	assert.match(cancelled?.error ?? "", /cancelado/);

	const stale = await completeApiOAuthCallback({ state: await make(), code: "c", userId: "user-a" }, { ...full, now: () => 1_000_000 + 16 * 60_000 });
	assert.match(stale?.error ?? "", /expirou/);

	const refused = await completeApiOAuthCallback(
		{ state: await make(), code: "code-xyz", userId: "user-a" },
		{ ...full, exchange: async () => { throw new Error(`invalid_grant for ${CLIENT_SECRET} code-xyz`); } },
	);
	assert.equal(refused?.ok, false);
	assert.ok(!(refused?.error ?? "").includes(CLIENT_SECRET) && !(refused?.error ?? "").includes("code-xyz"));
	assert.equal([...base.rows.values()][0]!.status, "error");
});

test("isolamento: outro usuário não lista, altera, reconecta nem apaga a API do dono (404)", async () => {
	const { deps, rows } = fakeDeps();
	const owner = appFor("user-a", deps);
	const intruder = appFor("user-b", deps);
	await post(owner, "/v1/api-connections", { specUrl: "https://docs.loja.test/spec.json", apiKey: API_KEY });
	const id = [...rows.keys()][0]!;

	assert.deepEqual(await (await intruder.request("/v1/api-connections")).json(), { connections: [] });
	const patch = await intruder.request(`/v1/api-connections/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Hack" }) });
	assert.equal(patch.status, 404);
	assert.equal((await post(intruder, `/v1/api-connections/${id}/reauth`, { apiKey: "x-new-key-123456" })).status, 404);
	assert.equal((await intruder.request(`/v1/api-connections/${id}`, { method: "DELETE" })).status, 404);
	assert.equal(rows.get(id)?.name, "Loja");
	assert.equal(openApiSecrets(rows.get(id)?.secretsEnc).apiKey, API_KEY);

	// O dono continua conseguindo.
	assert.equal((await owner.request(`/v1/api-connections/${id}`, { method: "DELETE" })).status, 204);
	assert.equal(rows.size, 0);
});

test("PATCH só libera grupos com leitura; reauth OAuth reusa as credenciais salvas; DELETE revoga", async () => {
	const { deps, rows, revoked } = fakeDeps();
	const app = appFor("user-a", deps);
	await post(app, "/v1/api-connections", { specUrl: SPEC_URL, clientId: "cid-123456", clientSecret: CLIENT_SECRET });
	const id = [...rows.keys()][0]!;
	const patched = await app.request(`/v1/api-connections/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ allowedTags: ["Produtos", "Notas"] }) });
	assert.deepEqual(((await patched.json()) as { connection: { allowedTags: string[] } }).connection.allowedTags, ["Produtos"]);

	const reauth = await post(app, `/v1/api-connections/${id}/reauth`, {});
	assert.equal(reauth.status, 202);
	const url = new URL(((await reauth.json()) as { authorizeUrl: string }).authorizeUrl);
	assert.equal(url.searchParams.get("client_id"), "cid-123456");

	rows.get(id)!.status = "connected";
	assert.equal((await app.request(`/v1/api-connections/${id}`, { method: "DELETE" })).status, 204);
	assert.equal(revoked.length, 1);
	assert.equal(rows.size, 0);
});

test("sem a chave do cofre configurada, recusa com 503 e não grava", async () => {
	const { deps, created } = fakeDeps({ secretBoxReady: () => false });
	const response = await post(appFor("user-a", deps), "/v1/api-connections", { specUrl: SPEC_URL, clientId: "cid-123456", clientSecret: CLIENT_SECRET });
	assert.equal(response.status, 503);
	assert.deepEqual(created, []);
});

test("grupos e leitura vêm da spec (sanidade do fixture)", () => {
	assert.deepEqual(readableApiTags(spec.spec.operations), ["Pedidos", "Produtos"]);
	assert.equal(summarizeApiGroups(spec.spec.operations).find((group) => group.tag === "Notas")?.read, 0);
});

test("callback único dos MCP entrega o state de API ao conector certo (página de sucesso)", async () => {
	const { prisma } = await import("@workspace/db");
	const { createMcpRoutes } = await import("./mcp.js");
	const { deps, rows } = fakeDeps();
	const app = appFor("user-a", deps);
	const created = (await (await post(app, "/v1/api-connections", { specUrl: SPEC_URL, clientId: "cid-123456", clientSecret: CLIENT_SECRET })).json()) as { authorizeUrl: string };
	const state = new URL(created.authorizeUrl).searchParams.get("state")!;
	const original = prisma.mcpConnection.findFirst;
	// Nenhuma conexão MCP tem esse state: cai no conector de API.
	(prisma.mcpConnection as { findFirst: unknown }).findFirst = async () => null;
	try {
		const mcp = new Hono();
		mcp.use("*", async (c, next) => {
			c.set("session" as never, { user: { id: "user-a", email: "owner@example.com" } } as never);
			await next();
		});
		mcp.route("/", createMcpRoutes({ apiOAuthDeps: deps }));
		const response = await mcp.request(`/v1/mcp/oauth/callback?state=${state}&code=abc`);
		assert.equal(response.status, 200);
		assert.match(await response.text(), /Conectores/);
		assert.equal([...rows.values()][0]!.status, "connected");
		const again = await mcp.request(`/v1/mcp/oauth/callback?state=${state}&code=abc`);
		assert.equal(again.status, 400);
	} finally {
		(prisma.mcpConnection as { findFirst: unknown }).findFirst = original;
	}
});

test("descoberta manual: resumo igual ao do card, nada gravado, só para o dono logado", async () => {
	const { deps, rows, created } = fakeDeps();
	const app = appFor("user-a", deps);
	const response = await post(app, "/v1/api-connections/discover", { url: SPEC_URL });
	assert.equal(response.status, 200);
	const { proposal } = (await response.json()) as { proposal: { name: string; authKind: string; baseUrl: string; redirectUrl?: string; readCount: number } };
	assert.equal(proposal.name, "Exemplo ERP");
	assert.equal(proposal.authKind, "oauth2");
	assert.equal(proposal.baseUrl, "https://api.exemplo.test/v3");
	assert.equal(proposal.redirectUrl, "https://atlas.test/v1/mcp/oauth/callback");
	assert.equal(proposal.readCount, 2);
	assert.equal(rows.size, 0);
	assert.deepEqual(created, []);
	assert.equal((await post(app, "/v1/api-connections/discover", {})).status, 400);
});

test("descoberta manual: rede interna e link ruim viram mensagens simples em pt-BR", async () => {
	const messages: Record<string, string> = {
		"http://10.0.0.1/openapi.json": "Use um link https.",
		"https://127.0.0.1/openapi.json": "Esse endereço não é permitido (rede interna ou privada).",
		"https://docs.exemplo.test/nada": "Não encontrei a especificação da API nesse link. Tente o link do arquivo OpenAPI (.json ou .yaml).",
		"nao-e-link": "Esse link não parece válido. Cole o endereço completo, começando com https://.",
	};
	const { deps } = fakeDeps({
		discover: async (url) => {
			if (url.startsWith("http://")) throw new Error("Use um link https.");
			if (url.includes("127.0.0.1")) throw new Error("Esse endereço não é permitido (rede interna ou privada).");
			if (url === "nao-e-link") throw new Error("URL inválida.");
			throw new Error("Não encontrei uma especificação OpenAPI/Swagger nesse link (HTTP 404). Peça ao usuário o link direto do arquivo openapi.json ou swagger.json.");
		},
	});
	const app = appFor("user-a", deps);
	for (const [url, expected] of Object.entries(messages)) {
		const response = await post(app, "/v1/api-connections/discover", { url });
		assert.equal(response.status, 422);
		assert.deepEqual(await response.json(), { error: expected });
	}
});

test("descoberta manual: limite por usuário", async () => {
	const { deps } = fakeDeps();
	const app = appFor("user-a", deps);
	for (let i = 0; i < 20; i++) assert.equal((await post(app, "/v1/api-connections/discover", { url: SPEC_URL })).status, 200);
	assert.equal((await post(app, "/v1/api-connections/discover", { url: SPEC_URL })).status, 429);
	assert.equal((await post(appFor("user-b", deps), "/v1/api-connections/discover", { url: SPEC_URL })).status, 200);
});

test("GET operations devolve o catálogo só para o dono", async () => {
	const { deps, rows } = fakeDeps();
	const owner = appFor("user-a", deps);
	const intruder = appFor("user-b", deps);
	await post(owner, "/v1/api-connections", { specUrl: SPEC_URL, clientId: "cid-123456", clientSecret: CLIENT_SECRET });
	const id = [...rows.keys()][0]!;
	const ok = await owner.request(`/v1/api-connections/${id}/operations`);
	assert.equal(ok.status, 200);
	assert.ok(((await ok.json()) as { operations: unknown[] }).operations.length > 0);
	assert.equal((await intruder.request(`/v1/api-connections/${id}/operations`)).status, 404);
});

test("várias contas da mesma API: newAccount cria conexão nova com slug distinto e apelido padrão", async () => {
	const { deps, rows } = fakeDeps();
	const app = appFor("user-a", deps);
	const first = await post(app, "/v1/api-connections", { specUrl: SPEC_URL, clientId: "cid-111111", clientSecret: CLIENT_SECRET });
	const second = await post(app, "/v1/api-connections", { specUrl: SPEC_URL, clientId: "cid-222222", clientSecret: CLIENT_SECRET, newAccount: true });
	const third = await post(app, "/v1/api-connections", { specUrl: SPEC_URL, clientId: "cid-333333", clientSecret: CLIENT_SECRET, newAccount: true, accountLabel: "  Bling   loja  " });
	assert.deepEqual([first.status, second.status, third.status], [202, 202, 202]);
	const list = [...rows.values()];
	assert.equal(list.length, 3);
	assert.deepEqual(list.map((row) => row.slug), ["exemplo-erp", "exemplo-erp-2", "exemplo-erp-3"]);
	assert.deepEqual(list.map((row) => row.accountLabel), [null, "Conta 2", "Bling loja"]);
	// Cada conta tem o próprio state: dois logins pendentes não se confundem.
	const states = list.map((row) => row.oauthStateHash);
	assert.equal(new Set(states).size, 3);
	// Sem a flag, reconectar continua atualizando a existente (não cria 4ª).
	await post(app, "/v1/api-connections", { specUrl: SPEC_URL, clientId: "cid-444444", clientSecret: CLIENT_SECRET });
	assert.equal(rows.size, 3);
});

test("callback com 2 contas pendentes da mesma API conclui cada uma pela própria conexão", async () => {
	const { deps, rows } = fakeDeps();
	const app = appFor("user-a", deps);
	const stateOf = async (extra: object) => new URL(((await (await post(app, "/v1/api-connections", { specUrl: SPEC_URL, clientId: "cid-123456", clientSecret: CLIENT_SECRET, ...extra })).json()) as { authorizeUrl: string }).authorizeUrl).searchParams.get("state")!;
	const s1 = await stateOf({});
	const s2 = await stateOf({ newAccount: true });
	const done2 = await completeApiOAuthCallback({ state: s2, code: "c2", userId: "user-a" }, deps as ApiConnectionRouteDeps);
	assert.equal(done2?.connectionId, "api-2");
	const [a, b] = [...rows.values()];
	assert.equal(a!.status, "pending_auth");
	assert.equal(b!.status, "connected");
	const done1 = await completeApiOAuthCallback({ state: s1, code: "c1", userId: "user-a" }, deps as ApiConnectionRouteDeps);
	assert.equal(done1?.connectionId, "api-1");
	assert.equal(rows.get("api-1")!.status, "connected");
});

test("renomear a conta: PATCH accountLabel (null limpa), só o dono, apelido limitado", async () => {
	const { deps, rows } = fakeDeps();
	const owner = appFor("user-a", deps);
	const intruder = appFor("user-b", deps);
	await post(owner, "/v1/api-connections", { specUrl: "https://docs.loja.test/spec.json", apiKey: API_KEY });
	const id = [...rows.keys()][0]!;
	const patch = (app: Hono, body: unknown) => app.request(`/v1/api-connections/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
	const ok = await patch(owner, { accountLabel: "  Loja do centro " });
	assert.equal(ok.status, 200);
	assert.equal(((await ok.json()) as { connection: { accountLabel: string } }).connection.accountLabel, "Loja do centro");
	assert.equal((await patch(intruder, { accountLabel: "invasor" })).status, 404);
	assert.equal(rows.get(id)!.accountLabel, "Loja do centro");
	assert.equal((await patch(owner, { accountLabel: "x".repeat(121) })).status, 400);
	assert.equal((await patch(owner, { accountLabel: 5 })).status, 400);
	await patch(owner, { accountLabel: null });
	assert.equal(rows.get(id)!.accountLabel, null);
});

test("isolamento por dono: contas do mesmo serviço de outro usuário não aparecem nem entram na contagem do apelido", async () => {
	const { deps, rows } = fakeDeps();
	const a = appFor("user-a", deps);
	const b = appFor("user-b", deps);
	await post(a, "/v1/api-connections", { specUrl: SPEC_URL, clientId: "cid-123456", clientSecret: CLIENT_SECRET });
	await post(b, "/v1/api-connections", { specUrl: SPEC_URL, clientId: "cid-123456", clientSecret: CLIENT_SECRET, newAccount: true });
	const mine = [...rows.values()].filter((row) => row.owner === "user-b");
	assert.equal(mine[0]!.accountLabel, null);
	assert.equal(mine[0]!.slug, "exemplo-erp");
	assert.equal(((await (await a.request("/v1/api-connections")).json()) as { connections: unknown[] }).connections.length, 1);
});

test("proposta para outra conta: relê a spec da conexão do dono, 404 para outro usuário, nada gravado", async () => {
	const { deps, rows } = fakeDeps();
	const owner = appFor("user-a", deps);
	await post(owner, "/v1/api-connections", { specUrl: SPEC_URL, clientId: "cid-123456", clientSecret: CLIENT_SECRET });
	const id = [...rows.keys()][0]!;
	const ok = await post(owner, `/v1/api-connections/${id}/proposal`, {});
	assert.equal(ok.status, 200);
	const body = (await ok.json()) as { proposal: { baseUrl: string; authKind: string } };
	assert.equal(body.proposal.baseUrl, "https://api.exemplo.test/v3");
	assert.equal(body.proposal.authKind, "oauth2");
	assert.equal((await post(appFor("user-b", deps), `/v1/api-connections/${id}/proposal`, {})).status, 404);
	assert.equal(rows.size, 1);
});
