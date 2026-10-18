import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";

/**
 * Cliente REST do GitHub para os gatilhos de rotina (registrar/atualizar/
 * remover webhook do repo, listar repos/PRs/branches, checar CI). Distinto
 * do conector MCP GitHub (que o bot usa como ferramenta) — aqui é só o que a
 * API e o worker precisam pra sincronizar o gatilho v2. Token vem de
 * `getGithubConnectionToken` (github-token.ts); em qualquer 401 o caller deve
 * chamar `markGithubConnectionAuthFailed`.
 */

const GITHUB_API_BASE = "https://api.github.com";
const GITHUB_API_VERSION = "2022-11-28";
const USER_AGENT = "atlas-agent";

export type GithubApiError = {
	/** HTTP status devolvido pelo GitHub (0 = falha de rede/transporte). */
	status: number;
	message: string;
};

export type GithubApiResult<T> = { data: T; error?: never } | { data?: never; error: GithubApiError };

export type GithubClientOptions = {
	fetchFn?: FetchLike;
};

export type GithubRepo = {
	fullName: string;
	private: boolean;
	defaultBranch: string;
	pushedAt: string | null;
};

export type GithubPull = {
	number: number;
	title: string;
	author?: string;
	head: string;
	base: string;
	/** SHA do HEAD do PR (`head.sha`) — usado pelo worker pra consultar check-runs. */
	headSha?: string;
	url?: string;
	merged?: boolean;
	state?: string;
};

export type GithubBranch = {
	name: string;
};

export type GithubRepoHook = {
	id: number;
};

/** Hook completo (usado pelo hook-sync pra achar "o nosso" por `config.url` e diffar `events`). */
export type GithubRepoHookFull = {
	id: number;
	config?: { url?: string };
	events: string[];
};

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

async function githubRequest<T>(
	path: string,
	token: string,
	init: { method?: string; body?: unknown; fetchFn?: FetchLike } = {},
): Promise<GithubApiResult<T>> {
	const fetchFn = init.fetchFn ?? fetch;
	let res: Response;
	try {
		res = await fetchFn(`${GITHUB_API_BASE}${path}`, {
			method: init.method ?? "GET",
			headers: {
				Authorization: `Bearer ${token}`,
				Accept: "application/vnd.github+json",
				"X-GitHub-Api-Version": GITHUB_API_VERSION,
				"User-Agent": USER_AGENT,
				...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
			},
			...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
		});
	} catch (error) {
		return {
			error: {
				status: 0,
				message: error instanceof Error ? error.message : "falha de rede ao chamar a API do GitHub",
			},
		};
	}

	if (res.status === 204) {
		return { data: undefined as T };
	}

	let json: unknown = undefined;
	const text = await res.text().catch(() => "");
	if (text.trim()) {
		try {
			json = JSON.parse(text);
		} catch {
			// resposta não-JSON (raro); segue com json undefined
		}
	}

	if (!res.ok) {
		const message = typeof asRecord(json).message === "string" ? (asRecord(json).message as string) : res.statusText || "erro na API do GitHub";
		return { error: { status: res.status, message } };
	}

	return { data: json as T };
}

function mapRepo(row: unknown): GithubRepo {
	const repo = asRecord(row);
	return {
		fullName: typeof repo.full_name === "string" ? repo.full_name : "",
		private: repo.private === true,
		defaultBranch: typeof repo.default_branch === "string" ? repo.default_branch : "main",
		pushedAt: typeof repo.pushed_at === "string" ? repo.pushed_at : null,
	};
}

function mapPull(row: unknown): GithubPull {
	const pr = asRecord(row);
	const user = asRecord(pr.user);
	const head = asRecord(pr.head);
	const base = asRecord(pr.base);
	return {
		number: typeof pr.number === "number" ? pr.number : 0,
		title: typeof pr.title === "string" ? pr.title : "",
		author: typeof user.login === "string" ? user.login : undefined,
		head: typeof head.ref === "string" ? head.ref : "",
		base: typeof base.ref === "string" ? base.ref : "",
		headSha: typeof head.sha === "string" ? head.sha : undefined,
		url: typeof pr.html_url === "string" ? pr.html_url : undefined,
		merged: typeof pr.merged === "boolean" ? pr.merged : undefined,
		state: typeof pr.state === "string" ? pr.state : undefined,
	};
}

function mapBranch(row: unknown): GithubBranch {
	const branch = asRecord(row);
	return { name: typeof branch.name === "string" ? branch.name : "" };
}

function mapRepoHookFull(row: unknown): GithubRepoHookFull {
	const hook = asRecord(row);
	const config = asRecord(hook.config);
	return {
		id: typeof hook.id === "number" ? hook.id : 0,
		config: { url: typeof config.url === "string" ? config.url : undefined },
		events: Array.isArray(hook.events) ? hook.events.filter((e): e is string => typeof e === "string") : [],
	};
}


/** `GET /user/repos?sort=pushed&per_page=100` — repos do usuário conectado, mais recentes primeiro. */
export async function listUserRepos(
	token: string,
	options: GithubClientOptions = {},
): Promise<GithubApiResult<GithubRepo[]>> {
	const result = await githubRequest<unknown[]>("/user/repos?sort=pushed&per_page=100", token, options);
	if (result.error) return result;
	return { data: (result.data ?? []).map(mapRepo) };
}

/** `GET /repos/{repo}/pulls?state=open` — PRs abertos do repo. */
export async function listOpenPulls(
	token: string,
	repo: string,
	options: GithubClientOptions = {},
): Promise<GithubApiResult<GithubPull[]>> {
	const result = await githubRequest<unknown[]>(
		`/repos/${repo}/pulls?state=open&per_page=100`,
		token,
		options,
	);
	if (result.error) return result;
	return { data: (result.data ?? []).map(mapPull) };
}

/** `GET /repos/{repo}/branches?per_page=100`. */
export async function listBranches(
	token: string,
	repo: string,
	options: GithubClientOptions = {},
): Promise<GithubApiResult<GithubBranch[]>> {
	const result = await githubRequest<unknown[]>(`/repos/${repo}/branches?per_page=100`, token, options);
	if (result.error) return result;
	return { data: (result.data ?? []).map(mapBranch) };
}

/** `GET /repos/{repo}/pulls/{n}` — reaproveitado pelo worker (babá de PR). */
export async function getPull(
	token: string,
	repo: string,
	number: number,
	options: GithubClientOptions = {},
): Promise<GithubApiResult<GithubPull>> {
	const result = await githubRequest<unknown>(`/repos/${repo}/pulls/${number}`, token, options);
	if (result.error) return result;
	return { data: mapPull(result.data) };
}

/** `GET /repos/{repo}/hooks` — lista os webhooks do repo (pra achar "o nosso" por `config.url`). */
export async function listRepoHooks(
	token: string,
	repo: string,
	options: GithubClientOptions = {},
): Promise<GithubApiResult<GithubRepoHookFull[]>> {
	const result = await githubRequest<unknown[]>(`/repos/${repo}/hooks`, token, options);
	if (result.error) return result;
	return { data: (result.data ?? []).map(mapRepoHookFull) };
}

/** `POST /repos/{repo}/hooks` — cria o webhook (content_type sempre "json"). */
export async function createRepoHook(
	token: string,
	repo: string,
	input: { url: string; secret: string; events: string[] },
	options: GithubClientOptions = {},
): Promise<GithubApiResult<GithubRepoHook>> {
	const result = await githubRequest<unknown>(`/repos/${repo}/hooks`, token, {
		...options,
		method: "POST",
		body: {
			name: "web",
			active: true,
			events: input.events,
			config: { url: input.url, content_type: "json", secret: input.secret },
		},
	});
	if (result.error) return result;
	const row = asRecord(result.data);
	return { data: { id: typeof row.id === "number" ? row.id : 0 } };
}

/** `PATCH /repos/{repo}/hooks/{id}` — troca `events` (e opcionalmente `url`/`secret`). */
export async function updateRepoHook(
	token: string,
	repo: string,
	hookId: number,
	input: { events?: string[]; url?: string; secret?: string },
	options: GithubClientOptions = {},
): Promise<GithubApiResult<GithubRepoHook>> {
	const config =
		input.url !== undefined || input.secret !== undefined
			? { config: { url: input.url, content_type: "json", secret: input.secret } }
			: {};
	const result = await githubRequest<unknown>(`/repos/${repo}/hooks/${hookId}`, token, {
		...options,
		method: "PATCH",
		body: { ...(input.events ? { events: input.events } : {}), ...config },
	});
	if (result.error) return result;
	const row = asRecord(result.data);
	return { data: { id: typeof row.id === "number" ? row.id : hookId } };
}

/** `DELETE /repos/{repo}/hooks/{id}` — 404 conta como sucesso (já não existe). */
export async function deleteRepoHook(
	token: string,
	repo: string,
	hookId: number,
	options: GithubClientOptions = {},
): Promise<GithubApiResult<{ ok: true }>> {
	const result = await githubRequest<unknown>(`/repos/${repo}/hooks/${hookId}`, token, {
		...options,
		method: "DELETE",
	});
	if (result.error && result.error.status !== 404) return result;
	return { data: { ok: true } };
}

/**
 * Best-effort: apaga o hook do repo sem nunca lançar (usado ao desabilitar/
 * apagar rotina e na babá de PR fechado — a rotina já vai sumir/desativar de
 * qualquer forma, um 401/403/network error aqui não deve travar o fluxo).
 */
export async function closeGithubHookSafely(
	token: string,
	repo: string,
	hookId: number | undefined,
	options: GithubClientOptions = {},
): Promise<void> {
	if (!hookId) return;
	try {
		await deleteRepoHook(token, repo, hookId, options);
	} catch {
		// nunca derruba o caller — best-effort.
	}
}
