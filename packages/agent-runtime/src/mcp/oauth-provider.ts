import { createHash, randomBytes } from "node:crypto";
import {
	auth,
	discoverAuthorizationServerMetadata,
	exchangeAuthorization,
	refreshAuthorization,
	startAuthorization,
	type OAuthClientProvider,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type {
	OAuthClientInformationMixed,
	OAuthClientMetadata,
	OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { getMcpCatalogEntry, type McpCatalogEntry } from "@workspace/shared";
import { updateMcpConnection, type McpConnectionRecord } from "@workspace/db";
import type { McpAuthProviderFactory } from "./runtime.js";
import { mcpAuthRequired } from "./auth-marker.js";
import { humanizeOAuthError, normalizingFetch } from "./oauth-fetch.js";
import { sealSecrets, type McpConnectorSecrets, type McpOAuthSecrets } from "./secret-box.js";

/**
 * OAuth dos conectores MCP. O SDK cuida de discovery, PKCE, registro
 * dinâmico e refresh; aqui só guardamos o estado dele no cofre
 * (`McpConnection.secretsEnc`) e capturamos a URL de login para a UI.
 */

export const MCP_OAUTH_CALLBACK_PATH = "/v1/mcp/oauth/callback";
/** Login pendente expira: o popup abandonado não deixa `state` válido. */
export const MCP_OAUTH_STATE_TTL_MS = 15 * 60_000;

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

/**
 * O callback OAuth dos conectores é servido pela API, mas o navegador chega
 * nele pela origem do web (`ATLAS_URL`): o rewrite `/v1/*` do Next
 * (`apps/web/next.config.ts`) repassa pra API no mesmo domínio, então o
 * cookie de sessão do Better Auth vai junto. Não usa mais `PUBLIC_API_URL`.
 */
/** Logo só do avatar, fundo transparente (apps/web/public/icons/logo-avatar.png). */
export const MCP_OAUTH_LOGO_PATH = "/icons/logo-avatar.png";

export function mcpOAuthLogoUrl(redirectUrl: string = mcpOAuthRedirectUrl()): string {
	return `${new URL(redirectUrl).origin}${MCP_OAUTH_LOGO_PATH}`;
}

export function mcpOAuthRedirectUrl(env: NodeJS.ProcessEnv = process.env): string {
	const base = (envValue(env, "ATLAS_URL") ?? "http://localhost:3000").replace(/\/+$/, "");
	return `${base}${MCP_OAUTH_CALLBACK_PATH}`;
}

export function newMcpOAuthState(): { state: string; stateHash: string } {
	const state = randomBytes(32).toString("base64url");
	return { state, stateHash: hashMcpOAuthState(state) };
}

export function hashMcpOAuthState(state: string): string {
	return createHash("sha256").update(state).digest("hex");
}

export type McpOAuthPersist = (secrets: McpConnectorSecrets) => Promise<void>;

export class McpOAuthProvider implements OAuthClientProvider {
	/** Preenchida quando o SDK pede login (a API devolve à UI). */
	authorizationUrl?: URL;

	constructor(
		private readonly secrets: McpConnectorSecrets,
		private readonly options: {
			redirectUrl: string;
			client: McpOAuthClient;
			persist: McpOAuthPersist;
			/** Só no início do login; runs e callback não geram state novo. */
			state?: string;
		},
	) {}

	private get oauth(): McpOAuthSecrets {
		this.secrets.oauth ??= {};
		return this.secrets.oauth;
	}

	private async save(): Promise<void> {
		await this.options.persist(this.secrets);
	}

	get redirectUrl(): string {
		return this.options.redirectUrl;
	}

	get clientMetadata(): OAuthClientMetadata {
		// Origem pública derivada do redirectUrl (que já sai de ATLAS_URL): é o que a
		// tela de consentimento do servidor MCP usa como ícone/link do app.
		return {
			client_name: "Atlas",
			client_uri: new URL(this.options.redirectUrl).origin,
			logo_uri: mcpOAuthLogoUrl(this.options.redirectUrl),
			redirect_uris: [this.options.redirectUrl],
			grant_types: ["authorization_code", "refresh_token"],
			response_types: ["code"],
			token_endpoint_auth_method: this.options.client.clientSecret ? "client_secret_post" : "none",
			...(this.options.client.scope ? { scope: this.options.client.scope } : {}),
		};
	}

	state(): string {
		// Fora do Marketplace (run/refresh) o SDK pode pedir login: state
		// descartável, sem hash no banco, então esse callback nunca é aceito e
		// a chamada cai em UnauthorizedError → "Reconectar".
		return this.options.state ?? randomBytes(32).toString("base64url");
	}

	clientInformation(): OAuthClientInformationMixed | undefined {
		const { clientId, clientSecret } = this.options.client;
		if (clientId) return { client_id: clientId, ...(clientSecret ? { client_secret: clientSecret } : {}) };
		return this.oauth.clientInformation as OAuthClientInformationMixed | undefined;
	}

	async saveClientInformation(info: OAuthClientInformationMixed): Promise<void> {
		// App fixo vem do env: nunca grava o client_secret dele no banco.
		if (this.options.client.clientId) return;
		this.oauth.clientInformation = info as Record<string, unknown>;
		await this.save();
	}

	tokens(): OAuthTokens | undefined {
		return this.oauth.tokens as OAuthTokens | undefined;
	}

	async saveTokens(tokens: OAuthTokens): Promise<void> {
		this.oauth.tokens = tokens as Record<string, unknown>;
		this.oauth.tokensSavedAt = Date.now();
		delete this.oauth.codeVerifier;
		delete this.oauth.authorizationUrl;
		await this.save();
	}

	redirectToAuthorization(url: URL): void {
		// O Google só devolve refresh_token com access_type=offline (e prompt=consent para forçar o consentimento de novo).
		for (const [key, value] of Object.entries(this.options.client.authorizationParams ?? {})) {
			url.searchParams.set(key, value);
		}
		this.authorizationUrl = url;
		this.oauth.authorizationUrl = url.toString();
	}

	async saveCodeVerifier(codeVerifier: string): Promise<void> {
		this.oauth.codeVerifier = codeVerifier;
		await this.save();
	}

	codeVerifier(): string {
		const verifier = this.oauth.codeVerifier;
		if (!verifier) throw new Error("login do conector expirou: tente de novo");
		return verifier;
	}

	async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): Promise<void> {
		if (scope === "all") this.secrets.oauth = {};
		if (scope === "client") delete this.oauth.clientInformation;
		if (scope === "tokens") delete this.oauth.tokens;
		if (scope === "verifier") delete this.oauth.codeVerifier;
		if (scope !== "discovery") await this.save();
	}
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

/**
 * Provider para runs e confirmações: usa/renova os tokens salvos. Se o
 * refresh falhar, a chamada volta `authFailed` e a conexão vira
 * `pending_auth` (o usuário reconecta no Marketplace).
 */
export const defaultMcpAuthProviderFactory: McpAuthProviderFactory = (record, secrets) => {
	const readiness = mcpOAuthClientFor(record);
	if (!readiness.ready) return undefined;
	return new McpOAuthProvider(secrets, {
		redirectUrl: mcpOAuthRedirectUrl(),
		client: readiness.client,
		persist: persistTo(record.id),
	});
};

export type McpOAuthStart =
	| { status: "authorized"; provider: McpOAuthProvider }
	| { status: "redirect"; authorizationUrl: string };

/**
 * `builtin://` não é descobrível (não existe servidor de verdade naquela
 * URL): com `authorizationServer` no client, pula RFC 9728 e vai direto no
 * servidor de autorização fixo do catálogo, usando os primitivos do SDK
 * (`discoverAuthorizationServerMetadata`/`startAuthorization`/`exchangeAuthorization`)
 * em vez do orquestrador `auth()`.
 */
async function startBuiltinMcpOAuth(provider: McpOAuthProvider, client: McpOAuthClient): Promise<McpOAuthStart> {
	const authorizationServer = client.authorizationServer;
	if (!authorizationServer) throw new Error("conector sem servidor de autorização configurado");
	const metadata = await discoverAuthorizationServerMetadata(authorizationServer);
	if (!metadata) throw new Error("não foi possível descobrir o servidor de autorização");
	const clientInformation = await provider.clientInformation();
	if (!clientInformation) throw new Error("conector sem client OAuth configurado");
	const state = provider.state ? await provider.state() : undefined;
	const { authorizationUrl, codeVerifier } = await startAuthorization(authorizationServer, {
		metadata,
		clientInformation,
		redirectUrl: provider.redirectUrl,
		scope: client.scope,
		state,
	});
	await provider.saveCodeVerifier(codeVerifier);
	// Aplica os `authorizationParams` (ex.: `access_type=offline`) e guarda a URL para a UI.
	await provider.redirectToAuthorization(authorizationUrl);
	if (!provider.authorizationUrl) throw new Error("servidor não devolveu URL de login");
	return { status: "redirect", authorizationUrl: provider.authorizationUrl.toString() };
}

/** Contraparte de `startBuiltinMcpOAuth`: troca o `code` por tokens sem descoberta via URL do servidor MCP. */
async function finishBuiltinMcpOAuth(provider: McpOAuthProvider, client: McpOAuthClient, code: string): Promise<void> {
	const authorizationServer = client.authorizationServer;
	if (!authorizationServer) throw new Error("conector sem servidor de autorização configurado");
	const metadata = await discoverAuthorizationServerMetadata(authorizationServer);
	if (!metadata) throw new Error("não foi possível descobrir o servidor de autorização");
	const clientInformation = await provider.clientInformation();
	if (!clientInformation) throw new Error("conector sem client OAuth configurado");
	const codeVerifier = await provider.codeVerifier();
	const tokens = await exchangeAuthorization(authorizationServer, {
		metadata,
		clientInformation,
		authorizationCode: code,
		codeVerifier,
		redirectUri: provider.redirectUrl,
	});
	await provider.saveTokens(tokens);
}

/** Inicia o login: devolve a URL do popup (ou `authorized` se o token ainda vale). */
export async function startMcpOAuth(input: {
	record: Pick<McpConnectionRecord, "id" | "url">;
	secrets: McpConnectorSecrets;
	client: McpOAuthClient;
	state: string;
	redirectUrl?: string;
	persist?: McpOAuthPersist;
	/** Só para teste: injeta o fetch usado no discovery/registro/token. */
	fetchFn?: FetchLike;
}): Promise<McpOAuthStart> {
	const provider = new McpOAuthProvider(input.secrets, {
		redirectUrl: input.redirectUrl ?? mcpOAuthRedirectUrl(),
		client: input.client,
		persist: input.persist ?? persistTo(input.record.id),
		state: input.state,
	});
	if (input.client.authorizationServer) return startBuiltinMcpOAuth(provider, input.client);
	const fetchFn = normalizingFetch(input.fetchFn);
	let result: Awaited<ReturnType<typeof auth>>;
	try {
		result = await auth(provider, { serverUrl: input.record.url, scope: input.client.scope, fetchFn });
	} catch (error) {
		throw new Error(humanizeOAuthError(error, { redirectUrl: provider.redirectUrl }), { cause: error });
	}
	if (result === "AUTHORIZED") return { status: "authorized", provider };
	if (!provider.authorizationUrl) throw new Error("servidor não devolveu URL de login");
	return { status: "redirect", authorizationUrl: provider.authorizationUrl.toString() };
}

/** Callback do popup: troca o `code` por tokens (salvos no cofre). */
export async function finishMcpOAuth(input: {
	record: Pick<McpConnectionRecord, "id" | "url">;
	secrets: McpConnectorSecrets;
	client: McpOAuthClient;
	code: string;
	redirectUrl?: string;
	persist?: McpOAuthPersist;
	fetchFn?: FetchLike;
}): Promise<McpOAuthProvider> {
	const provider = new McpOAuthProvider(input.secrets, {
		redirectUrl: input.redirectUrl ?? mcpOAuthRedirectUrl(),
		client: input.client,
		persist: input.persist ?? persistTo(input.record.id),
	});
	if (input.client.authorizationServer) {
		await finishBuiltinMcpOAuth(provider, input.client, input.code);
		return provider;
	}
	let result: Awaited<ReturnType<typeof auth>>;
	try {
		result = await auth(provider, {
			serverUrl: input.record.url,
			authorizationCode: input.code,
			scope: input.client.scope,
			fetchFn: normalizingFetch(input.fetchFn),
		});
	} catch (error) {
		throw new Error(humanizeOAuthError(error, { redirectUrl: provider.redirectUrl }), { cause: error });
	}
	if (result !== "AUTHORIZED") throw new Error("servidor recusou o login");
	return provider;
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
