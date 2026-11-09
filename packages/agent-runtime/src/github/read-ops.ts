import { ComposioApiError, type ComposioClient } from "../mcp/composio/client.js";
import { listGithubInstallationsForUser, type GithubInstallationRecord } from "@workspace/db";
import {
	createAppGithubReadOps,
	GITHUB_NOT_CONNECTED_ERROR,
	GITHUB_REAUTH_ERROR_APP,
	GITHUB_REAUTH_ERROR_COMPOSIO,
	GITHUB_REAUTH_ERROR_NATIVE,
	githubReauthMessage,
	type GithubCompareOptions, type GithubReadOps } from "@workspace/github";
import { getGithubConnectionToken } from "../mcp/github-token.js";
import { fetchCompare } from "./app/compare.js";
import { getGithubToken } from "./app/token.js";
import { redactSecrets } from "../mcp/sanitize.js";
import {
	asRecord,
	describeRowsShape,
	extractHookRows,
	getComposioGithubContext,
	statusFromActionError,
	type ComposioGithubContext,
} from "./hook-ops.js";
import {
	listBranches,
	listOpenPulls,
	listUserRepos,
	type GithubApiResult,
	type GithubBranch,
	type GithubPull,
	type GithubRepo,
} from "./client.js";

/**
 * Leituras do GitHub (usuário, repos, PRs, branches) abstraídas da origem das
 * credenciais: token nativo do Marketplace OU conta GitHub via Composio.
 * Nativo vence quando existe (mesmo padrão do hook-ops).
 */
export type { GithubCompareOptions, GithubReadOps };
export { createAppGithubReadOps };

/** Slugs e argumentos conferidos em https://docs.composio.dev/toolkits/github.md. */
export const COMPOSIO_GITHUB_READ_ACTIONS = {
	user: "GITHUB_GET_THE_AUTHENTICATED_USER",
	repos: "GITHUB_LIST_REPOSITORIES_FOR_THE_AUTHENTICATED_USER",
	pulls: "GITHUB_LIST_PULL_REQUESTS",
	branches: "GITHUB_LIST_BRANCHES",
} as const;

export { GITHUB_NOT_CONNECTED_ERROR, GITHUB_REAUTH_ERROR_APP, GITHUB_REAUTH_ERROR_COMPOSIO, GITHUB_REAUTH_ERROR_NATIVE, githubReauthMessage };

const unexpected = (what: string): { error: { status: number; message: string } } => ({
	error: { status: 502, message: `O Composio devolveu ${what} num formato inesperado` },
});

function mapComposioRepo(row: unknown): GithubRepo {
	const repo = asRecord(row);
	return {
		fullName: typeof repo.full_name === "string" ? repo.full_name : "",
		private: repo.private === true,
		defaultBranch: typeof repo.default_branch === "string" ? repo.default_branch : "main",
		pushedAt: typeof repo.pushed_at === "string" ? repo.pushed_at : null,
	};
}

function refOf(value: unknown): string {
	if (typeof value === "string") return value;
	const ref = asRecord(value).ref;
	return typeof ref === "string" ? ref : "";
}

function mapComposioPull(row: unknown): GithubPull {
	const pr = asRecord(row);
	const user = asRecord(pr.user);
	const head = asRecord(pr.head);
	return {
		number: typeof pr.number === "number" ? pr.number : 0,
		title: typeof pr.title === "string" ? pr.title : "",
		author: typeof user.login === "string" ? user.login : undefined,
		head: refOf(pr.head),
		base: refOf(pr.base),
		headSha: typeof head.sha === "string" ? head.sha : undefined,
		url: typeof pr.html_url === "string" ? pr.html_url : undefined,
		state: typeof pr.state === "string" ? pr.state : undefined,
	};
}

function mapComposioBranch(row: unknown): GithubBranch {
	const name = asRecord(row).name;
	return { name: typeof name === "string" ? name : "" };
}

function findLogin(data: unknown, depth = 0): string | undefined {
	if (depth > 3) return undefined;
	if (typeof data === "string") {
		try {
			return findLogin(JSON.parse(data), depth + 1);
		} catch {
			return undefined;
		}
	}
	const record = asRecord(data);
	if (typeof record.login === "string") return record.login;
	for (const key of ["data", "details", "response_data"]) {
		if (key in record) {
			const found = findLogin(record[key], depth + 1);
			if (found) return found;
		}
	}
	return undefined;
}

function splitRepo(repo: string): { owner: string; repo: string } | null {
	const [owner, name, ...rest] = repo.split("/");
	if (!owner || !name || rest.length > 0) return null;
	return { owner, repo: name };
}

export function createComposioGithubReadOps(options: {
	client: Pick<ComposioClient, "executeTool">;
	composioUser: string;
	connectedAccountId: string;
	/** Valores a mascarar em qualquer mensagem de erro (chave do Composio). */
	redact?: string[];
}): GithubReadOps {
	const { client, composioUser, connectedAccountId } = options;
	const redact = (options.redact ?? []).filter(Boolean);

	async function run(slug: string, args: Record<string, unknown>): Promise<GithubApiResult<unknown>> {
		try {
			const result = await client.executeTool({ slug, composioUser, connectedAccountId, arguments: args });
			if (!result.successful) {
				const message = redactSecrets(result.error ?? "Erro ao executar a ação do GitHub no Composio", redact);
				return { error: { status: statusFromActionError(message), message } };
			}
			return { data: result.data };
		} catch (error) {
			const message = redactSecrets(
				error instanceof Error ? error.message : "falha ao falar com o Composio",
				redact,
			);
			// 401 do Composio (chave/conta inválida) → o caller pede "Reconecte o GitHub no Composio".
			const status = error instanceof ComposioApiError ? (error.status > 0 ? error.status : 502) : 0;
			return { error: { status, message } };
		}
	}

	async function paged<T>(
		slug: string,
		args: Record<string, unknown>,
		map: (row: unknown) => T,
		what: string,
		maxPages: number,
	): Promise<GithubApiResult<T[]>> {
		const rows: T[] = [];
		for (let page = 1; page <= maxPages; page += 1) {
			const res = await run(slug, { ...args, per_page: 100, page });
			if (res.error) return res;
			const found = extractHookRows(res.data);
			if (!found) {
				console.warn(`[github-composio] ${slug}: formato inesperado shape=${describeRowsShape(res.data)}`);
				return unexpected(what);
			}
			rows.push(...found.map(map));
			if (found.length < 100) break;
		}
		return { data: rows };
	}

	const invalidRepo = (repo: string): { error: { status: number; message: string } } => ({
		error: { status: 404, message: `Repositório inválido: ${repo}` },
	});

	return {
		source: "composio",
		async getLogin() {
			const res = await run(COMPOSIO_GITHUB_READ_ACTIONS.user, {});
			if (res.error) return res;
			return { data: { login: findLogin(res.data) } };
		},
		listRepos() {
			return paged(COMPOSIO_GITHUB_READ_ACTIONS.repos, { sort: "pushed" }, mapComposioRepo, "a lista de repositórios", 3);
		},
		async listPulls(repo) {
			const t = splitRepo(repo);
			if (!t) return invalidRepo(repo);
			return paged(COMPOSIO_GITHUB_READ_ACTIONS.pulls, { ...t, state: "open" }, mapComposioPull, "a lista de PRs", 1);
		},
		async listBranches(repo) {
			const t = splitRepo(repo);
			if (!t) return invalidRepo(repo);
			return paged(COMPOSIO_GITHUB_READ_ACTIONS.branches, t, mapComposioBranch, "a lista de branches", 1);
		},
		async compare() {
			return {
				error: {
					status: 501,
					message: "A comparação paginada não está disponível pelo Composio; conecte o GitHub no Marketplace ou instale o app do GitHub",
				},
			};
		},
	};
}

export function createNativeGithubReadOps(token: string, login?: string, source: "native" | "app" = "native"): GithubReadOps {
	return {
		source,
		getLogin: async () => ({ data: { login } }),
		listRepos: () => listUserRepos(token),
		listPulls: (repo) => listOpenPulls(token, repo),
		listBranches: (repo) => listBranches(token, repo),
		compare: async (repo, base, head, options) => fetchCompare({ token, repo, base, head, ...options }),
	};
}

export type ResolveGithubReadOpsDeps = {
	getToken?: typeof getGithubConnectionToken;
	getComposioContext?: (userId: string) => Promise<ComposioGithubContext | null>;
	/** Token preferindo a instalação do app para `repo` (default: `getGithubToken`). */
	getAppToken?: typeof getGithubToken;
	listInstallations?: (userId: string) => Promise<GithubInstallationRecord[]>;
};

/**
 * Com `repo` coberto pelo GitHub App: token da instalação (escopado ao repo). Senão o nativo
 * (OAuth/PAT do Marketplace); senão Composio; por fim, só o app (se o usuário instalou); senão o
 * erro de "conecte o GitHub".
 */
export async function resolveGithubReadOps(
	userId: string,
	options: { withLogin?: boolean; repo?: string } = {},
	deps: ResolveGithubReadOpsDeps = {},
): Promise<{ ops: GithubReadOps } | { error: string }> {
	const getNative = deps.getToken ?? getGithubConnectionToken;
	const native = options.repo
		? await (deps.getAppToken ?? getGithubToken)(userId, {
				repo: options.repo,
				withLogin: options.withLogin,
				fallback: (id, o) => getNative(id, o),
			})
		: await getNative(userId, { withLogin: options.withLogin });
	if (!("error" in native)) {
		return { ops: createNativeGithubReadOps(native.token, native.login, native.source === "app" ? "app" : "native") };
	}
	const ctx = await (deps.getComposioContext ?? ((id) => getComposioGithubContext(id)))(userId);
	if (!ctx) {
		const installs = await (deps.listInstallations ?? listGithubInstallationsForUser)(userId).catch(() => []);
		if (installs.some((i) => !i.suspendedAt)) return { ops: createAppGithubReadOps(installs) };
		return { error: native.error || GITHUB_NOT_CONNECTED_ERROR };
	}
	return {
		ops: createComposioGithubReadOps({
			client: ctx.client,
			composioUser: ctx.composioUser,
			connectedAccountId: ctx.connectedAccountId,
			redact: [ctx.apiKey],
		}),
	};
}
