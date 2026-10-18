import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { Hono } from "hono";
import type { McpConnectionRecord } from "@workspace/db";
import type { McpToolInfo } from "@workspace/shared";

process.env.ATLAS_OWNER_EMAIL ||= "owner@example.com";
process.env.BETTER_AUTH_SECRET ||= "test-secret-long-enough-for-better-auth-middleware";
process.env.CONNECTOR_ENCRYPTION_KEY ||= randomBytes(32).toString("base64");

const { createComposioRoutes } = await import("./composio.js");
const { ComposioApiError, ComposioInvalidResponseError, composioUserId, composioMcpUrl, openSecrets, hashMcpOAuthState } = await import("@workspace/agent-runtime");
import type { ComposioRoutesDeps, ComposioStore } from "./composio.js";
import type { AuthEnv } from "../middleware/auth.js";
import type { ComposioClient } from "@workspace/agent-runtime";

const KEY_A = "cmp_key_user_a_SECRET_9999";
const KEY_B = "cmp_key_user_b_SECRET_8888";
const WEB = "https://atlas.example.com";

type Row = McpConnectionRecord & { userId: string };

function memoryStore(): ComposioStore & { rows: Row[] } {
	const rows: Row[] = [];
	let seq = 0;
	const toRecord = (row: Row): McpConnectionRecord => row;
	return {
		rows,
		async get(userId) {
			return rows.find((row) => row.userId === userId) ?? null;
		},
		async create({ userId, secretsEnc }) {
			seq += 1;
			const row: Row = {
				id: `conn-${seq}`, userId, catalogId: "composio", slug: "composio", name: "Composio",
				url: "https://backend.composio.dev/v3/mcp", authType: "api_key", status: "pending_auth",
				tools: [], disabledTools: [], confirmWrites: true, lastError: null, accountLabel: null,
				createdAt: "2026-01-01", updatedAt: "2026-01-01", secretsEnc, oauthStateHash: null,
			};
			rows.push(row);
			return toRecord(row);
		},
		async update(id, patch, userId) {
			const row = rows.find((r) => r.id === id && r.userId === userId);
			if (!row) return null;
			Object.assign(row, patch);
			return toRecord(row);
		},
		async remove(id, userId) {
			const index = rows.findIndex((r) => r.id === id && r.userId === userId);
			if (index < 0) return false;
			rows.splice(index, 1);
			return true;
		},
		async claimState(hash, userId) {
			const row = rows.find((r) => r.oauthStateHash === hash && r.userId === userId);
			if (!row) return null;
			row.oauthStateHash = null;
			return toRecord(row);
		},
	};
}

/** Composio falso: contas por composioUser, chaves aceitas, servidores criados. */
function fakeComposio(validKeys: string[] = [KEY_A, KEY_B]) {
	const accounts = new Map<string, { id: string; toolkit: string; status: string }[]>();
	const servers = new Set<string>();
	/** Apps com `no_auth` na lista do Composio. */
	const noAuth = new Set<string>();
	/** Apps que a lista não marca, mas cujo auth config dá 400 Auth_Config_NoAuthApp. */
	const noAuthOnCreate = new Set<string>();
	const authConfigCalls: string[] = [];
	const serverBodies: { name: string; toolkits: { slug: string; authConfigId: string }[]; noAuthApps?: string[] }[] = [];
	const calls: string[] = [];
	const listInputs: Parameters<ComposioClient["listToolkits"]>[0][] = [];
	const deletedAccounts: string[] = [];
	const linkUsers: string[] = [];
	const listedUsers: string[] = [];
	let nextServer = 0;
	const createClient = (apiKey: string): ComposioClient => {
		const guard = () => {
			if (!validKeys.includes(apiKey)) throw new ComposioApiError("chave do Composio recusada", 401);
		};
		return {
			async listToolkits(input = {}) {
				guard();
				calls.push("toolkits");
				listInputs.push(input);
				return {
					items: [
						{ slug: "composio", name: "Composio", description: null, logo: null, noAuth: false },
						{ slug: "github", name: "GitHub", description: "Código", logo: null, noAuth: noAuth.has("github") },
						{ slug: "trello", name: "Trello", description: null, logo: null, noAuth: noAuth.has("trello") },
					],
					nextCursor: input.cursor ? null : "next_1",
					totalItems: 321,
				};
			},
			async listToolkitCategories() {
				guard();
				return [{ id: "developer-tools", name: "Developer Tools" }];
			},
			async findToolkit(slug: string) {
				guard();
				return { slug, name: slug, description: null, logo: null, noAuth: noAuth.has(slug) };
			},
			async ensureAuthConfig(slug: string) {
				guard();
				authConfigCalls.push(slug);
				if (noAuthOnCreate.has(slug)) {
					throw new ComposioApiError("O Composio recusou o pedido (Auth_Config_NoAuthApp, código 303).", 400, {
						slug: "Auth_Config_NoAuthApp",
						code: 303,
					});
				}
				return `ac_${slug}`;
			},
			async createConnectLink(input: { callbackUrl: string; composioUser: string }) {
				guard();
				calls.push(`link:${input.callbackUrl}`);
				linkUsers.push(input.composioUser);
				return { redirectUrl: "https://connect.composio.dev/link/ln_1", connectedAccountId: null };
			},
			async listConnectedAccounts(user: string, options?: { statuses?: string[] }) {
				guard();
				listedUsers.push(user);
				const statuses = options?.statuses ?? ["ACTIVE"];
				return (accounts.get(user) ?? []).filter((account) => statuses.includes(account.status));
			},
			async deleteConnectedAccount(id: string) {
				guard();
				deletedAccounts.push(id);
				for (const [user, list] of accounts) accounts.set(user, list.filter((a) => a.id !== id));
			},
			async createMcpServer(input: { name: string; toolkits: { slug: string; authConfigId: string }[]; noAuthApps?: string[] }) {
				guard();
				serverBodies.push(input);
				nextServer += 1;
				servers.add(`srv_${nextServer}`);
				return `srv_${nextServer}`;
			},
			async deleteMcpServer(id: string) {
				servers.delete(id);
			},
		} as ComposioClient;
	};
	return { createClient, accounts, servers, noAuth, noAuthOnCreate, authConfigCalls, serverBodies, calls, listInputs, deletedAccounts, linkUsers, listedUsers };
}

const TOOLS: McpToolInfo[] = [{ name: "GITHUB_LIST_COMMITS", inputSchema: { type: "object", properties: {} } }];

function setup(overrides: Partial<ComposioRoutesDeps> = {}, validKeys?: string[]) {
	const store = memoryStore();
	const composio = fakeComposio(validKeys);
	const probes: { url: string; headers: Record<string, string> }[] = [];
	const deps: ComposioRoutesDeps = {
		store,
		createClient: composio.createClient,
		probe: async (input) => {
			probes.push(input);
			return TOOLS;
		},
		secretBoxReady: () => true,
		webOrigin: () => WEB,
		now: () => 1_000_000,
		...overrides,
	};
	const inner = createComposioRoutes(deps);
	const as = (userId: string) => {
		const outer = new Hono<AuthEnv>();
		outer.use("*", async (c, next) => {
			c.set("session", { user: { id: userId } } as AuthEnv["Variables"]["session"]);
			await next();
		});
		outer.route("/", inner);
		return outer;
	};
	return { store, composio, probes, as };
}

const put = (app: Hono<AuthEnv>, apiKey: unknown) =>
	app.request("/v1/composio/key", {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ apiKey }),
	});
const post = (app: Hono<AuthEnv>, path: string, body: unknown) =>
	app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test("sem chave: status desligado e as rotas de apps respondem 409", async () => {
	const { as } = setup();
	const app = as("user-a");
	assert.deepEqual(await (await app.request("/v1/composio/status")).json(), {
		configured: false, keyHint: null, secretBoxReady: true, toolCount: 0,
	});
	assert.equal((await app.request("/v1/composio/toolkits")).status, 409);
	assert.equal((await post(app, "/v1/composio/connect", { toolkit: "github" })).status, 409);
	assert.deepEqual(await (await app.request("/v1/composio/connections")).json(), { connections: [] });
});

test("PUT /key salva no cofre, devolve só a máscara e nunca a chave", async () => {
	const { as, store } = setup();
	const res = await put(as("user-a"), KEY_A);
	assert.equal(res.status, 200);
	const text = await res.text();
	assert.ok(!text.includes(KEY_A));
	assert.deepEqual(JSON.parse(text), { configured: true, keyHint: "••••9999", secretBoxReady: true, toolCount: 0 });
	const row = store.rows[0] as Row;
	assert.ok(row.secretsEnc && !row.secretsEnc.includes(KEY_A), "cifrado no cofre");
	assert.equal(openSecrets(row.secretsEnc).apiKey, KEY_A);
	assert.equal(row.url, "https://backend.composio.dev/v3/mcp");
	assert.ok(!(await (await as("user-a").request("/v1/composio/status")).text()).includes(KEY_A));
});

test("PUT /key valida o corpo, a chave recusada e o cofre", async () => {
	const { as } = setup();
	assert.equal((await put(as("user-a"), 123)).status, 400);
	assert.equal((await put(as("user-a"), "curta")).status, 400);
	const refused = await put(as("user-a"), "cmp_key_invalida_000");
	assert.equal(refused.status, 422);
	assert.ok(!(await refused.text()).includes("cmp_key_invalida_000"));
	const noVault = setup({ secretBoxReady: () => false });
	assert.equal((await put(noVault.as("user-a"), KEY_A)).status, 503);
});

test("IDOR: usuário B não vê a chave, os apps nem apaga a conta do usuário A", async () => {
	const { as, composio, store } = setup();
	await put(as("user-a"), KEY_A);
	const cuA = composioUserId("user-a");
	composio.accounts.set(cuA, [{ id: "ca_a1", toolkit: "github", status: "ACTIVE" }]);

	const b = as("user-b");
	assert.equal((await (await b.request("/v1/composio/status")).json() as { configured: boolean }).configured, false);
	assert.equal((await b.request("/v1/composio/toolkits")).status, 409);
	assert.deepEqual(await (await b.request("/v1/composio/connections")).json(), { connections: [] });
	assert.equal((await b.request("/v1/composio/connections/ca_a1", { method: "DELETE" })).status, 404);

	// Mesmo com chave própria, a conta do A não aparece nem some pelo B.
	await put(b, KEY_B);
	assert.deepEqual(await (await b.request("/v1/composio/connections")).json(), { connections: [] });
	assert.equal((await b.request("/v1/composio/connections/ca_a1", { method: "DELETE" })).status, 404);
	assert.deepEqual(composio.deletedAccounts, []);

	// DELETE /key do B só remove a linha do B.
	assert.equal((await b.request("/v1/composio/key", { method: "DELETE" })).status, 204);
	assert.equal(store.rows.length, 1);
	assert.equal((store.rows[0] as Row).userId, "user-a");
});

test("GET /toolkits marca apps conectados e o equivalente nativo", async () => {
	const { as, composio } = setup();
	await put(as("user-a"), KEY_A);
	composio.accounts.set(composioUserId("user-a"), [{ id: "ca_1", toolkit: "github", status: "ACTIVE" }]);
	const res = await as("user-a").request("/v1/composio/toolkits?search=git");
	assert.equal(res.status, 200);
	const body = (await res.json()) as { items: { slug: string; connected: boolean; nativeCatalogId: string | null }[] };
	assert.deepEqual(
		body.items.map((item) => [item.slug, item.connected, item.nativeCatalogId]),
		[["github", true, "github"], ["trello", false, null]],
	);
});

test("GET /toolkits pagina: repassa cursor, limite, categoria e devolve nextCursor e total sem o meta-toolkit", async () => {
	const { as, composio } = setup();
	await put(as("user-a"), KEY_A);
	const first = await as("user-a").request("/v1/composio/toolkits?limit=30&category=developer-tools&sort=alphabetically");
	assert.equal(first.status, 200);
	const page = (await first.json()) as { items: { slug: string }[]; nextCursor: string | null; totalItems: number | null };
	assert.deepEqual(page.items.map((item) => item.slug), ["github", "trello"]);
	assert.equal(page.nextCursor, "next_1");
	assert.equal(page.totalItems, 321);
	assert.deepEqual(composio.listInputs.at(-1), { search: undefined, cursor: undefined, category: "developer-tools", limit: 30, sortBy: "alphabetically" });
	const second = await as("user-a").request("/v1/composio/toolkits?cursor=next_1&search=git");
	assert.equal(((await second.json()) as { nextCursor: string | null }).nextCursor, null);
	assert.deepEqual(composio.listInputs.at(-1), { search: "git", cursor: "next_1", category: undefined, limit: 24, sortBy: "usage" });
});

test("GET /toolkits rejeita parâmetros inválidos com 400 sem chamar o Composio", async () => {
	const { as, composio } = setup();
	await put(as("user-a"), KEY_A);
	const before = composio.listInputs.length;
	for (const query of ["limit=0", "limit=999", "limit=abc", "cursor=a%20b", "category=..%2Fx", "sort=random"]) {
		assert.equal((await as("user-a").request(`/v1/composio/toolkits?${query}`)).status, 400, query);
	}
	assert.equal(composio.listInputs.length, before);
});

test("GET /toolkits e /categories exigem a chave do próprio usuário (usuário B não usa a de A)", async () => {
	const { as } = setup();
	await put(as("user-a"), KEY_A);
	assert.equal((await as("user-b").request("/v1/composio/toolkits?cursor=next_1")).status, 409);
	assert.equal((await as("user-b").request("/v1/composio/categories")).status, 409);
});

test("GET /categories lista as categorias do Composio", async () => {
	const { as } = setup();
	await put(as("user-a"), KEY_A);
	const res = await as("user-a").request("/v1/composio/categories");
	assert.equal(res.status, 200);
	assert.deepEqual(await res.json(), { categories: [{ id: "developer-tools", name: "Developer Tools" }] });
});

test("POST /connect valida o slug e devolve o link com state de uso único no callback", async () => {
	const { as, composio, store } = setup();
	const app = as("user-a");
	await put(app, KEY_A);
	assert.equal((await post(app, "/v1/composio/connect", { toolkit: "../x" })).status, 400);
	assert.equal((await post(app, "/v1/composio/connect", {})).status, 400);
	const res = await post(app, "/v1/composio/connect", { toolkit: "github" });
	assert.equal(res.status, 200);
	assert.deepEqual(await res.json(), { redirectUrl: "https://connect.composio.dev/link/ln_1" });
	const link = composio.calls.find((call) => call.startsWith("link:")) as string;
	const callback = new URL(link.slice(5));
	assert.equal(callback.origin + callback.pathname, `${WEB}/v1/composio/callback`);
	const state = callback.searchParams.get("state") as string;
	assert.equal((store.rows[0] as Row).oauthStateHash, hashMcpOAuthState(state));
});

async function connectFlow(app: Hono<AuthEnv>, composio: ReturnType<typeof fakeComposio>, userId: string, extra = "") {
	await post(app, "/v1/composio/connect", { toolkit: "github" });
	const link = [...composio.calls].reverse().find((call) => call.startsWith("link:")) as string;
	const state = new URL(link.slice(5)).searchParams.get("state") as string;
	composio.accounts.set(composioUserId(userId), [{ id: "ca_a1", toolkit: "github", status: "ACTIVE" }]);
	return app.request(`/v1/composio/callback?state=${encodeURIComponent(state)}&status=success${extra}`);
}

test("callback: cria o servidor, guarda a URL só no cofre e conecta as tools", async () => {
	const { as, composio, store, probes } = setup();
	const app = as("user-a");
	await put(app, KEY_A);
	const res = await connectFlow(app, composio, "user-a", "&connected_account_id=ca_a1");
	assert.equal(res.status, 200);
	const html = await res.text();
	assert.ok(html.includes("atlas:mcp-oauth"), "mesma mensagem do popup MCP (o web reaproveita o listener)");
	assert.ok(html.includes("Atlas · Composio"));
	assert.ok(!html.includes(KEY_A));
	const row = store.rows[0] as Row;
	assert.equal(row.status, "connected");
	assert.equal(row.tools.length, 1);
	assert.equal(row.url, "https://backend.composio.dev/v3/mcp", "coluna url continua pública");
	const secrets = openSecrets(row.secretsEnc);
	assert.equal(secrets.url, composioMcpUrl("srv_1", composioUserId("user-a")));
	assert.equal(secrets.headers?.["x-api-key"], KEY_A);
	assert.equal(probes[0]?.headers["x-api-key"], KEY_A);
	assert.ok(!(await (await app.request("/v1/composio/status")).text()).includes("srv_1"));
	assert.deepEqual([...composio.servers], ["srv_1"]);
});

test("callback: state é de uso único e de outro usuário não vale", async () => {
	const { as, composio } = setup();
	const a = as("user-a");
	await put(a, KEY_A);
	await post(a, "/v1/composio/connect", { toolkit: "github" });
	const link = composio.calls.find((call) => call.startsWith("link:")) as string;
	const state = new URL(link.slice(5)).searchParams.get("state") as string;
	composio.accounts.set(composioUserId("user-a"), [{ id: "ca_a1", toolkit: "github", status: "ACTIVE" }]);

	const stolen = await as("user-b").request(`/v1/composio/callback?state=${state}&status=success`);
	assert.equal(stolen.status, 400);
	const first = await a.request(`/v1/composio/callback?state=${state}&status=success`);
	assert.equal(first.status, 200);
	const replay = await a.request(`/v1/composio/callback?state=${state}&status=success`);
	assert.equal(replay.status, 400);
});

test("callback: conta que não é do usuário, status falho e sem state falham", async () => {
	const { as, composio } = setup();
	const app = as("user-a");
	await put(app, KEY_A);
	const foreign = await connectFlow(app, composio, "user-a", "&connected_account_id=ca_de_outro");
	assert.equal(foreign.status, 400);
	assert.ok((await foreign.text()).includes("não pertence"));

	await post(app, "/v1/composio/connect", { toolkit: "github" });
	const link = [...composio.calls].reverse().find((call) => call.startsWith("link:")) as string;
	const state = new URL(link.slice(5)).searchParams.get("state") as string;
	assert.equal((await app.request(`/v1/composio/callback?state=${state}&status=failed`)).status, 400);
	assert.equal((await app.request("/v1/composio/callback?status=success")).status, 400);
});

test("callback com state velho (TTL) falha", async () => {
	let now = 1_000_000;
	const { as, composio } = setup({ now: () => now });
	const app = as("user-a");
	await put(app, KEY_A);
	await post(app, "/v1/composio/connect", { toolkit: "github" });
	const link = composio.calls.find((call) => call.startsWith("link:")) as string;
	const state = new URL(link.slice(5)).searchParams.get("state") as string;
	now += 16 * 60_000;
	const res = await app.request(`/v1/composio/callback?state=${state}&status=success`);
	assert.equal(res.status, 400);
});

test("falha do servidor MCP: erro sem vazar a chave, linha em erro e servidor descartado", async () => {
	const { as, composio, store } = setup({
		probe: async () => {
			throw new Error(`falhou com ${KEY_A}`);
		},
	});
	const app = as("user-a");
	await put(app, KEY_A);
	const res = await connectFlow(app, composio, "user-a");
	assert.equal(res.status, 400);
	assert.ok(!(await res.text()).includes(KEY_A));
	const row = store.rows[0] as Row;
	assert.equal(row.status, "error");
	assert.ok(!String(row.lastError).includes(KEY_A));
	assert.equal(composio.servers.size, 0);
});

test("desconectar o último app derruba o servidor e volta a pending_auth", async () => {
	const { as, composio, store } = setup();
	const app = as("user-a");
	await put(app, KEY_A);
	await connectFlow(app, composio, "user-a");
	assert.equal((store.rows[0] as Row).status, "connected");
	const listed = (await (await app.request("/v1/composio/connections")).json()) as { connections: { id: string }[] };
	assert.equal(listed.connections[0]?.id, "ca_a1");
	assert.equal((await app.request("/v1/composio/connections/ca_a1", { method: "DELETE" })).status, 204);
	const row = store.rows[0] as Row;
	assert.equal(row.status, "pending_auth");
	assert.equal(row.tools.length, 0);
	assert.equal(openSecrets(row.secretsEnc).url, undefined);
	assert.equal(composio.servers.size, 0);
	assert.equal((await app.request("/v1/composio/connections/../x", { method: "DELETE" })).status, 404);
});

test("DELETE /key remove a linha e limpa servidor e contas no Composio", async () => {
	const { as, composio, store } = setup();
	const app = as("user-a");
	await put(app, KEY_A);
	await connectFlow(app, composio, "user-a");
	assert.equal((await app.request("/v1/composio/key", { method: "DELETE" })).status, 204);
	assert.equal(store.rows.length, 0);
	assert.deepEqual(composio.deletedAccounts, ["ca_a1"]);
	assert.equal(composio.servers.size, 0);
	assert.equal((await (await app.request("/v1/composio/status")).json() as { configured: boolean }).configured, false);
	// Idempotente.
	assert.equal((await app.request("/v1/composio/key", { method: "DELETE" })).status, 204);
});

test("chave revogada no Composio: toolkits devolve 422 amigável", async () => {
	const { as } = setup({}, [KEY_A]);
	const app = as("user-a");
	await put(app, KEY_A);
	// A chave passa a ser recusada depois de salva.
	const revoked = setup({}, []);
	await revoked.store.create({ userId: "user-a", secretsEnc: (await import("@workspace/agent-runtime")).sealSecrets({ apiKey: KEY_A }) });
	const res = await revoked.as("user-a").request("/v1/composio/toolkits");
	assert.equal(res.status, 422);
	assert.ok(!(await res.text()).includes(KEY_A));
});

async function startConnect(app: Hono<AuthEnv>, composio: ReturnType<typeof fakeComposio>) {
	await post(app, "/v1/composio/connect", { toolkit: "github" });
	const link = [...composio.calls].reverse().find((call) => call.startsWith("link:")) as string;
	return new URL(link.slice(5)).searchParams.get("state") as string;
}

test("callback: aceita as variantes de query do Composio (connectedAccountId, id, status em maiúsculas, sem status)", async () => {
	const variants = [
		"status=success&connectedAccountId=ca_a1",
		"status=SUCCESS&connected_account_id=ca_a1",
		"status=success&id=ca_a1",
		"connected_account_id=ca_a1",
		"status=success",
	];
	for (const query of variants) {
		const { as, composio, store } = setup({ sleep: async () => undefined });
		const app = as("user-a");
		await put(app, KEY_A);
		const state = await startConnect(app, composio);
		composio.accounts.set(composioUserId("user-a"), [{ id: "ca_a1", toolkit: "github", status: "ACTIVE" }]);
		const res = await app.request(`/v1/composio/callback?state=${encodeURIComponent(state)}&${query}`);
		assert.equal(res.status, 200, query);
		assert.equal((store.rows[0] as Row).status, "connected", query);
	}
});

test("callback: usa o mesmo user_id (HMAC) do link ao verificar a conta", async () => {
	const { as, composio } = setup({ sleep: async () => undefined });
	const app = as("user-a");
	await put(app, KEY_A);
	const res = await connectFlow(app, composio, "user-a", "&connected_account_id=ca_a1");
	assert.equal(res.status, 200);
	assert.deepEqual([...new Set(composio.linkUsers)], [composioUserId("user-a")]);
	assert.ok(composio.listedUsers.length > 0);
	assert.deepEqual([...new Set(composio.listedUsers)], [composioUserId("user-a")]);
});

test("callback: espera INITIATED virar ACTIVE (polling) e conecta", async () => {
	let sleeps = 0;
	const holder: { composio?: ReturnType<typeof fakeComposio> } = {};
	const { as, composio, store } = setup({
		sleep: async () => {
			sleeps += 1;
			if (sleeps === 2) holder.composio?.accounts.set(composioUserId("user-a"), [{ id: "ca_a1", toolkit: "github", status: "ACTIVE" }]);
		},
	});
	holder.composio = composio;
	const app = as("user-a");
	await put(app, KEY_A);
	const state = await startConnect(app, composio);
	composio.accounts.set(composioUserId("user-a"), [{ id: "ca_a1", toolkit: "github", status: "INITIATED" }]);
	const res = await app.request(`/v1/composio/callback?state=${encodeURIComponent(state)}&status=success&connected_account_id=ca_a1`);
	assert.equal(res.status, 200);
	assert.equal(sleeps, 2);
	assert.equal((store.rows[0] as Row).status, "connected");
});

test("callback: conta que nunca fica ACTIVE falha com invalid_response:callback:status", async () => {
	let sleeps = 0;
	const { as, composio } = setup({ sleep: async () => void (sleeps += 1) });
	const app = as("user-a");
	await put(app, KEY_A);
	const state = await startConnect(app, composio);
	composio.accounts.set(composioUserId("user-a"), [{ id: "ca_a1", toolkit: "github", status: "INITIATED" }]);
	const res = await app.request(`/v1/composio/callback?state=${encodeURIComponent(state)}&status=success&connected_account_id=ca_a1`);
	assert.equal(res.status, 400);
	const html = await res.text();
	assert.ok(html.includes("invalid_response:callback:status"));
	assert.ok(html.includes("O Composio não confirmou a conta conectada (callback)."));
	assert.ok(sleeps <= 5, "espera no máximo ~5 s");
});

test("callback: sem nenhuma conta do usuário falha com invalid_response:callback:connected_account_id", async () => {
	const { as, composio } = setup({ sleep: async () => undefined });
	const app = as("user-a");
	await put(app, KEY_A);
	const state = await startConnect(app, composio);
	const res = await app.request(`/v1/composio/callback?state=${encodeURIComponent(state)}&status=success`);
	assert.equal(res.status, 400);
	assert.ok((await res.text()).includes("invalid_response:callback:connected_account_id"));
});

test("callback: resposta inválida do Composio mostra a etapa em pt-BR, sem segredo", async () => {
	const holder: { composio?: ReturnType<typeof fakeComposio> } = {};
	const failing = (apiKey: string) =>
		({
			...(holder.composio as ReturnType<typeof fakeComposio>).createClient(apiKey),
			async createMcpServer() {
				throw new ComposioInvalidResponseError("mcp_create", "id", 200);
			},
		}) as ComposioClient;
	const { as, composio } = setup({ createClient: failing, sleep: async () => undefined });
	holder.composio = composio;
	const app = as("user-a");
	await put(app, KEY_A);
	const res = await connectFlow(app, composio, "user-a", "&connected_account_id=ca_a1");
	assert.equal(res.status, 400);
	const html = await res.text();
	assert.ok(html.includes("invalid_response:mcp_create:id"));
	assert.ok(html.includes("não confirmou a criação do servidor"));
	assert.ok(!html.includes(KEY_A));
});

test("app sem login (no_auth): ativa sem auth config nem link e aparece como conectado", async () => {
	const { as, composio, store } = setup();
	const app = as("user-a");
	await put(app, KEY_A);
	composio.noAuth.add("trello");
	const res = await post(app, "/v1/composio/connect", { toolkit: "trello" });
	assert.equal(res.status, 200);
	assert.deepEqual(await res.json(), { enabled: true, toolCount: 1 });
	assert.deepEqual(composio.authConfigCalls, [], "nenhum auth config criado");
	assert.ok(!composio.calls.some((call) => call.startsWith("link:")), "nenhum link de login");
	assert.deepEqual(composio.serverBodies[0], { name: composio.serverBodies[0]?.name, toolkits: [], noAuthApps: ["trello"] });
	const row = store.rows[0] as Row;
	assert.equal(row.status, "connected");
	assert.deepEqual(openSecrets(row.secretsEnc).noAuthApps, ["trello"]);

	const list = (await (await app.request("/v1/composio/toolkits")).json()) as { items: { slug: string; connected: boolean; noAuth: boolean }[] };
	assert.deepEqual(list.items.map((item) => [item.slug, item.connected, item.noAuth]), [["github", false, false], ["trello", true, true]]);
	const conns = (await (await app.request("/v1/composio/connections")).json()) as { connections: { id: string; toolkit: string; noAuth?: boolean }[] };
	assert.deepEqual(conns.connections, [{ id: "noauth_trello", toolkit: "trello", toolkitName: "Trello", noAuth: true }]);
});

test("Auth_Config_NoAuthApp (303) no auth config cai no caminho sem login", async () => {
	const { as, composio } = setup();
	const app = as("user-a");
	await put(app, KEY_A);
	composio.noAuthOnCreate.add("trello");
	const res = await post(app, "/v1/composio/connect", { toolkit: "trello" });
	assert.equal(res.status, 200);
	assert.deepEqual(await res.json(), { enabled: true, toolCount: 1 });
	assert.deepEqual(composio.authConfigCalls, ["trello"], "tentou o auth config uma vez");
	assert.deepEqual(composio.serverBodies[0]?.noAuthApps, ["trello"]);
	assert.ok(!composio.calls.some((call) => call.startsWith("link:")));
});

test("desativar app sem login recria o servidor sem ele; o app de outro usuário dá 404", async () => {
	const { as, composio, store } = setup();
	const a = as("user-a");
	await put(a, KEY_A);
	composio.noAuth.add("trello");
	await post(a, "/v1/composio/connect", { toolkit: "trello" });
	const b = as("user-b");
	await put(b, KEY_B);
	assert.equal((await b.request("/v1/composio/connections/noauth_trello", { method: "DELETE" })).status, 404);
	assert.equal((await a.request("/v1/composio/connections/noauth_github", { method: "DELETE" })).status, 404);
	assert.equal((await a.request("/v1/composio/connections/noauth_trello", { method: "DELETE" })).status, 204);
	const row = store.rows.find((r) => r.userId === "user-a") as Row;
	assert.equal(row.status, "pending_auth");
	assert.equal(openSecrets(row.secretsEnc).noAuthApps, undefined);
	assert.deepEqual([...composio.servers], []);
});

test("o toolkit meta composio não pode ser conectado", async () => {
	const { as } = setup();
	const app = as("user-a");
	await put(app, KEY_A);
	assert.equal((await post(app, "/v1/composio/connect", { toolkit: "composio" })).status, 404);
});

test("meta-tools do Composio saem das tools gravadas na conexão", async () => {
	const meta: McpToolInfo[] = [
		{ name: "COMPOSIO_REMOTE_BASH_TOOL", inputSchema: { type: "object", properties: {} } },
		{ name: "COMPOSIO_MULTI_EXECUTE_TOOL", inputSchema: { type: "object", properties: {} } },
		...TOOLS,
	];
	const { as, composio, store } = setup({ probe: async () => meta });
	const app = as("user-a");
	await put(app, KEY_A);
	composio.noAuth.add("trello");
	await post(app, "/v1/composio/connect", { toolkit: "trello" });
	assert.deepEqual((store.rows[0] as Row).tools.map((tool) => tool.name), ["GITHUB_LIST_COMMITS"]);
});
