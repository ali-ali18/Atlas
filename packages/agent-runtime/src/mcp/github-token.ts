import {
	discoverAuthorizationServerMetadata,
	refreshAuthorization,
	UnauthorizedError,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { getMcpCatalogEntry } from "@workspace/shared";
import { getMcpConnectionByCatalogId } from "@workspace/db";
import { persistTo, resolveMcpOAuthClient } from "./oauth-provider.js";
import { markMcpConnectionAuthFailed } from "./runtime.js";
import { openSecrets, type McpConnectorSecrets, type McpOAuthSecrets } from "./secret-box.js";

/**
 * Reaproveita a conexão GitHub do Marketplace (MCP) como token para os
 * gatilhos de rotina — não pedimos um PAT/OAuth separado só pra webhooks.
 */

const GITHUB_CATALOG_ID = "github";
/** Endpoint de token do OAuth App do GitHub (renovação quando há `refresh_token` + `expires_in`). */
const GITHUB_AUTHORIZATION_SERVER = "https://github.com/login/oauth";
const NOT_CONNECTED_ERROR = "Conecte o GitHub no Marketplace ou pelo Composio";
const AUTH_FAILED_ERROR = "Reconecte o GitHub no Marketplace";

export type GithubConnectionToken = {
	token: string;
	login?: string;
	source: "pat" | "oauth";
};

export type GithubConnectionTokenResult = GithubConnectionToken | { error: string };

/** Token de acesso ainda válido, ou `true` se não sabemos a validade (sem `expires_in` — caso comum de OAuth App clássico do GitHub). */
function githubOAuthTokenIsFresh(tokens: OAuthTokens, savedAt: number | undefined): boolean {
	const expiresIn = tokens.expires_in;
	if (expiresIn == null) return true;
	const ageMs = Date.now() - (savedAt ?? 0);
	const marginMs = 60_000;
	return ageMs < expiresIn * 1000 - marginMs;
}

/** Renova o access token via `refresh_token`, no mesmo padrão de `getFreshAccessToken` (oauth-provider.ts). */
async function refreshGithubOAuthToken(input: {
	secrets: McpConnectorSecrets;
	oauth: McpOAuthSecrets;
	tokens: OAuthTokens;
	persist: (secrets: McpConnectorSecrets) => Promise<void>;
	fetchFn?: FetchLike;
}): Promise<string> {
	const { secrets, oauth, tokens, persist, fetchFn } = input;
	if (!tokens.refresh_token) {
		throw new UnauthorizedError("token expirado sem refresh_token: reconecte no Marketplace");
	}
	const readiness = resolveMcpOAuthClient(getMcpCatalogEntry(GITHUB_CATALOG_ID));
	const clientInformation: OAuthClientInformationMixed | undefined =
		readiness.ready && readiness.client.clientId
			? {
					client_id: readiness.client.clientId,
					...(readiness.client.clientSecret ? { client_secret: readiness.client.clientSecret } : {}),
				}
			: undefined;
	if (!clientInformation) throw new UnauthorizedError("conector sem client OAuth configurado");
	let refreshed: OAuthTokens;
	try {
		const metadata = await discoverAuthorizationServerMetadata(GITHUB_AUTHORIZATION_SERVER, { fetchFn });
		refreshed = await refreshAuthorization(GITHUB_AUTHORIZATION_SERVER, {
			metadata,
			clientInformation,
			refreshToken: tokens.refresh_token,
			fetchFn,
		});
	} catch (error) {
		throw new UnauthorizedError(
			`falha ao renovar token: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	// Preserva o refresh_token antigo quando o GitHub não manda um novo.
	const merged: OAuthTokens = { ...refreshed, refresh_token: refreshed.refresh_token ?? tokens.refresh_token };
	const nextSecrets: McpConnectorSecrets = {
		...secrets,
		oauth: { ...oauth, tokens: merged as Record<string, unknown>, tokensSavedAt: Date.now() },
	};
	await persist(nextSecrets);
	return merged.access_token;
}

/** Busca o `login` (barato, best-effort): nunca derruba o resultado se falhar. */
async function fetchGithubLogin(token: string, fetchFn: FetchLike = fetch): Promise<string | undefined> {
	try {
		const res = await fetchFn("https://api.github.com/user", {
			headers: {
				Authorization: `Bearer ${token}`,
				Accept: "application/vnd.github+json",
				"User-Agent": "atlas-agent",
			},
		});
		if (!res.ok) return undefined;
		const data = (await res.json()) as { login?: unknown };
		return typeof data.login === "string" ? data.login : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Token de acesso do GitHub para os gatilhos de rotina, a partir da conexão
 * MCP do Marketplace (`getMcpConnectionByCatalogId("github", userId)`).
 * PAT vem de `secrets.apiKey`; OAuth vem de `secrets.oauth.tokens.access_token`
 * (renovado via `refresh_token` se `expires_in` já passou — tokens do OAuth
 * App clássico do GitHub não expiram, então isso normalmente não roda).
 * `login` custa uma chamada HTTP extra (`GET /user`): só busca com
 * `withLogin: true` (o worker chama isso por rotina a cada passagem — sem o
 * opt-in não vale gastar a chamada à toa).
 */
export async function getGithubConnectionToken(
	userId: string,
	options: { fetchFn?: FetchLike; withLogin?: boolean } = {},
): Promise<GithubConnectionTokenResult> {
	const record = await getMcpConnectionByCatalogId(GITHUB_CATALOG_ID, userId).catch(() => null);
	if (!record || record.status !== "connected") return { error: NOT_CONNECTED_ERROR };

	let secrets: McpConnectorSecrets;
	try {
		secrets = openSecrets(record.secretsEnc);
	} catch {
		return { error: NOT_CONNECTED_ERROR };
	}

	if (record.authType === "oauth") {
		const oauth = secrets.oauth ?? {};
		const tokens = oauth.tokens as OAuthTokens | undefined;
		if (!tokens?.access_token) return { error: NOT_CONNECTED_ERROR };
		let accessToken = tokens.access_token;
		if (!githubOAuthTokenIsFresh(tokens, oauth.tokensSavedAt)) {
			try {
				accessToken = await refreshGithubOAuthToken({
					secrets,
					oauth,
					tokens,
					persist: persistTo(record.id),
					fetchFn: options.fetchFn,
				});
			} catch (error) {
				if (error instanceof UnauthorizedError) {
					await markMcpConnectionAuthFailed(record, AUTH_FAILED_ERROR);
					return { error: AUTH_FAILED_ERROR };
				}
				throw error;
			}
		}
		const login = options.withLogin ? await fetchGithubLogin(accessToken, options.fetchFn) : undefined;
		return { token: accessToken, login, source: "oauth" };
	}

	const apiKey = secrets.apiKey;
	if (!apiKey) return { error: NOT_CONNECTED_ERROR };
	const login = options.withLogin ? await fetchGithubLogin(apiKey, options.fetchFn) : undefined;
	return { token: apiKey, login, source: "pat" };
}

/** Chamar quando a API do GitHub devolver 401 para o token de um gatilho: pede reconexão no Marketplace. */
export async function markGithubConnectionAuthFailed(userId: string): Promise<void> {
	const record = await getMcpConnectionByCatalogId(GITHUB_CATALOG_ID, userId).catch(() => null);
	if (!record) return;
	await markMcpConnectionAuthFailed(record, AUTH_FAILED_ERROR);
}
