import { describe, expect, it, vi } from "vitest";
import {
	closeGithubHookSafely,
	createRepoHook,
	deleteRepoHook,
	getPull,
	listBranches,
	listOpenPulls,
	listRepoHooks,
	listUserRepos,
	updateRepoHook,
	type GithubClientOptions,
} from "./client.js";

const TOKEN = "ghp_test_token";

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function emptyResponse(status: number): Response {
	return new Response(null, { status });
}

function fetchFnFor(handler: (input: string | URL, init?: RequestInit) => Promise<Response> | Response): GithubClientOptions {
	return { fetchFn: vi.fn(handler) as unknown as GithubClientOptions["fetchFn"] };
}

describe("cliente REST do GitHub", () => {
	it("listUserRepos: monta a URL e mapeia os campos", async () => {
		const fetchFn = vi.fn(async (input: string | URL) => {
			expect(String(input)).toBe("https://api.github.com/user/repos?sort=pushed&per_page=100");
			return jsonResponse([
				{ full_name: "acme/site", private: false, default_branch: "main", pushed_at: "2026-01-01T00:00:00Z" },
			]);
		});
		const result = await listUserRepos(TOKEN, { fetchFn: fetchFn as unknown as GithubClientOptions["fetchFn"] });
		expect(result.error).toBeUndefined();
		expect(result.data).toEqual([
			{ fullName: "acme/site", private: false, defaultBranch: "main", pushedAt: "2026-01-01T00:00:00Z" },
		]);
		const [, init] = fetchFn.mock.calls[0] as [string, RequestInit];
		expect(init.headers).toMatchObject({
			Authorization: `Bearer ${TOKEN}`,
			Accept: "application/vnd.github+json",
			"X-GitHub-Api-Version": "2022-11-28",
			"User-Agent": "atlas-agent",
		});
	});

	it("listOpenPulls: filtra state=open e mapeia autor/head/base", async () => {
		const options = fetchFnFor(async (input) => {
			expect(String(input)).toContain("state=open");
			return jsonResponse([
				{
					number: 42,
					title: "fix",
					user: { login: "alisson" },
					head: { ref: "fix-branch" },
					base: { ref: "main" },
					html_url: "https://github.com/acme/site/pull/42",
					merged: false,
					state: "open",
				},
			]);
		});
		const result = await listOpenPulls(TOKEN, "acme/site", options);
		expect(result.data).toEqual([
			{
				number: 42,
				title: "fix",
				author: "alisson",
				head: "fix-branch",
				base: "main",
				url: "https://github.com/acme/site/pull/42",
				merged: false,
				state: "open",
			},
		]);
	});

	it("listBranches: mapeia só o nome", async () => {
		const options = fetchFnFor(async () => jsonResponse([{ name: "main" }, { name: "dev" }]));
		const result = await listBranches(TOKEN, "acme/site", options);
		expect(result.data).toEqual([{ name: "main" }, { name: "dev" }]);
	});

	it("getPull: busca um PR específico", async () => {
		const options = fetchFnFor(async (input) => {
			expect(String(input)).toBe("https://api.github.com/repos/acme/site/pulls/7");
			return jsonResponse({ number: 7, title: "t", head: { ref: "h" }, base: { ref: "b" } });
		});
		const result = await getPull(TOKEN, "acme/site", 7, options);
		expect(result.data?.number).toBe(7);
	});

	it("createRepoHook: POST com content_type json e devolve o id", async () => {
		const options = fetchFnFor(async (input, init) => {
			expect(String(input)).toBe("https://api.github.com/repos/acme/site/hooks");
			expect(init?.method).toBe("POST");
			const body = JSON.parse(String(init?.body));
			expect(body).toEqual({
				name: "web",
				active: true,
				events: ["pull_request"],
				config: { url: "https://atlas.example/v1/hooks/github/hk1", content_type: "json", secret: "s3cr3t" },
			});
			return jsonResponse({ id: 999 }, 201);
		});
		const result = await createRepoHook(
			TOKEN,
			"acme/site",
			{ url: "https://atlas.example/v1/hooks/github/hk1", secret: "s3cr3t", events: ["pull_request"] },
			options,
		);
		expect(result.data).toEqual({ id: 999 });
	});

	it("updateRepoHook: PATCH só com events quando url/secret não mudam", async () => {
		const options = fetchFnFor(async (input, init) => {
			expect(String(input)).toBe("https://api.github.com/repos/acme/site/hooks/999");
			expect(init?.method).toBe("PATCH");
			expect(JSON.parse(String(init?.body))).toEqual({ events: ["push"] });
			return jsonResponse({ id: 999 });
		});
		const result = await updateRepoHook(TOKEN, "acme/site", 999, { events: ["push"] }, options);
		expect(result.data).toEqual({ id: 999 });
	});

	it("deleteRepoHook: 204 conta como sucesso", async () => {
		const options = fetchFnFor(async () => emptyResponse(204));
		const result = await deleteRepoHook(TOKEN, "acme/site", 999, options);
		expect(result.data).toEqual({ ok: true });
	});

	it("deleteRepoHook: 404 também conta como sucesso (já não existe)", async () => {
		const options = fetchFnFor(async () => jsonResponse({ message: "Not Found" }, 404));
		const result = await deleteRepoHook(TOKEN, "acme/site", 999, options);
		expect(result.data).toEqual({ ok: true });
	});

	it("erro 401 devolve status + message pro caller decidir markGithubConnectionAuthFailed", async () => {
		const options = fetchFnFor(async () => jsonResponse({ message: "Bad credentials" }, 401));
		const result = await listUserRepos(TOKEN, options);
		expect(result.data).toBeUndefined();
		expect(result.error).toEqual({ status: 401, message: "Bad credentials" });
	});

	it("erro 403 (sem permissão de webhook) devolve status 403", async () => {
		const options = fetchFnFor(async () => jsonResponse({ message: "Resource not accessible" }, 403));
		const result = await createRepoHook(
			TOKEN,
			"acme/site",
			{ url: "https://x", secret: "s", events: ["push"] },
			options,
		);
		expect(result.error?.status).toBe(403);
	});

	it("falha de rede devolve status 0, nunca lança", async () => {
		const options: GithubClientOptions = {
			fetchFn: vi.fn(async () => {
				throw new Error("network down");
			}) as unknown as GithubClientOptions["fetchFn"],
		};
		const result = await listUserRepos(TOKEN, options);
		expect(result.error).toEqual({ status: 0, message: "network down" });
	});

	it("listRepoHooks: mapeia id/config.url/events", async () => {
		const options = fetchFnFor(async (input, init) => {
			expect(String(input)).toBe("https://api.github.com/repos/acme/site/hooks");
			expect(init?.method ?? "GET").toBe("GET");
			return jsonResponse([
				{
					id: 42,
					events: ["pull_request", "check_suite"],
					config: { url: "https://atlas.example/v1/hooks/github", content_type: "json" },
				},
			]);
		});
		const result = await listRepoHooks(TOKEN, "acme/site", options);
		expect(result.data).toEqual([
			{ id: 42, config: { url: "https://atlas.example/v1/hooks/github" }, events: ["pull_request", "check_suite"] },
		]);
	});

	it("listRepoHooks: propaga erro (ex.: 404 sem permissão de admin)", async () => {
		const options = fetchFnFor(async () => jsonResponse({ message: "Not Found" }, 404));
		const result = await listRepoHooks(TOKEN, "acme/site", options);
		expect(result.error?.status).toBe(404);
	});

	it("closeGithubHookSafely: sem hookId não chama fetch", async () => {
		const fetchFn = vi.fn();
		await closeGithubHookSafely(TOKEN, "acme/site", undefined, {
			fetchFn: fetchFn as unknown as GithubClientOptions["fetchFn"],
		});
		expect(fetchFn).not.toHaveBeenCalled();
	});

	it("closeGithubHookSafely: nunca lança mesmo com erro", async () => {
		const options = fetchFnFor(async () => jsonResponse({ message: "boom" }, 500));
		await expect(closeGithubHookSafely(TOKEN, "acme/site", 5, options)).resolves.toBeUndefined();
	});
});
