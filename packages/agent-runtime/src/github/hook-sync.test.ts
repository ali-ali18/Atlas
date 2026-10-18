import { describe, expect, it, vi } from "vitest";
import type { GithubApiResult, GithubRepoHook, GithubRepoHookFull } from "./client.js";
import {
	DEFAULT_ENSURE_GITHUB_REPO_HOOK_DEPS,
	ensureGithubRepoHook,
	isOurGithubHookUrl,
	type EnsureGithubRepoHookDeps,
} from "./hook-sync.js";

const HOOK_URL = "https://atlas.example/v1/hooks/github";

function ok<T>(data: T): GithubApiResult<T> {
	return { data };
}

function err<T>(status: number, message = "erro"): GithubApiResult<T> {
	return { error: { status, message } };
}

type Deps = EnsureGithubRepoHookDeps & {
	calls: {
		createRepoHook: unknown[][];
		updateRepoHook: unknown[][];
		deleteRepoHook: unknown[][];
		markAuthFailed: unknown[][];
	};
};

function fakeDeps(overrides: Partial<EnsureGithubRepoHookDeps> = {}): Deps {
	const calls: Deps["calls"] = {
		createRepoHook: [],
		updateRepoHook: [],
		deleteRepoHook: [],
		markAuthFailed: [],
	};
	const deps: Deps = {
		calls,
		isPublicUrlConfigured: () => true,
		publicHookUrl: () => HOOK_URL,
		webhookSecret: "wh-secret",
		getToken: (async () => ({ token: "gh-token", source: "pat" })) as EnsureGithubRepoHookDeps["getToken"],
		markAuthFailed: (async (...args: unknown[]) => {
			calls.markAuthFailed.push(args);
		}) as EnsureGithubRepoHookDeps["markAuthFailed"],
		listRepoHooks: (async () => ok<GithubRepoHookFull[]>([])) as EnsureGithubRepoHookDeps["listRepoHooks"],
		createRepoHook: (async (...args: unknown[]) => {
			calls.createRepoHook.push(args);
			return ok<GithubRepoHook>({ id: 111 });
		}) as EnsureGithubRepoHookDeps["createRepoHook"],
		updateRepoHook: (async (...args: unknown[]) => {
			calls.updateRepoHook.push(args);
			return ok<GithubRepoHook>({ id: 111 });
		}) as EnsureGithubRepoHookDeps["updateRepoHook"],
		deleteRepoHook: (async (...args: unknown[]) => {
			calls.deleteRepoHook.push(args);
			return ok({ ok: true as const });
		}) as EnsureGithubRepoHookDeps["deleteRepoHook"],
		listGithubRoutinesForRepoEnabledEvents: async () => ["pull_request"],
		...overrides,
	};
	return deps;
}

describe("ensureGithubRepoHook", () => {
	it("sem URL pública devolve erro sem chamar o GitHub", async () => {
		const deps = fakeDeps({ isPublicUrlConfigured: () => false });
		const result = await ensureGithubRepoHook({ userId: "u1", repo: "acme/site" }, deps);
		expect(result).toEqual({
			error: "O gatilho do GitHub precisa de uma URL pública (ATLAS_URL ou ATLAS_PUBLIC_URL) para receber o webhook",
		});
		expect(deps.calls.createRepoHook.length).toBe(0);
	});

	it("sem CONNECTOR_ENCRYPTION_KEY (secret derivado indisponível) devolve erro", async () => {
		const deps = fakeDeps({ webhookSecret: undefined });
		const result = await ensureGithubRepoHook({ userId: "u1", repo: "acme/site" }, deps);
		expect(result).toEqual({
			error:
				"Segredo do webhook do GitHub não disponível (CONNECTOR_ENCRYPTION_KEY ausente ou inválida)",
		});
	});

	it("sem conexão GitHub devolve erro pedindo conectar", async () => {
		const deps = fakeDeps({
			getToken: (async () => ({ error: "Conecte o GitHub no Marketplace ou pelo Composio" })) as EnsureGithubRepoHookDeps["getToken"],
		});
		const result = await ensureGithubRepoHook({ userId: "u1", repo: "acme/site" }, deps);
		expect(result).toEqual({ error: "Conecte o GitHub no Marketplace ou pelo Composio" });
	});

	it("sem hook existente e com eventos: cria (POST) com a união de eventos", async () => {
		const deps = fakeDeps({
			listGithubRoutinesForRepoEnabledEvents: async () => ["pull_request", "check_suite"],
		});
		const result = await ensureGithubRepoHook({ userId: "u1", repo: "acme/site" }, deps);
		expect(result).toEqual({ ok: true });
		expect(deps.calls.createRepoHook.length).toBe(1);
		const [token, repo, input] = deps.calls.createRepoHook[0] as [
			string,
			string,
			{ url: string; secret: string; events: string[] },
		];
		expect(token).toBe("gh-token");
		expect(repo).toBe("acme/site");
		expect(input.url).toBe(HOOK_URL);
		expect(input.secret).toBe("wh-secret");
		expect(input.events.sort()).toEqual(["check_suite", "pull_request"]);
		expect(deps.calls.updateRepoHook.length).toBe(0);
	});

	it("com hook existente (achado por config.url): atualiza (PATCH) com a união de eventos", async () => {
		const deps = fakeDeps({
			listRepoHooks: (async () =>
				ok<GithubRepoHookFull[]>([
					{ id: 42, config: { url: HOOK_URL }, events: ["pull_request"] },
				])) as EnsureGithubRepoHookDeps["listRepoHooks"],
			listGithubRoutinesForRepoEnabledEvents: async () => ["pull_request", "issues"],
		});
		const result = await ensureGithubRepoHook({ userId: "u1", repo: "acme/site" }, deps);
		expect(result).toEqual({ ok: true });
		expect(deps.calls.createRepoHook.length).toBe(0);
		expect(deps.calls.updateRepoHook.length).toBe(1);
		const [token, repo, hookId, input] = deps.calls.updateRepoHook[0] as [
			string,
			string,
			number,
			{ events?: string[]; secret?: string },
		];
		expect(token).toBe("gh-token");
		expect(repo).toBe("acme/site");
		expect(hookId).toBe(42);
		expect(input.events?.sort()).toEqual(["issues", "pull_request"]);
		expect(input.secret).toBe("wh-secret");
		expect(input.url).toBe(HOOK_URL);
	});

	it("reconhece hook legado por-rotina (.../v1/hooks/github/<hookKey>) como nosso e migra pra URL+secret atuais", async () => {
		const deps = fakeDeps({
			listRepoHooks: (async () =>
				ok<GithubRepoHookFull[]>([
					{
						id: 99,
						config: { url: "https://old-host.example/v1/hooks/github/abc123" },
						events: ["pull_request"],
					},
				])) as EnsureGithubRepoHookDeps["listRepoHooks"],
			listGithubRoutinesForRepoEnabledEvents: async () => ["pull_request"],
		});
		const result = await ensureGithubRepoHook({ userId: "u1", repo: "acme/site" }, deps);
		expect(result).toEqual({ ok: true });
		expect(deps.calls.createRepoHook.length).toBe(0);
		expect(deps.calls.updateRepoHook.length).toBe(1);
		const [, , hookId, input] = deps.calls.updateRepoHook[0] as [
			string,
			string,
			number,
			{ url?: string; secret?: string },
		];
		expect(hookId).toBe(99);
		expect(input.url).toBe(HOOK_URL);
		expect(input.secret).toBe("wh-secret");
	});

	it("duplicata nossa (URL atual + legada coexistindo): atualiza a primeira e apaga a(s) extra(s)", async () => {
		const deps = fakeDeps({
			listRepoHooks: (async () =>
				ok<GithubRepoHookFull[]>([
					{ id: 1, config: { url: HOOK_URL }, events: ["pull_request"] },
					{
						id: 2,
						config: { url: "https://old-host.example/v1/hooks/github/legacy" },
						events: ["pull_request"],
					},
				])) as EnsureGithubRepoHookDeps["listRepoHooks"],
		});
		const result = await ensureGithubRepoHook({ userId: "u1", repo: "acme/site" }, deps);
		expect(result).toEqual({ ok: true });
		expect(deps.calls.updateRepoHook.length).toBe(1);
		expect(deps.calls.updateRepoHook[0]?.[2]).toBe(1);
		expect(deps.calls.deleteRepoHook.length).toBe(1);
		expect(deps.calls.deleteRepoHook[0]).toEqual(["gh-token", "acme/site", 2]);
	});

	it("união de eventos vazia com hooks nossos duplicados: apaga todos", async () => {
		const deps = fakeDeps({
			listRepoHooks: (async () =>
				ok<GithubRepoHookFull[]>([
					{ id: 1, config: { url: HOOK_URL }, events: ["pull_request"] },
					{
						id: 2,
						config: { url: "https://old-host.example/v1/hooks/github/legacy" },
						events: ["pull_request"],
					},
				])) as EnsureGithubRepoHookDeps["listRepoHooks"],
			listGithubRoutinesForRepoEnabledEvents: async () => [],
		});
		const result = await ensureGithubRepoHook({ userId: "u1", repo: "acme/site" }, deps);
		expect(result).toEqual({ ok: true });
		expect(deps.calls.deleteRepoHook.length).toBe(2);
	});

	it("ignora hooks de outra origem (config.url diferente) — cria um novo", async () => {
		const deps = fakeDeps({
			listRepoHooks: (async () =>
				ok<GithubRepoHookFull[]>([
					{ id: 7, config: { url: "https://outro.example/hook" }, events: ["push"] },
				])) as EnsureGithubRepoHookDeps["listRepoHooks"],
		});
		const result = await ensureGithubRepoHook({ userId: "u1", repo: "acme/site" }, deps);
		expect(result).toEqual({ ok: true });
		expect(deps.calls.createRepoHook.length).toBe(1);
		expect(deps.calls.updateRepoHook.length).toBe(0);
	});

	it("união de eventos vazia + hook existente: apaga o hook", async () => {
		const deps = fakeDeps({
			listRepoHooks: (async () =>
				ok<GithubRepoHookFull[]>([
					{ id: 42, config: { url: HOOK_URL }, events: ["pull_request"] },
				])) as EnsureGithubRepoHookDeps["listRepoHooks"],
			listGithubRoutinesForRepoEnabledEvents: async () => [],
		});
		const result = await ensureGithubRepoHook({ userId: "u1", repo: "acme/site" }, deps);
		expect(result).toEqual({ ok: true });
		expect(deps.calls.deleteRepoHook.length).toBe(1);
		expect(deps.calls.deleteRepoHook[0]).toEqual(["gh-token", "acme/site", 42]);
	});

	it("união de eventos vazia sem hook existente: no-op", async () => {
		const deps = fakeDeps({ listGithubRoutinesForRepoEnabledEvents: async () => [] });
		const result = await ensureGithubRepoHook({ userId: "u1", repo: "acme/site" }, deps);
		expect(result).toEqual({ ok: true });
		expect(deps.calls.deleteRepoHook.length).toBe(0);
		expect(deps.calls.createRepoHook.length).toBe(0);
	});

	it("403 ao criar devolve erro de permissão (precisa admin)", async () => {
		const deps = fakeDeps({
			createRepoHook: (async () => err<GithubRepoHook>(403, "Resource not accessible")) as EnsureGithubRepoHookDeps["createRepoHook"],
		});
		const result = await ensureGithubRepoHook({ userId: "u1", repo: "acme/site" }, deps);
		expect(result).toEqual({
			error: "Sem permissão para criar webhook em acme/site (precisa de admin no repositório)",
		});
	});

	it("404 ao criar também devolve erro de permissão", async () => {
		const deps = fakeDeps({
			createRepoHook: (async () => err<GithubRepoHook>(404, "Not Found")) as EnsureGithubRepoHookDeps["createRepoHook"],
		});
		const result = await ensureGithubRepoHook({ userId: "u1", repo: "acme/site" }, deps);
		expect(result).toEqual({
			error: "Sem permissão para criar webhook em acme/site (precisa de admin no repositório)",
		});
	});

	it("401 ao criar marca a conexão e pede reconexão", async () => {
		const deps = fakeDeps({
			createRepoHook: (async () => err<GithubRepoHook>(401, "Bad credentials")) as EnsureGithubRepoHookDeps["createRepoHook"],
		});
		const result = await ensureGithubRepoHook({ userId: "u1", repo: "acme/site" }, deps);
		expect(result).toEqual({ error: "Reconecte o GitHub no Marketplace" });
		expect(deps.calls.markAuthFailed.length).toBe(1);
		expect(deps.calls.markAuthFailed[0]).toEqual(["u1"]);
	});

	it("isOurGithubHookUrl: reconhece endpoint fixo e legado por-rotina, rejeita outras origens", () => {
		expect(isOurGithubHookUrl(HOOK_URL)).toBe(true);
		expect(isOurGithubHookUrl("https://outro-host.example/v1/hooks/github")).toBe(true);
		expect(isOurGithubHookUrl("https://atlas.example/v1/hooks/github/abc123")).toBe(true);
		expect(isOurGithubHookUrl("https://outro.example/hook")).toBe(false);
		expect(isOurGithubHookUrl(undefined)).toBe(false);
		expect(isOurGithubHookUrl("não é uma url")).toBe(false);
	});

	it("expõe DEFAULT_ENSURE_GITHUB_REPO_HOOK_DEPS com as funções reais", () => {
		expect(typeof DEFAULT_ENSURE_GITHUB_REPO_HOOK_DEPS.publicHookUrl).toBe("function");
		expect(typeof DEFAULT_ENSURE_GITHUB_REPO_HOOK_DEPS.isPublicUrlConfigured).toBe("function");
		expect(typeof DEFAULT_ENSURE_GITHUB_REPO_HOOK_DEPS.listGithubRoutinesForRepoEnabledEvents).toBe("function");
	});
});
