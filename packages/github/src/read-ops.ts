import { listGithubInstallationsForUser, type GithubInstallationRecord } from "@workspace/db";
import { listInstallationRepositories } from "./app/api.js";
import { fetchCompare, type CompareData, type FetchCompareInput } from "./app/compare.js";
import { getGithubToken, getInstallationToken } from "./app/token.js";
import { getGithubConnectionToken } from "./connection-token.js";
import { listBranches, listOpenPulls, listUserRepos, type GithubApiResult, type GithubBranch, type GithubPull, type GithubRepo } from "./client.js";

/**
 * Leituras do GitHub (usuário, repos, PRs, branches, comparação) abstraídas da origem das credenciais: instalação do
 * GitHub App, token nativo do Marketplace (OAuth/PAT) ou, quando quem chama injeta, outra fonte (`fallback`, o Composio
 * do motor antigo). É a mesma leitura que o motor antigo e o v4 usam; o v4 não passa `fallback`.
 */
export type GithubCompareOptions = Pick<FetchCompareInput, "includePatch" | "commitDetails" | "maxCommitDetails">;

export type GithubReadOps = {
	/** `app` = token de instalação do GitHub App; `native` = OAuth/PAT do Marketplace; `composio` = só no motor antigo. */
	source: "native" | "composio" | "app";
	getLogin: () => Promise<GithubApiResult<{ login?: string }>>;
	listRepos: () => Promise<GithubApiResult<GithubRepo[]>>;
	listPulls: (repo: string) => Promise<GithubApiResult<GithubPull[]>>;
	listBranches: (repo: string) => Promise<GithubApiResult<GithubBranch[]>>;
	/** Lista completa (paginada) de commits base...head + estatística de arquivos. */
	compare: (repo: string, base: string, head: string, options?: GithubCompareOptions) => Promise<GithubApiResult<CompareData>>;
};

export const GITHUB_NOT_CONNECTED_ERROR = "Conecte o GitHub no Marketplace ou pelo Composio";
export const GITHUB_REAUTH_ERROR_NATIVE = "Reconecte o GitHub no Marketplace";
export const GITHUB_REAUTH_ERROR_COMPOSIO = "Reconecte o GitHub no Composio";
export const GITHUB_REAUTH_ERROR_APP = "Reinstale o app do GitHub em Conexões";

export function githubReauthMessage(source: GithubReadOps["source"]): string {
	if (source === "app") return GITHUB_REAUTH_ERROR_APP;
	return source === "composio" ? GITHUB_REAUTH_ERROR_COMPOSIO : GITHUB_REAUTH_ERROR_NATIVE;
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

export type AppReadOpsDeps = {
	getInstallationToken?: typeof getInstallationToken;
	listInstallationRepos?: typeof listInstallationRepositories;
};

/**
 * Leituras só com o GitHub App (sem OAuth): repos da(s) instalação(ões) do usuário e token de instalação escopado ao
 * repo em cada chamada.
 */
export function createAppGithubReadOps(installations: GithubInstallationRecord[], deps: AppReadOpsDeps = {}): GithubReadOps {
	const tokenFor = deps.getInstallationToken ?? getInstallationToken;
	const active = installations.filter((i) => !i.suspendedAt);
	const covering = (repo: string): GithubInstallationRecord | undefined =>
		active.find((i) => {
			const key = repo.toLowerCase();
			return i.repositorySelection === "all"
				? i.accountLogin.toLowerCase() === key.split("/")[0]
				: (i.repositories ?? []).some((r) => r.fullName.toLowerCase() === key);
		});
	const noAccess = (repo: string): { error: { status: number; message: string } } => ({
		error: { status: 404, message: `O app do GitHub não está instalado em ${repo}` },
	});
	async function withToken<T>(repo: string, fn: (token: string) => Promise<GithubApiResult<T>>): Promise<GithubApiResult<T>> {
		const inst = covering(repo);
		if (!inst) return noAccess(repo);
		const t = await tokenFor(inst.installationId, { repo });
		if ("error" in t) return { error: { status: t.status === 404 || t.status === 401 ? 401 : t.status, message: t.error } };
		return fn(t.token);
	}
	return {
		source: "app",
		getLogin: async () => ({ data: { login: active[0]?.accountLogin } }),
		async listRepos() {
			const repos: GithubRepo[] = [];
			for (const inst of active) {
				let list = inst.repositories;
				if (!list || inst.repositorySelection === "all") {
					const t = await tokenFor(inst.installationId);
					if ("error" in t) continue;
					const res = await (deps.listInstallationRepos ?? listInstallationRepositories)(t.token);
					if (!res.error) list = res.data;
				}
				for (const r of list ?? []) {
					repos.push({ fullName: r.fullName, private: r.private, defaultBranch: null, pushedAt: null });
				}
			}
			return { data: repos };
		},
		listPulls: (repo) => withToken(repo, (token) => listOpenPulls(token, repo)),
		listBranches: (repo) => withToken(repo, (token) => listBranches(token, repo)),
		compare: (repo, base, head, options) => withToken(repo, (token) => fetchCompare({ token, repo, base, head, ...options })),
	};
}

export type ResolveGithubReadOpsDeps = {
	getToken?: typeof getGithubConnectionToken;
	/** Token preferindo a instalação do app para `repo` (default: `getGithubToken`). */
	getAppToken?: typeof getGithubToken;
	listInstallations?: (userId: string) => Promise<GithubInstallationRecord[]>;
	/** Outra fonte tentada depois do token nativo e antes do app (o motor antigo injeta o Composio). */
	fallback?: (userId: string) => Promise<GithubReadOps | null>;
};

/**
 * Com `repo` coberto pelo GitHub App: token da instalação (escopado ao repo). Senão o nativo (OAuth/PAT do Marketplace);
 * senão `fallback`; por fim, só o app (se o usuário instalou); senão o erro de "conecte o GitHub". Sempre escopado ao
 * `userId` recebido (o dono do run).
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
	const other = await deps.fallback?.(userId);
	if (other) return { ops: other };
	const installs = await (deps.listInstallations ?? listGithubInstallationsForUser)(userId).catch(() => []);
	if (installs.some((i) => !i.suspendedAt)) return { ops: createAppGithubReadOps(installs) };
	return { error: native.error || GITHUB_NOT_CONNECTED_ERROR };
}
