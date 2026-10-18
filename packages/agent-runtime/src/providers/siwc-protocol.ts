import { createPublicKey, verify, type JsonWebKey } from "node:crypto";

export const SIWC_RESOURCE = "https://api.openai.com/v1";
export const SIWC_SCOPE =
	"openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
export const SIWC_TOKEN_URL =
	"https://auth.openai.com/api/accounts/oauth/token";
export const SIWC_AUTHORIZE_URL =
	"https://auth.openai.com/api/accounts/authorize";
const ISSUER = "https://auth.openai.com";
export class SiwcAuthError extends Error {
	constructor(
		public readonly code: string,
		public readonly status = 503,
	) {
		super(
			code === "needs_login"
				? "Reconecte o ChatGPT"
				: "Não foi possível conectar o ChatGPT",
		);
		this.name = "SiwcAuthError";
	}
}
export type SiwcTokens = {
	access_token: string;
	/** Ausente em troca inicial sem `offline_access` concedido: conexão sem renovação. */
	refresh_token?: string;
	id_token?: string;
	expires_in: number;
	scope: string;
	/** Epoch em ms; ausente se o campo não veio ou não pôde ser lido. */
	earliestRefreshAt?: number;
};
export const SIWC_PLAN_SCOPE = "chatgpt.tokens.use.direct";
/** Login por código de dispositivo (cliente público do Codex CLI): sem redirect algum. */
export const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const CODEX_ISSUER = "https://auth.openai.com";
export const CODEX_DEVICE_API = `${CODEX_ISSUER}/api/accounts/deviceauth`;
export const CODEX_DEVICE_VERIFY_URL = `${CODEX_ISSUER}/codex/device`;
export const CODEX_DEVICE_REDIRECT_URI = `${CODEX_ISSUER}/deviceauth/callback`;
export const CODEX_TOKEN_URL = `${CODEX_ISSUER}/oauth/token`;
/** Marca guardada em `scopes` das conexões do fluxo Codex (não há escopo SIWC de plano). */
export const CODEX_SCOPE_MARK = "codex_device";
const CODEX_DEFAULT_SCOPE = "openid profile email offline_access";
export type TokenRequestOptions = { url?: string; json?: boolean; codex?: boolean };
const EXPIRES_MIN_S = 60;
const EXPIRES_MAX_S = 30 * 86_400;
const EXPIRES_DEFAULT_S = 3600;
const TOKEN_MAX = 16_384;
/** Aceita epoch em segundos/ms (número ou string numérica) ou data ISO; o resto é ignorado. */
function parseRefreshAt(value: unknown): number | undefined {
	let ms: number;
	if (
		typeof value === "number" ||
		(typeof value === "string" && /^\d+(\.\d+)?$/.test(value.trim()))
	) {
		const n = Number(value);
		ms = n < 1e11 ? n * 1000 : n;
	} else if (typeof value === "string") ms = Date.parse(value);
	else return undefined;
	return Number.isFinite(ms) && ms > 0 ? ms : undefined;
}
/** Só nomes e tipos dos campos, nunca valores. */
function shapeOf(data: Record<string, unknown>) {
	return Object.fromEntries(
		Object.entries(data).map(([k, v]) => [
			k,
			v === null ? "null" : Array.isArray(v) ? "array" : typeof v,
		]),
	);
}
const allowedCodes = new Set([
	"invalid_grant",
	"invalid_refresh_token",
	"token_expired",
	"refresh_token_reused",
]);
export const isFatalSiwcError = (error: unknown) =>
	error instanceof SiwcAuthError && allowedCodes.has(error.code);

export async function tokenRequest(
	fetcher: typeof fetch,
	body: URLSearchParams,
	log: (message: string, shape: Record<string, string>) => void = (
		message,
		shape,
	) => console.warn(message, shape),
	options: TokenRequestOptions = {},
): Promise<SiwcTokens> {
	let response: Response;
	try {
		response = await fetcher(options.url ?? SIWC_TOKEN_URL, {
			method: "POST",
			body: options.json ? JSON.stringify(Object.fromEntries(body)) : body,
			headers: {
				"Content-Type": options.json
					? "application/json"
					: "application/x-www-form-urlencoded",
			},
			redirect: "error",
			signal: AbortSignal.timeout(10_000),
		});
	} catch {
		throw new SiwcAuthError("token_unavailable");
	}
	let data: Record<string, unknown>;
	try {
		const text = await response.text();
		if (text.length > 100_000) throw new Error();
		data = JSON.parse(text);
		if (!data || typeof data !== "object") throw new Error();
	} catch {
		// HTTP 2xx já pode ter rotacionado o refresh: corpo perdido/inválido é fatal.
		throw new SiwcAuthError(
			response.ok ? "invalid_token_response" : "token_unavailable",
		);
	}
	if (!response.ok) {
		const raw = typeof data.error === "string" ? data.error : "";
		// Nunca encaminhar descrição ou corpo do provedor: podem conter credenciais.
		throw new SiwcAuthError(
			allowedCodes.has(raw) ? raw : "token_unavailable",
			response.status,
		);
	}
	const fail = (field: string) => {
		log("siwc: resposta de token inválida", { field, ...shapeOf(data) });
		return new SiwcAuthError(`invalid_token_response:${field}`);
	};
	const text = (value: unknown): value is string =>
		typeof value === "string" && value.length > 0 && value.length <= TOKEN_MAX;
	if (!text(data.access_token)) throw fail("access_token");
	if (
		data.token_type !== undefined &&
		data.token_type !== null &&
		(typeof data.token_type !== "string" ||
			data.token_type.toLowerCase() !== "bearer")
	)
		throw fail("token_type");
	let expires = EXPIRES_DEFAULT_S;
	if (data.expires_in !== undefined && data.expires_in !== null) {
		const n =
			typeof data.expires_in === "string" && data.expires_in.trim()
				? Number(data.expires_in)
				: data.expires_in;
		if (typeof n === "number" && Number.isFinite(n) && n > 0)
			expires = Math.min(Math.max(n, EXPIRES_MIN_S), EXPIRES_MAX_S);
	}
	let scope = body.get("scope") ?? (options.codex ? CODEX_DEFAULT_SCOPE : SIWC_SCOPE);
	if (data.scope !== undefined && data.scope !== null) {
		if (typeof data.scope !== "string" || data.scope.length > TOKEN_MAX)
			throw fail("scope");
		scope = data.scope;
	}
	if (options.codex) scope = `${scope} ${CODEX_SCOPE_MARK}`;
	else if (!scope.split(/\s+/).includes(SIWC_PLAN_SCOPE))
		throw fail("scope_missing_plan");
	if (
		data.refresh_token !== undefined &&
		data.refresh_token !== null &&
		!text(data.refresh_token)
	)
		throw fail("refresh_token");
	if (data.id_token !== undefined && data.id_token !== null) {
		if (typeof data.id_token !== "string" || !data.id_token)
			throw fail("id_token");
		if (data.id_token.length > TOKEN_MAX) throw fail("id_token_size");
	}
	const earliestRefreshAt = parseRefreshAt(data.earliest_refresh_at);
	return {
		access_token: data.access_token,
		scope,
		expires_in: expires,
		...(typeof data.refresh_token === "string"
			? { refresh_token: data.refresh_token }
			: {}),
		...(typeof data.id_token === "string" ? { id_token: data.id_token } : {}),
		...(earliestRefreshAt !== undefined ? { earliestRefreshAt } : {}),
	};
}

/** Algoritmo fixo RS256 e JWKS no issuer fixo, sem jku/x5u do token. */
export async function verifySiwcIdToken(
	token: string,
	audience: string,
	/** `null` no fluxo de dispositivo: não há nonce, só assinatura, issuer e audience. */
	nonce: string | null,
	fetcher: typeof fetch = fetch,
	now = Date.now(),
): Promise<{ sub: string; email: string | null; accountId?: string }> {
	try {
		const parts = token.split(".");
		if (parts.length !== 3 || token.length > 16_384) throw new Error();
		const header = JSON.parse(Buffer.from(parts[0]!, "base64url").toString());
		if (header.alg !== "RS256" || typeof header.kid !== "string")
			throw new Error();
		const response = await fetcher(`${ISSUER}/.well-known/jwks.json`, {
			redirect: "error",
			signal: AbortSignal.timeout(10_000),
		});
		if (!response.ok) throw new Error();
		const text = await response.text();
		if (text.length > 100_000) throw new Error();
		const jwks = JSON.parse(text) as {
			keys?: Array<JsonWebKey & { kid?: string; alg?: string; use?: string }>;
		};
		const jwk = jwks.keys?.find(
			(key) =>
				key.kid === header.kid &&
				key.kty === "RSA" &&
				(!key.alg || key.alg === "RS256") &&
				(!key.use || key.use === "sig"),
		);
		if (
			!jwk ||
			!verify(
				"RSA-SHA256",
				Buffer.from(`${parts[0]}.${parts[1]}`),
				createPublicKey({ key: jwk, format: "jwk" }),
				Buffer.from(parts[2]!, "base64url"),
			)
		)
			throw new Error();
		const claims = JSON.parse(Buffer.from(parts[1]!, "base64url").toString());
		const aud = typeof claims.aud === "string" ? [claims.aud] : claims.aud;
		if (
			claims.iss !== ISSUER ||
			!Array.isArray(aud) ||
			!aud.includes(audience) ||
			(aud.length > 1 && claims.azp !== audience) ||
			(nonce !== null && claims.nonce !== nonce) ||
			typeof claims.sub !== "string" ||
			!claims.sub ||
			typeof claims.exp !== "number" ||
			claims.exp * 1000 <= now ||
			(claims.nbf !== undefined &&
				(typeof claims.nbf !== "number" || claims.nbf * 1000 > now))
		)
			throw new Error();
		const accountId = claims["https://api.openai.com/auth"]?.chatgpt_account_id;
		return {
			...(typeof accountId === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(accountId)
				? { accountId }
				: {}),
			sub: claims.sub,
			email:
				typeof claims.email === "string" && claims.email.length <= 320
					? claims.email
					: null,
		};
	} catch {
		throw new SiwcAuthError("invalid_id_token", 400);
	}
}
