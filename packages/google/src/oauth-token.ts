import { discoverAuthorizationServerMetadata, refreshAuthorization } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { getMcpCatalogEntry, isBuiltinMcpUrl, type McpCatalogEntry } from "@workspace/shared";
import { updateMcpConnection, type McpConnectionRecord } from "@workspace/db";
import { sealSecrets, type McpConnectorSecrets } from "@workspace/db/vault-crypto";
import { mcpAuthRequired } from "./auth-required.js";

/**
 * Token OAuth do conector do dono (Google): cliente do catálogo (env), gravação dos segredos no cofre e access token
 * fresco. O fluxo de login (PKCE, registro dinâmico, callback) continua no agent-runtime.
 */

export type McpOAuthClient = {
	/** App OAuth fixo (GitHub/Slack). Sem ele, registro dinâmico. */
	clientId?: string;
	clientSecret?: string;
	scope?: string;
	/** Parâmetros extras na URL de login (ex.: Google `access_type=offline`). */
	authorizationParams?: Readonly<Record<string, string>>;
	/** Servidor de autorização fixo (Google): pula a descoberta via URL do servidor MCP (`builtin://`). */
	authorizationServer?: string;
};

export type McpOAuthReadiness =
	| { ready: true; client: McpOAuthClient }
	| { ready: false; missing: string[] };

export type McpOAuthPersist = (secrets: McpConnectorSecrets) => Promise<void>;

function envValue(env: NodeJS.ProcessEnv, name: string | undefined): string | undefined {
	if (!name) return undefined;
	const value = env[name]?.trim();
	return value ? value : undefined;
}

/** Credenciais do app OAuth de um conector do catálogo (lidas do env). */
export function resolveMcpOAuthClient(
	entry: Pick<McpCatalogEntry, "oauth"> | undefined,
	env: NodeJS.ProcessEnv = process.env,
): McpOAuthReadiness {
	const oauth = entry?.oauth;
	if (!oauth?.clientIdEnv) {
		return {
			ready: true,
			client: { scope: oauth?.scope, authorizationParams: oauth?.authorizationParams, authorizationServer: oauth?.authorizationServer },
		};
	}
	const clientId = envValue(env, oauth.clientIdEnv);
	const clientSecret = envValue(env, oauth.clientSecretEnv);
	const missing = [
		clientId ? undefined : oauth.clientIdEnv,
		oauth.clientSecretEnv && !clientSecret ? oauth.clientSecretEnv : undefined,
	].filter((name): name is string => !!name);
	if (missing.length > 0) return { ready: false, missing };
	return {
		ready: true,
		client: {
			clientId,
			clientSecret,
			scope: oauth.scope,
			authorizationParams: oauth.authorizationParams,
			authorizationServer: oauth.authorizationServer,
		},
	};
}

/** Persiste os segredos (tokens/PKCE/etc.) de uma conexão no cofre. */
export function persistTo(connectionId: string): McpOAuthPersist {
	return async (secrets) => {
		await updateMcpConnection(connectionId, { secretsEnc: sealSecrets(secrets) });
	};
}

/** Cliente OAuth do registro: catálogo (env) ou personalizado (dinâmico). */
export function mcpOAuthClientFor(
	record: Pick<McpConnectionRecord, "catalogId">,
	env: NodeJS.ProcessEnv = process.env,
): McpOAuthReadiness {
	return resolveMcpOAuthClient(record.catalogId ? getMcpCatalogEntry(record.catalogId) : undefined, env);
}

/** Token de acesso ainda válido, ou `undefined` se não sabemos a validade (sem `expires_in`). */
function accessTokenIsFresh(tokens: OAuthTokens, savedAt: number | undefined): boolean {
	const expiresIn = tokens.expires_in;
	if (expiresIn == null) return true;
	const ageMs = Date.now() - (savedAt ?? 0);
	const marginMs = 60_000;
	return ageMs < expiresIn * 1000 - marginMs;
}

/**
 * Token de acesso pronto para uso pelos servidores MCP embutidos: reaproveita
 * o salvo se ainda vale, senão renova via `refresh_token`. Sem refresh
 * possível (ou o Google recusa), joga `UnauthorizedError` — mesmo sinal que a
 * conexão "pending_auth" (reconectar) usa para OAuth normal.
 */
export async function getFreshAccessToken(input: {
	secrets: McpConnectorSecrets;
	client: McpOAuthClient;
	persist: McpOAuthPersist;
	/** Só para teste: injeta o fetch usado no discovery/refresh (default: fetch global). */
	fetchFn?: FetchLike;
}): Promise<string> {
	const oauth = input.secrets.oauth ?? {};
	const tokens = oauth.tokens as OAuthTokens | undefined;
	if (!tokens?.access_token) throw mcpAuthRequired("conector sem login: reconecte no Marketplace");
	if (accessTokenIsFresh(tokens, oauth.tokensSavedAt)) return tokens.access_token;
	if (!tokens.refresh_token) throw mcpAuthRequired("token expirado sem refresh_token: reconecte no Marketplace");
	const authorizationServer = input.client.authorizationServer;
	if (!authorizationServer) throw mcpAuthRequired("conector sem servidor de autorização configurado");
	const clientInformation: OAuthClientInformationMixed | undefined = input.client.clientId
		? { client_id: input.client.clientId, ...(input.client.clientSecret ? { client_secret: input.client.clientSecret } : {}) }
		: undefined;
	if (!clientInformation) throw mcpAuthRequired("conector sem client OAuth configurado");
	let refreshed: OAuthTokens;
	try {
		const metadata = await discoverAuthorizationServerMetadata(authorizationServer, { fetchFn: input.fetchFn });
		refreshed = await refreshAuthorization(authorizationServer, {
			metadata,
			clientInformation,
			refreshToken: tokens.refresh_token,
			fetchFn: input.fetchFn,
		});
	} catch (error) {
		throw mcpAuthRequired(
			`falha ao renovar token: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	// `refreshAuthorization` já preserva o refresh_token antigo quando o Google não manda um novo, mas reforça aqui.
	const merged: OAuthTokens = { ...refreshed, refresh_token: refreshed.refresh_token ?? tokens.refresh_token };
	const nextSecrets: McpConnectorSecrets = {
		...input.secrets,
		oauth: { ...oauth, tokens: merged as Record<string, unknown>, tokensSavedAt: Date.now() },
	};
	// Atualiza a cópia em memória para reutilizar o novo access token até
	// expirar (sem isso, o closure chamaria refresh a cada chamada).
	input.secrets.oauth = nextSecrets.oauth;
	await input.persist(nextSecrets);
	return merged.access_token;
}

/**
 * Conexões antigas dos 4 conectores Google foram criadas com a URL oficial
 * (`...mcp.googleapis.com`); o catálogo agora aponta pra `builtin://google/...`.
 * Enquanto o registro não é atualizado (a API faz isso no próximo login), usa
 * a URL do catálogo aqui — assim runs em andamento já pegam o servidor certo.
 */
export function resolveMcpUrl(record: McpConnectionRecord, secrets: McpConnectorSecrets): string {
	const catalogUrl = record.catalogId ? getMcpCatalogEntry(record.catalogId)?.url : undefined;
	if (catalogUrl && isBuiltinMcpUrl(catalogUrl)) return catalogUrl;
	return secrets.url ?? record.url;
}

/** `builtin.getAccessToken` do config: token do cofre, renovado via refresh_token quando preciso. */
export function builtinAccessTokenConfig(
	record: McpConnectionRecord,
	secrets: McpConnectorSecrets,
): { getAccessToken: () => Promise<string> } | undefined {
	const readiness = mcpOAuthClientFor(record);
	if (!readiness.ready) return undefined;
	const client = readiness.client;
	return {
		getAccessToken: () =>
			getFreshAccessToken({
				secrets,
				client,
				persist: async (next) => {
					await persistTo(record.id)(next);
					// Sincroniza a linha em memória para a próxima chamada abrir
					// o token novo (sem isso, `record.secretsEnc` stale renovava a cada chamada).
					try {
						record.secretsEnc = sealSecrets(next);
					} catch {
						// Cofre indisponível: mantém o stale, o próximo refresh tenta de novo.
					}
				},
			}),
	};
}

/** Token de acesso de um conector OAuth embutido (Gmail, Agenda…); `undefined` se a conexão não é desse tipo ou falta o client. */
export function builtinAccessTokenFor(
	record: McpConnectionRecord,
	secrets: McpConnectorSecrets,
): { getAccessToken: () => Promise<string> } | undefined {
	return record.authType === "oauth" && isBuiltinMcpUrl(resolveMcpUrl(record, secrets)) ? builtinAccessTokenConfig(record, secrets) : undefined;
}
