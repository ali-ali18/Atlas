import { Hono } from "hono";
import {
	githubReauthMessage,
	markGithubConnectionAuthFailed,
	resolveGithubReadOps,
	type GithubApiError,
	type GithubBranch,
	type GithubPull,
	type GithubRepo,
	type GithubReadOps,
} from "@workspace/agent-runtime";
import type { Context } from "hono";
import { scopeFor, type AuthEnv } from "../middleware/auth.js";

/**
 * Rotas de apoio ao editor de rotinas (autocomplete de repo/PR/branch pro
 * gatilho GitHub) — usa a conexão GitHub do Marketplace (mesmo token do
 * hook-sync/worker) e, na falta dela, a conta GitHub conectada via Composio.
 * Nunca devolve token/chave pro client.
 */

export type GithubRoutesDeps = {
	resolveOps: (userId: string, options?: { withLogin?: boolean; repo?: string }) => Promise<{ ops: GithubReadOps } | { error: string }>;
	markAuthFailed: typeof markGithubConnectionAuthFailed;
};

export const DEFAULT_GITHUB_ROUTES_DEPS: GithubRoutesDeps = {
	resolveOps: (userId, options) => resolveGithubReadOps(userId, options),
	markAuthFailed: markGithubConnectionAuthFailed,
};

export function createGithubRoutes(deps: GithubRoutesDeps = DEFAULT_GITHUB_ROUTES_DEPS) {
	const app = new Hono<AuthEnv>();

	/** Resolve as ops e roda `fn`; mapeia "não conectado" (409), 401 (409 + reconexão) e demais erros (502). */
	async function withOps<T>(
		c: Context<AuthEnv>,
		fn: (ops: GithubReadOps) => Promise<{ data: T; error?: never } | { data?: never; error: GithubApiError }>,
		toBody: (data: T) => unknown,
		repo?: string,
	) {
		const { userId } = scopeFor(c.get("session"));
		const resolved = await deps.resolveOps(userId, repo ? { repo } : undefined);
		if ("error" in resolved) return c.json({ error: resolved.error }, 409);
		const { ops } = resolved;
		const result = await fn(ops);
		if (result.error) {
			if (result.error.status === 401) {
				if (ops.source === "native") await deps.markAuthFailed(userId);
				return c.json({ error: githubReauthMessage(ops.source) }, 409);
			}
			return c.json({ error: result.error.message }, 502);
		}
		return c.json(toBody(result.data as T));
	}

	app.get("/v1/github/status", async (c) => {
		const { userId } = scopeFor(c.get("session"));
		const resolved = await deps.resolveOps(userId, { withLogin: true });
		if ("error" in resolved) return c.json({ connected: false });
		const { ops } = resolved;
		const who = await ops.getLogin().catch(() => null);
		const login = who && !who.error ? who.data.login : undefined;
		return c.json({ connected: true, login, source: ops.source });
	});

	app.get("/v1/github/repos", async (c) => {
		const q = c.req.query("q")?.trim().toLowerCase();
		return withOps<GithubRepo[]>(
			c,
			(ops) => ops.listRepos(),
			(data) => ({
				repos: (q ? data.filter((repo) => repo.fullName.toLowerCase().includes(q)) : data).map((repo) => ({
					fullName: repo.fullName,
					private: repo.private,
					defaultBranch: repo.defaultBranch,
					pushedAt: repo.pushedAt,
				})),
			}),
		);
	});

	app.get("/v1/github/repos/:owner/:repo/pulls", async (c) => {
		const repo = `${c.req.param("owner")}/${c.req.param("repo")}`;
		return withOps<GithubPull[]>(
			c,
			(ops) => ops.listPulls(repo),
			(data) => ({
				pulls: data.map((pr) => ({
					number: pr.number,
					title: pr.title,
					author: pr.author,
					head: pr.head,
					base: pr.base,
					url: pr.url,
				})),
			}),
			repo,
		);
	});

	app.get("/v1/github/repos/:owner/:repo/branches", async (c) => {
		const repo = `${c.req.param("owner")}/${c.req.param("repo")}`;
		return withOps<GithubBranch[]>(
			c,
			(ops) => ops.listBranches(repo),
			(data) => ({ branches: data.map((branch) => ({ name: branch.name })) }),
		);
	});

	return app;
}
