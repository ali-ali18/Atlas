import { findCoveringGithubInstallation } from "@workspace/db";
import { getGithubConnectionToken, type GithubConnectionTokenResult } from "../../mcp/github-token.js";
import { createInstallationAccessToken, type FetchFn } from "./api.js";
import { loadGithubAppCredentials, type GithubAppCredentials } from "./credentials.js";

/** Renova o token de instalação quando faltam menos de 5 min para expirar. */
export const INSTALLATION_TOKEN_REFRESH_MARGIN_MS = 5 * 60_000;

type CachedToken = { token: string; expiresAt: number };

export type InstallationTokenDeps = {
	loadCredentials?: () => Promise<GithubAppCredentials | null>;
	fetchFn?: FetchFn;
	now?: () => number;
};

const cache = new Map<string, CachedToken>();
const inflight = new Map<string, Promise<InstallationTokenResult>>();

export type InstallationTokenResult = { token: string; expiresAt: number } | { error: string; status: number };

export function clearInstallationTokenCache(): void {
	cache.clear();
	inflight.clear();
}

/** Remove o token em cache de uma instalação (apagada/suspensa). */
export function forgetInstallationTokens(installationId: string): void {
	for (const key of cache.keys()) if (key.startsWith(`${installationId}:`)) cache.delete(key);
}

function repoName(repo: string): string | undefined {
	const [owner, name, ...rest] = repo.split("/");
	return owner && name && rest.length === 0 ? name : undefined;
}

/**
 * Token de acesso da instalação (cacheado até ~5 min antes de expirar). `repo` ("owner/name")
 * limita o token a esse repositório; sem ele o token cobre tudo que a instalação enxerga.
 */
export async function getInstallationToken(
	installationId: string,
	options: { repo?: string } & InstallationTokenDeps = {},
): Promise<InstallationTokenResult> {
	const now = options.now ?? Date.now;
	const name = options.repo ? repoName(options.repo) : undefined;
	const key = `${installationId}:${name?.toLowerCase() ?? "*"}`;
	const hit = cache.get(key);
	if (hit && hit.expiresAt - now() > INSTALLATION_TOKEN_REFRESH_MARGIN_MS) return hit;
	const pending = inflight.get(key);
	if (pending) return pending;
	const run = (async (): Promise<InstallationTokenResult> => {
		const creds = await (options.loadCredentials ?? (() => loadGithubAppCredentials()))();
		if (!creds) return { error: "GitHub App não configurado", status: 503 };
		const res = await createInstallationAccessToken(creds, installationId, {
			repositories: name ? [name] : undefined,
			fetchFn: options.fetchFn,
			now: options.now,
		});
		if (res.error) {
			cache.delete(key);
			return { error: res.error.message, status: res.error.status };
		}
		cache.set(key, res.data);
		return res.data;
	})().finally(() => inflight.delete(key));
	inflight.set(key, run);
	return run;
}

export type GithubTokenSource = "app" | "pat" | "oauth";
export type GithubTokenOk = { token: string; login?: string; source: GithubTokenSource; installationId?: string };
export type GithubTokenResult = GithubTokenOk | { error: string };

export type GetGithubTokenDeps = InstallationTokenDeps & {
	findInstallation?: typeof findCoveringGithubInstallation;
	fallback?: (userId: string, options: { withLogin?: boolean }) => Promise<GithubConnectionTokenResult>;
};

/**
 * Token do GitHub para o usuário. Com `repo` coberto por uma instalação do app, usa o token da
 * instalação (escopado a esse repo); senão cai no token pessoal (OAuth/PAT do Marketplace).
 * O Composio é o último recurso e fica a cargo de quem chama (`resolveGithubReadOps`).
 */
export async function getGithubToken(
	userId: string,
	options: { repo?: string; withLogin?: boolean } & GetGithubTokenDeps = {},
): Promise<GithubTokenResult> {
	if (options.repo) {
		const inst = await (options.findInstallation ?? findCoveringGithubInstallation)(userId, options.repo).catch(() => null);
		if (inst) {
			const res = await getInstallationToken(inst.installationId, {
				repo: options.repo,
				loadCredentials: options.loadCredentials,
				fetchFn: options.fetchFn,
				now: options.now,
			});
			if (!("error" in res)) {
				return { token: res.token, login: inst.accountLogin, source: "app", installationId: inst.installationId };
			}
			// instalação inválida (apagada/suspensa no GitHub): segue pro token pessoal
		}
	}
	const fallback = options.fallback ?? ((id, opts) => getGithubConnectionToken(id, opts));
	const personal = await fallback(userId, { withLogin: options.withLogin });
	return personal;
}
