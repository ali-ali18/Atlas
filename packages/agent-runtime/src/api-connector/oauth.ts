import { createHash, randomBytes } from "node:crypto";
import type { ApiAuth } from "@workspace/shared";
import { safeHttpRequest, type SafeHttpDeps } from "./safe-http.js";
import { apiSecretValues, type ApiConnectorSecrets, type ApiOAuthTokens } from "./secrets.js";
import { sanitizeErrorMessage } from "../mcp/sanitize.js";

/**
 * OAuth2 (authorization code) para APIs genéricas: URL de autorização com
 * PKCE quando o servidor declara suporte, troca do código, refresh (com
 * rotação do refresh token) e revogação. Todas as chamadas ao provedor passam
 * pelo fetch seguro. O `redirect_uri` é sempre o callback do Atlas.
 */

/** Margem antes do vencimento em que o token já é renovado. */
export const TOKEN_REFRESH_SKEW_MS = 60_000;

export type OAuthDeps = SafeHttpDeps & { now?: () => number; signal?: AbortSignal };

export class ApiOAuthError extends Error {
	constructor(
		message: string,
		/** O provedor recusou a credencial/refresh token: só um novo login resolve. */
		readonly needsLogin: boolean,
	) {
		super(message);
		this.name = "ApiOAuthError";
	}
}

export function newPkce(): { verifier: string; challenge: string } {
	const verifier = randomBytes(48).toString("base64url");
	return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

export function buildAuthorizeUrl(input: {
	auth: ApiAuth;
	clientId: string;
	redirectUri: string;
	state: string;
	challenge?: string;
}): string {
	if (!input.auth.authorizeUrl) throw new Error("A API não declara o endereço de autorização OAuth2.");
	const url = new URL(input.auth.authorizeUrl);
	url.searchParams.set("response_type", "code");
	url.searchParams.set("client_id", input.clientId);
	url.searchParams.set("redirect_uri", input.redirectUri);
	url.searchParams.set("state", input.state);
	if (input.auth.scopes?.length && !url.searchParams.has("scope")) url.searchParams.set("scope", input.auth.scopes.join(" "));
	if (input.challenge) {
		url.searchParams.set("code_challenge", input.challenge);
		url.searchParams.set("code_challenge_method", "S256");
	}
	return url.toString();
}

/**
 * Metadados RFC 8414 do servidor de autorização: `S256` suportado? Falha ou
 * ausência = sem PKCE (muitos provedores recusam parâmetros que não conhecem).
 */
export async function detectPkceSupport(auth: ApiAuth, deps: OAuthDeps = {}): Promise<boolean> {
	if (!auth.tokenUrl) return false;
	try {
		const origin = new URL(auth.tokenUrl).origin;
		for (const path of ["/.well-known/oauth-authorization-server", "/.well-known/openid-configuration"]) {
			const response = await safeHttpRequest(`${origin}${path}`, { timeoutMs: 4000, maxBytes: 200_000, signal: deps.signal }, deps);
			if (response.status !== 200) continue;
			const metadata = JSON.parse(response.text) as { code_challenge_methods_supported?: unknown };
			if (Array.isArray(metadata.code_challenge_methods_supported)) return metadata.code_challenge_methods_supported.includes("S256");
		}
	} catch {
		// sem metadados: sem PKCE.
	}
	return false;
}

type TokenResponse = { access_token?: unknown; refresh_token?: unknown; token_type?: unknown; expires_in?: unknown; error?: unknown; error_description?: unknown };

function toTokens(body: TokenResponse, previous: ApiOAuthTokens | undefined, now: number): ApiOAuthTokens {
	if (typeof body.access_token !== "string" || !body.access_token) throw new ApiOAuthError("O provedor não devolveu um token de acesso.", false);
	const expiresIn = typeof body.expires_in === "number" ? body.expires_in : typeof body.expires_in === "string" ? Number(body.expires_in) : NaN;
	return {
		access_token: body.access_token,
		// Alguns provedores (Bling) giram o refresh token a cada renovação; sem um novo, mantém o antigo.
		refresh_token: typeof body.refresh_token === "string" && body.refresh_token ? body.refresh_token : previous?.refresh_token,
		token_type: typeof body.token_type === "string" ? body.token_type : "Bearer",
		...(Number.isFinite(expiresIn) && expiresIn > 0 ? { expires_at: now + expiresIn * 1000 } : {}),
	};
}

async function postToken(
	auth: ApiAuth,
	form: Record<string, string>,
	creds: { clientId: string; clientSecret: string },
	deps: OAuthDeps,
	secretList: string[],
): Promise<TokenResponse> {
	if (!auth.tokenUrl) throw new ApiOAuthError("A API não declara o endereço de token OAuth2.", false);
	const attempt = async (style: "basic" | "post") => {
		const body = new URLSearchParams(form);
		const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" };
		if (style === "basic") headers.Authorization = `Basic ${Buffer.from(`${creds.clientId}:${creds.clientSecret}`).toString("base64")}`;
		else {
			body.set("client_id", creds.clientId);
			body.set("client_secret", creds.clientSecret);
		}
		return safeHttpRequest(auth.tokenUrl!, { method: "POST", headers, body: body.toString(), timeoutMs: 15_000, maxBytes: 100_000, signal: deps.signal }, deps);
	};
	let response = await attempt("basic");
	// Provedores que só aceitam as credenciais no corpo.
	if (response.status === 401 || (response.status === 400 && /invalid_client/i.test(response.text))) response = await attempt("post");
	let body: TokenResponse = {};
	try {
		body = JSON.parse(response.text) as TokenResponse;
	} catch {
		// corpo não-JSON: trata pelo status.
	}
	if (response.status >= 200 && response.status < 300) return body;
	const code = typeof body.error === "string" ? body.error : `HTTP ${response.status}`;
	const description = typeof body.error_description === "string" ? `: ${body.error_description}` : "";
	const needsLogin = response.status === 400 || response.status === 401 || response.status === 403;
	throw new ApiOAuthError(sanitizeErrorMessage(`O provedor recusou o login (${code}${description})`, secretList), needsLogin);
}

export async function exchangeAuthorizationCode(input: {
	auth: ApiAuth;
	secrets: ApiConnectorSecrets;
	code: string;
	redirectUri: string;
	deps?: OAuthDeps;
}): Promise<ApiOAuthTokens> {
	const oauth = input.secrets.oauth;
	if (!oauth?.clientId || !oauth.clientSecret) throw new ApiOAuthError("Faltam o client id e o client secret.", true);
	const deps = input.deps ?? {};
	const form: Record<string, string> = { grant_type: "authorization_code", code: input.code, redirect_uri: input.redirectUri };
	if (oauth.codeVerifier) form.code_verifier = oauth.codeVerifier;
	const body = await postToken(input.auth, form, { clientId: oauth.clientId, clientSecret: oauth.clientSecret }, deps, [...apiSecretValues(input.secrets), input.code]);
	return toTokens(body, undefined, (deps.now ?? Date.now)());
}

export async function refreshAccessToken(input: { auth: ApiAuth; secrets: ApiConnectorSecrets; deps?: OAuthDeps }): Promise<ApiOAuthTokens> {
	const oauth = input.secrets.oauth;
	const refresh = oauth?.tokens?.refresh_token;
	if (!oauth?.clientId || !oauth.clientSecret || !refresh) throw new ApiOAuthError("Sem refresh token: reconecte a API.", true);
	const deps = input.deps ?? {};
	const body = await postToken(
		input.auth,
		{ grant_type: "refresh_token", refresh_token: refresh },
		{ clientId: oauth.clientId, clientSecret: oauth.clientSecret },
		deps,
		apiSecretValues(input.secrets),
	);
	return toTokens(body, oauth.tokens, (deps.now ?? Date.now)());
}

/** Revoga no provedor quando ele publica um endpoint (spec `x-revocation-url`); nunca lança. */
export async function revokeTokens(input: { auth: ApiAuth; secrets: ApiConnectorSecrets; deps?: OAuthDeps }): Promise<boolean> {
	const oauth = input.secrets.oauth;
	const token = oauth?.tokens?.refresh_token ?? oauth?.tokens?.access_token;
	if (!input.auth.revokeUrl || !oauth?.clientId || !oauth.clientSecret || !token) return false;
	try {
		const response = await safeHttpRequest(
			input.auth.revokeUrl,
			{
				method: "POST",
				headers: {
					"Content-Type": "application/x-www-form-urlencoded",
					Authorization: `Basic ${Buffer.from(`${oauth.clientId}:${oauth.clientSecret}`).toString("base64")}`,
				},
				body: new URLSearchParams({ token }).toString(),
				timeoutMs: 8000,
				maxBytes: 20_000,
			},
			input.deps ?? {},
		);
		return response.status >= 200 && response.status < 300;
	} catch {
		return false;
	}
}

const inflight = new Map<string, Promise<ApiOAuthTokens>>();

/**
 * Access token válido: usa o salvo ou renova (uma renovação por vez por
 * conexão — provedores com rotação invalidam o refresh token usado duas vezes)
 * e persiste os tokens novos no cofre.
 */
export async function getValidAccessToken(input: {
	connectionId: string;
	auth: ApiAuth;
	secrets: ApiConnectorSecrets;
	persist: (secrets: ApiConnectorSecrets) => Promise<void>;
	/** Relê o cofre (outro processo pode ter renovado). */
	reload?: () => Promise<ApiConnectorSecrets>;
	force?: boolean;
	deps?: OAuthDeps;
}): Promise<{ token: string; secrets: ApiConnectorSecrets }> {
	const now = (input.deps?.now ?? Date.now)();
	const tokens = input.secrets.oauth?.tokens;
	if (!tokens?.access_token) throw new ApiOAuthError("A API ainda não foi conectada: faça o login.", true);
	const fresh = !tokens.expires_at || tokens.expires_at - TOKEN_REFRESH_SKEW_MS > now;
	if (fresh && !input.force) return { token: tokens.access_token, secrets: input.secrets };

	let pending = inflight.get(input.connectionId);
	if (!pending) {
		pending = (async () => {
			try {
				return await refreshAccessToken({ auth: input.auth, secrets: input.secrets, deps: input.deps });
			} catch (error) {
				// Outro processo pode ter girado o refresh token: relê e tenta uma vez com o novo.
				if (error instanceof ApiOAuthError && error.needsLogin && input.reload) {
					const latest = await input.reload();
					if (latest.oauth?.tokens?.refresh_token && latest.oauth.tokens.refresh_token !== tokens.refresh_token) {
						if (latest.oauth.tokens.expires_at && latest.oauth.tokens.expires_at - TOKEN_REFRESH_SKEW_MS > now && !input.force) return latest.oauth.tokens;
						return refreshAccessToken({ auth: input.auth, secrets: latest, deps: input.deps });
					}
				}
				throw error;
			}
		})().finally(() => inflight.delete(input.connectionId));
		inflight.set(input.connectionId, pending);
	}
	const renewed = await pending;
	const secrets: ApiConnectorSecrets = { ...input.secrets, oauth: { ...input.secrets.oauth, tokens: renewed } };
	await input.persist(secrets);
	return { token: renewed.access_token, secrets };
}
