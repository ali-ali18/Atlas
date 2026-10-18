import assert from "node:assert/strict";
import { test } from "node:test";
import { Hono } from "hono";
import type { GithubReadOps } from "@workspace/agent-runtime";
import { createGithubRoutes, type GithubRoutesDeps } from "./github.js";
import type { AuthEnv } from "../middleware/auth.js";

type Deps = GithubRoutesDeps & { calls: { markAuthFailed: unknown[][] } };

const NOT_CONNECTED = "Conecte o GitHub no Marketplace ou pelo Composio";
const SECRET = "gh-token-secret";

/**
 * Monta um app "externo" que injeta a sessão (como o middleware requireUser
 * faria em produção) antes de delegar pro app do GitHub.
 */
function withSession(app: Hono<AuthEnv>, userId: string) {
	const outer = new Hono<AuthEnv>();
	outer.use("*", async (c, next) => {
		c.set("session", { user: { id: userId } } as AuthEnv["Variables"]["session"]);
		await next();
	});
	outer.route("/", app);
	return outer;
}

function fakeOps(source: GithubReadOps["source"], overrides: Partial<GithubReadOps> = {}): GithubReadOps {
	return {
		source,
		getLogin: async () => ({ data: { login: "octocat" } }),
		listRepos: async () => ({ data: [] }),
		listPulls: async () => ({ data: [] }),
		listBranches: async () => ({ data: [] }),
		compare: async () => ({ error: { status: 501, message: "indisponível" } }),
		...overrides,
	};
}

function fakeDeps(ops: GithubReadOps | null): Deps {
	const calls: Deps["calls"] = { markAuthFailed: [] };
	return {
		calls,
		resolveOps: async () => (ops ? { ops } : { error: NOT_CONNECTED }),
		markAuthFailed: (async (...args: unknown[]) => {
			calls.markAuthFailed.push(args);
		}) as GithubRoutesDeps["markAuthFailed"],
	};
}

test("GET /v1/github/status sem conexão devolve connected:false (200)", async () => {
	const app = withSession(createGithubRoutes(fakeDeps(null)), "user-1");
	const res = await app.request("/v1/github/status");
	assert.equal(res.status, 200);
	assert.deepEqual(await res.json(), { connected: false });
});

test("GET /v1/github/status nativo devolve login/source native", async () => {
	const app = withSession(createGithubRoutes(fakeDeps(fakeOps("native"))), "user-1");
	const res = await app.request("/v1/github/status");
	assert.deepEqual(await res.json(), { connected: true, login: "octocat", source: "native" });
});

test("GET /v1/github/status só com Composio devolve connected:true source composio", async () => {
	const app = withSession(createGithubRoutes(fakeDeps(fakeOps("composio"))), "user-1");
	const res = await app.request("/v1/github/status");
	assert.deepEqual(await res.json(), { connected: true, login: "octocat", source: "composio" });
});

test("GET /v1/github/status Composio sem conseguir o login continua conectado", async () => {
	const ops = fakeOps("composio", { getLogin: async () => ({ error: { status: 502, message: "x" } }) });
	const app = withSession(createGithubRoutes(fakeDeps(ops)), "user-1");
	const body = (await (await app.request("/v1/github/status")).json()) as Record<string, unknown>;
	assert.equal(body.connected, true);
	assert.equal(body.source, "composio");
	assert.equal(body.login, undefined);
});

for (const path of ["/v1/github/repos", "/v1/github/repos/acme/site/pulls", "/v1/github/repos/acme/site/branches"]) {
	test(`GET ${path} sem conexão devolve 409`, async () => {
		const app = withSession(createGithubRoutes(fakeDeps(null)), "user-1");
		const res = await app.request(path);
		assert.equal(res.status, 409);
		assert.deepEqual(await res.json(), { error: NOT_CONNECTED });
	});
}

test("GET /v1/github/repos filtra por q e nunca devolve o token", async () => {
	const ops = fakeOps("native", {
		listRepos: async () => ({
			data: [
				{ fullName: "acme/site", private: false, defaultBranch: "main", pushedAt: "2026-01-01T00:00:00Z" },
				{ fullName: "acme/other", private: true, defaultBranch: "main", pushedAt: null },
			],
		}),
	});
	const app = withSession(createGithubRoutes(fakeDeps(ops)), "user-1");
	const res = await app.request("/v1/github/repos?q=site");
	assert.equal(res.status, 200);
	const body = (await res.json()) as { repos: Array<{ fullName: string }> };
	assert.equal(body.repos.length, 1);
	assert.equal(body.repos[0]?.fullName, "acme/site");
	assert.ok(!JSON.stringify(body).includes(SECRET));
});

test("Composio: repos, pulls e branches funcionam pelo fallback", async () => {
	const ops = fakeOps("composio", {
		listRepos: async () => ({ data: [{ fullName: "acme/site", private: false, defaultBranch: "main", pushedAt: null }] }),
		listPulls: async () => ({ data: [{ number: 3, title: "T", author: "bob", head: "f", base: "main", url: "u" }] }),
		listBranches: async () => ({ data: [{ name: "main" }] }),
	});
	const app = withSession(createGithubRoutes(fakeDeps(ops)), "user-1");
	const repos = (await (await app.request("/v1/github/repos")).json()) as { repos: unknown[] };
	assert.equal(repos.repos.length, 1);
	const pulls = (await (await app.request("/v1/github/repos/acme/site/pulls")).json()) as { pulls: Array<{ number: number }> };
	assert.equal(pulls.pulls[0]?.number, 3);
	const branches = await (await app.request("/v1/github/repos/acme/site/branches")).json();
	assert.deepEqual(branches, { branches: [{ name: "main" }] });
});

test("401 nativo marca a conexão e devolve 409 pedindo reconexão no Marketplace", async () => {
	const ops = fakeOps("native", { listRepos: async () => ({ error: { status: 401, message: "Bad credentials" } }) });
	const deps = fakeDeps(ops);
	const app = withSession(createGithubRoutes(deps), "user-1");
	const res = await app.request("/v1/github/repos");
	assert.equal(res.status, 409);
	assert.deepEqual(await res.json(), { error: "Reconecte o GitHub no Marketplace" });
	assert.equal(deps.calls.markAuthFailed.length, 1);
});

test("401 via Composio devolve 409 'Reconecte o GitHub no Composio' sem marcar o nativo", async () => {
	const ops = fakeOps("composio", { listBranches: async () => ({ error: { status: 401, message: "unauthorized" } }) });
	const deps = fakeDeps(ops);
	const app = withSession(createGithubRoutes(deps), "user-1");
	const res = await app.request("/v1/github/repos/acme/site/branches");
	assert.equal(res.status, 409);
	assert.deepEqual(await res.json(), { error: "Reconecte o GitHub no Composio" });
	assert.equal(deps.calls.markAuthFailed.length, 0);
});

test("erro genérico da API do GitHub devolve 502 com a mensagem", async () => {
	const ops = fakeOps("native", { listBranches: async () => ({ error: { status: 500, message: "boom" } }) });
	const app = withSession(createGithubRoutes(fakeDeps(ops)), "user-1");
	const res = await app.request("/v1/github/repos/acme/site/branches");
	assert.equal(res.status, 502);
	assert.deepEqual(await res.json(), { error: "boom" });
});
