import { describe, expect, it, vi } from "vitest";
import { createComposioClient } from "../mcp/composio/client.js";
import {
	COMPOSIO_GITHUB_READ_ACTIONS as A,
	createComposioGithubReadOps,
	resolveGithubReadOps,
	githubReauthMessage,
	type ResolveGithubReadOpsDeps,
} from "./read-ops.js";

const API_KEY = "cmp_key_secret_123";

function mockComposio(handlers: Record<string, (args: Record<string, unknown>) => { status?: number; body: unknown }>) {
	const calls: Array<{ slug: string; args: Record<string, unknown> }> = [];
	const fetchFn = vi.fn(async (input: URL | string, init?: RequestInit) => {
		const url = String(input);
		const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
		const slug = url.split("/tools/execute/")[1] ?? "";
		calls.push({ slug, args: body.arguments as Record<string, unknown> });
		const out = handlers[slug]?.(body.arguments as Record<string, unknown>) ?? { status: 404, body: {} };
		return new Response(JSON.stringify(out.body), { status: out.status ?? 200 });
	}) as unknown as typeof fetch;
	return { calls, client: createComposioClient({ apiKey: API_KEY, fetchFn, warn: () => undefined }) };
}

const ok = (data: unknown) => ({ body: { successful: true, error: null, data } });

function opsFor(client: ReturnType<typeof createComposioClient>) {
	return createComposioGithubReadOps({ client, composioUser: "u", connectedAccountId: "ca_1", redact: [API_KEY] });
}

describe("Composio GithubReadOps", () => {
	it("login do usuário autenticado (data embrulhado)", async () => {
		const { client, calls } = mockComposio({ [A.user]: () => ok({ details: { login: "octocat" } }) });
		const res = await opsFor(client).getLogin();
		expect(res).toEqual({ data: { login: "octocat" } });
		expect(calls[0]?.slug).toBe("GITHUB_GET_THE_AUTHENTICATED_USER");
	});

	it("lista repos: array puro, embrulhado e string JSON", async () => {
		const row = { full_name: "acme/site", private: true, default_branch: "dev", pushed_at: "2026-01-01T00:00:00Z" };
		for (const data of [[row], { details: [row] }, { response_data: [row] }, JSON.stringify([row])]) {
			const { client, calls } = mockComposio({ [A.repos]: () => ok(data) });
			const res = await opsFor(client).listRepos();
			expect(res).toEqual({
				data: [{ fullName: "acme/site", private: true, defaultBranch: "dev", pushedAt: "2026-01-01T00:00:00Z" }],
			});
			expect(calls[0]?.args).toMatchObject({ sort: "pushed", per_page: 100, page: 1 });
		}
	});

	it("lista PRs abertos com owner/repo/state", async () => {
		const { client, calls } = mockComposio({
			[A.pulls]: () =>
				ok({
					details: [
						{ number: 5, title: "Fix", user: { login: "bob" }, head: { ref: "feat", sha: "abc" }, base: { ref: "main" }, html_url: "https://github.com/acme/site/pull/5" },
					],
				}),
		});
		const res = await opsFor(client).listPulls("acme/site");
		expect(res.data?.[0]).toMatchObject({ number: 5, title: "Fix", author: "bob", head: "feat", base: "main", headSha: "abc" });
		expect(calls[0]?.args).toMatchObject({ owner: "acme", repo: "site", state: "open" });
		expect(calls[0]?.slug).toBe("GITHUB_LIST_PULL_REQUESTS");
	});

	it("lista branches", async () => {
		const { client, calls } = mockComposio({ [A.branches]: () => ok([{ name: "main" }, { name: "dev" }]) });
		const res = await opsFor(client).listBranches("acme/site");
		expect(res).toEqual({ data: [{ name: "main" }, { name: "dev" }] });
		expect(calls[0]?.slug).toBe("GITHUB_LIST_BRANCHES");
		expect(calls[0]?.args).toMatchObject({ owner: "acme", repo: "site" });
	});

	it("formato inesperado devolve erro claro", async () => {
		const { client } = mockComposio({ [A.branches]: () => ok({ foo: 1 }) });
		const res = await opsFor(client).listBranches("acme/site");
		expect(res.error?.status).toBe(502);
		expect(res.error?.message).toContain("formato inesperado");
	});

	it("repo inválido não chama o Composio", async () => {
		const { client, calls } = mockComposio({});
		const res = await opsFor(client).listPulls("semBarra");
		expect(res.error?.status).toBe(404);
		expect(calls).toHaveLength(0);
	});

	it("401 do Composio vira status 401 (reconexão) e não vaza a chave", async () => {
		const { client } = mockComposio({
			[A.repos]: () => ({ status: 401, body: { error: { message: `bad key ${API_KEY}` } } }),
		});
		const ops = opsFor(client);
		const res = await ops.listRepos();
		expect(res.error?.status).toBe(401);
		expect(JSON.stringify(res)).not.toContain(API_KEY);
		expect(githubReauthMessage(ops.source)).toBe("Reconecte o GitHub no Composio");
	});

	it("erro da ação mascara a chave", async () => {
		const { client } = mockComposio({
			[A.repos]: () => ({ body: { successful: false, error: `Bad credentials ${API_KEY}`, data: null } }),
		});
		const res = await opsFor(client).listRepos();
		expect(res.error?.status).toBe(401);
		expect(JSON.stringify(res)).not.toContain(API_KEY);
	});
});

describe("resolveGithubReadOps", () => {
	const nativeOk = (async () => ({ token: "gh-native", login: "native-user", source: "pat" })) as unknown as NonNullable<ResolveGithubReadOpsDeps["getToken"]>;
	const nativeNone = (async () => ({ error: "Conecte o GitHub no Marketplace ou pelo Composio" })) as unknown as NonNullable<ResolveGithubReadOpsDeps["getToken"]>;

	it("nativo preferido (Composio nem é consultado)", async () => {
		const getComposioContext = vi.fn(async () => null);
		const res = await resolveGithubReadOps("u", {}, { getToken: nativeOk, getComposioContext });
		expect("ops" in res && res.ops.source).toBe("native");
		expect(getComposioContext).not.toHaveBeenCalled();
		if ("ops" in res) expect(await res.ops.getLogin()).toEqual({ data: { login: "native-user" } });
	});

	it("fallback Composio quando não há nativo", async () => {
		const { client, calls } = mockComposio({ [A.branches]: () => ok([{ name: "main" }]) });
		const res = await resolveGithubReadOps("u", {}, {
			getToken: nativeNone,
			getComposioContext: async () => ({ client, composioUser: "u", connectedAccountId: "ca_1", apiKey: API_KEY }),
		});
		expect("ops" in res && res.ops.source).toBe("composio");
		if ("ops" in res) expect((await res.ops.listBranches("a/b")).data).toEqual([{ name: "main" }]);
		expect(calls).toHaveLength(1);
	});

	it("nenhum disponível devolve o erro existente", async () => {
		const res = await resolveGithubReadOps("u", {}, { getToken: nativeNone, getComposioContext: async () => null });
		expect(res).toEqual({ error: "Conecte o GitHub no Marketplace ou pelo Composio" });
	});
});
