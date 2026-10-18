import { describe, expect, it, vi } from "vitest";
import type { GithubApiResult, GithubRepoHook, GithubRepoHookFull } from "./client.js";
import { createComposioGithubHookOps, COMPOSIO_GITHUB_HOOK_ACTIONS, type GithubHookOps } from "./hook-ops.js";
import { ensureGithubRepoHook, type EnsureGithubRepoHookDeps } from "./hook-sync.js";
import { createComposioClient } from "../mcp/composio/client.js";

const HOOK_URL = "https://atlas.example/v1/hooks/github";
const SECRET = "wh-secret-super";
const API_KEY = "cmp_key_123";

type Call = { url: string; body: Record<string, unknown> };

/** Composio HTTP mockado: roteia por slug da ação. */
function mockComposio(handlers: Record<string, (args: Record<string, unknown>) => unknown>) {
	const calls: Call[] = [];
	const fetchFn = vi.fn(async (input: URL | string, init?: RequestInit) => {
		const url = String(input);
		const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
		calls.push({ url, body });
		const slug = url.split("/tools/execute/")[1] ?? "";
		const handler = handlers[slug];
		if (!handler) return new Response(JSON.stringify({ error: { slug: "nope" } }), { status: 404 });
		const out = handler(body.arguments as Record<string, unknown>);
		return new Response(JSON.stringify(out), { status: 200 });
	}) as unknown as typeof fetch;
	const client = createComposioClient({ apiKey: API_KEY, fetchFn, warn: () => undefined });
	return { calls, client };
}

function opsFor(client: ReturnType<typeof createComposioClient>): GithubHookOps {
	return createComposioGithubHookOps({
		client,
		composioUser: "atlas_user",
		connectedAccountId: "ca_1",
		redact: [SECRET, API_KEY],
	});
}

function baseDeps(overrides: Partial<EnsureGithubRepoHookDeps>): EnsureGithubRepoHookDeps {
	return {
		getToken: (async () => ({ error: "x" })) as unknown as EnsureGithubRepoHookDeps["getToken"],
		markAuthFailed: (async () => undefined) as EnsureGithubRepoHookDeps["markAuthFailed"],
		listRepoHooks: (async () => ({ data: [] })) as EnsureGithubRepoHookDeps["listRepoHooks"],
		createRepoHook: (async () => ({ data: { id: 1 } })) as EnsureGithubRepoHookDeps["createRepoHook"],
		updateRepoHook: (async () => ({ data: { id: 1 } })) as EnsureGithubRepoHookDeps["updateRepoHook"],
		deleteRepoHook: (async () => ({ data: { ok: true } })) as EnsureGithubRepoHookDeps["deleteRepoHook"],
		listGithubRoutinesForRepoEnabledEvents: async () => ["pull_request"],
		isPublicUrlConfigured: () => true,
		publicHookUrl: () => HOOK_URL,
		webhookSecret: SECRET,
		...overrides,
	};
}

describe("hook-sync via Composio", () => {
	it("cria o webhook com url/secret/events/json/active pela ação do Composio", async () => {
		const { calls, client } = mockComposio({
			[COMPOSIO_GITHUB_HOOK_ACTIONS.list]: () => ({ successful: true, error: null, data: { details: [] } }),
			[COMPOSIO_GITHUB_HOOK_ACTIONS.create]: () => ({ successful: true, error: null, data: { id: 77 } }),
		});
		const result = await ensureGithubRepoHook(
			{ userId: "u1", repo: "acme/site" },
			baseDeps({ getComposioOps: async () => opsFor(client) }),
		);
		expect(result).toEqual({ ok: true });
		const create = calls.find((c) => c.url.endsWith(COMPOSIO_GITHUB_HOOK_ACTIONS.create));
		expect(create?.url).toContain("/api/v3.1/tools/execute/");
		expect(create?.body).toMatchObject({ connected_account_id: "ca_1", user_id: "atlas_user" });
		expect(create?.body.arguments).toEqual({
			owner: "acme",
			repo: "site",
			name: "web",
			active: true,
			events: ["pull_request"],
			config__url: HOOK_URL,
			config__secret: SECRET,
			config__content__type: "json",
		});
	});

	it("atualiza hook existente (legado migrado) e apaga duplicata", async () => {
		const hooks = [
			{ id: 5, config: { url: "https://old.example/v1/hooks/github/abc" }, events: ["push"] },
			{ id: 6, config: { url: HOOK_URL }, events: ["push"] },
			{ id: 7, config: { url: "https://other.example/x" }, events: ["push"] },
		];
		const { calls, client } = mockComposio({
			[COMPOSIO_GITHUB_HOOK_ACTIONS.list]: () => ({ successful: true, error: null, data: JSON.stringify(hooks) }),
			[COMPOSIO_GITHUB_HOOK_ACTIONS.update]: () => ({ successful: true, error: null, data: { id: 5 } }),
			[COMPOSIO_GITHUB_HOOK_ACTIONS.delete]: () => ({ successful: true, error: null, data: {} }),
		});
		const result = await ensureGithubRepoHook(
			{ userId: "u1", repo: "acme/site" },
			baseDeps({ getComposioOps: async () => opsFor(client) }),
		);
		expect(result).toEqual({ ok: true });
		const update = calls.find((c) => c.url.endsWith(COMPOSIO_GITHUB_HOOK_ACTIONS.update));
		expect(update?.body.arguments).toMatchObject({
			owner: "acme",
			repo: "site",
			hook_id: 5,
			events: ["pull_request"],
			config__url: HOOK_URL,
			config__secret: SECRET,
			config__content__type: "json",
		});
		const deletes = calls.filter((c) => c.url.endsWith(COMPOSIO_GITHUB_HOOK_ACTIONS.delete));
		expect(deletes.map((d) => (d.body.arguments as { hook_id: number }).hook_id)).toEqual([6]);
	});

	it("uniao vazia apaga os hooks nossos pelo Composio", async () => {
		const { calls, client } = mockComposio({
			[COMPOSIO_GITHUB_HOOK_ACTIONS.list]: () => ({
				successful: true,
				error: null,
				data: [{ id: 9, config: { url: HOOK_URL }, events: ["push"] }],
			}),
			[COMPOSIO_GITHUB_HOOK_ACTIONS.delete]: () => ({ successful: true, error: null, data: {} }),
		});
		const result = await ensureGithubRepoHook(
			{ userId: "u1", repo: "acme/site" },
			baseDeps({
				listGithubRoutinesForRepoEnabledEvents: async () => [],
				getComposioOps: async () => opsFor(client),
			}),
		);
		expect(result).toEqual({ ok: true });
		expect(calls.some((c) => c.url.endsWith(COMPOSIO_GITHUB_HOOK_ACTIONS.delete))).toBe(true);
		expect(calls.some((c) => c.url.endsWith(COMPOSIO_GITHUB_HOOK_ACTIONS.create))).toBe(false);
	});

	it("conexao nativa vence o Composio quando as duas existem", async () => {
		const composio = vi.fn(async () => null);
		const created: unknown[][] = [];
		const result = await ensureGithubRepoHook(
			{ userId: "u1", repo: "acme/site" },
			baseDeps({
				getToken: (async () => ({ token: "gh", source: "pat" })) as EnsureGithubRepoHookDeps["getToken"],
				createRepoHook: (async (...args: unknown[]) => {
					created.push(args);
					return { data: { id: 1 } } as GithubApiResult<GithubRepoHook>;
				}) as EnsureGithubRepoHookDeps["createRepoHook"],
				getComposioOps: composio,
			}),
		);
		expect(result).toEqual({ ok: true });
		expect(created.length).toBe(1);
		expect(composio).not.toHaveBeenCalled();
	});

	it("sem nativo e sem Composio: erro 'Marketplace ou pelo Composio'", async () => {
		const result = await ensureGithubRepoHook(
			{ userId: "u1", repo: "acme/site" },
			baseDeps({ getComposioOps: async () => null }),
		);
		expect(result).toEqual({ error: "Conecte o GitHub no Marketplace ou pelo Composio" });
	});

	it("erro da acao nao vaza o segredo nem a chave do Composio", async () => {
		const { client } = mockComposio({
			[COMPOSIO_GITHUB_HOOK_ACTIONS.list]: () => ({ successful: true, error: null, data: [] }),
			[COMPOSIO_GITHUB_HOOK_ACTIONS.create]: () => ({
				successful: false,
				data: null,
				error: `Validation failed secret=${SECRET} key=${API_KEY}`,
			}),
		});
		const result = await ensureGithubRepoHook(
			{ userId: "u1", repo: "acme/site" },
			baseDeps({ getComposioOps: async () => opsFor(client) }),
		);
		expect("error" in result).toBe(true);
		const text = JSON.stringify(result);
		expect(text).not.toContain(SECRET);
		expect(text).not.toContain(API_KEY);
	});

	it("403 vira erro de permissao; 401 pede reconectar pelo Composio sem marcar o nativo", async () => {
		const markAuthFailed = vi.fn(async () => undefined);
		const mk = (message: string) =>
			mockComposio({
				[COMPOSIO_GITHUB_HOOK_ACTIONS.list]: () => ({ successful: false, data: null, error: message }),
			}).client;
		const r403 = await ensureGithubRepoHook(
			{ userId: "u1", repo: "acme/site" },
			baseDeps({ getComposioOps: async () => opsFor(mk("403 Forbidden")) }),
		);
		expect(r403).toEqual({ error: "Sem permissão para criar webhook em acme/site (precisa de admin no repositório)" });
		const r401 = await ensureGithubRepoHook(
			{ userId: "u1", repo: "acme/site" },
			baseDeps({
				markAuthFailed: markAuthFailed as unknown as EnsureGithubRepoHookDeps["markAuthFailed"],
				getComposioOps: async () => opsFor(mk("401 Bad credentials")),
			}),
		);
		expect(r401).toEqual({ error: "Reconecte o GitHub no Composio" });
		expect(markAuthFailed).not.toHaveBeenCalled();
	});

	it("ops.list aceita {details: [...]} e mapeia hooks", async () => {
		const { client } = mockComposio({
			[COMPOSIO_GITHUB_HOOK_ACTIONS.list]: () => ({
				successful: true,
				error: null,
				data: { details: [{ id: 3, config: { url: HOOK_URL }, events: ["push"] }] },
			}),
		});
		const res = await opsFor(client).list("acme/site");
		const expected: GithubRepoHookFull[] = [{ id: 3, config: { url: HOOK_URL }, events: ["push"] }];
		expect(res.data).toEqual(expected);
	});
});
