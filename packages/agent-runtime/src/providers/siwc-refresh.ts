import { openSecrets, sealSecrets } from "../secrets/secret-box.js";
import {
	CODEX_SCOPE_MARK,
	CODEX_TOKEN_URL,
	SIWC_RESOURCE,
	SiwcAuthError,
	isFatalSiwcError,
	tokenRequest,
	type SiwcTokens,
} from "./siwc-protocol.js";
import type { SiwcSecrets, SiwcStore } from "./siwc-store.js";
const hasPlanScope = (scopes: readonly string[]) =>
	scopes.includes("chatgpt.tokens.use.direct") || scopes.includes(CODEX_SCOPE_MARK);
export type SiwcAccessOptions = {
	force?: boolean;
	previousAccessToken?: string;
};
export function createSiwcAccessTokens(deps: {
	store: SiwcStore;
	fetcher: typeof fetch;
	now: () => number;
	key: () => Buffer | null;
	authorize: (userId: string) => Promise<void>;
	identity: (secrets: SiwcSecrets) => SiwcSecrets;
	tokensData: (base: SiwcSecrets, tokens: SiwcTokens) => SiwcSecrets;
}) {
	const inFlight = new Map<string, Promise<string>>();
	async function markNeedsLogin(userId: string) {
		await deps.authorize(userId);
		await deps.store.lock(userId, async (locked) => {
			const row = await locked.get(),
				secrets = openSecrets<SiwcSecrets>(row?.secretsEnc, deps.key());
			await locked.update({
				status: "needs_login",
				secretsEnc: sealSecrets(deps.identity(secrets), deps.key()),
				accessExpiresAt: null,
				scopes: [],
				oauthStateHash: null,
				lastError: "needs_login",
			});
		});
	}
	async function refresh(
		userId: string,
		options: SiwcAccessOptions,
	): Promise<string> {
		const initial = await deps.store.get(userId);
		const old = openSecrets<SiwcSecrets>(initial?.secretsEnc, deps.key());
		if (
			!options.force &&
			initial?.status === "connected" &&
			old.accessToken &&
			hasPlanScope(initial.scopes) &&
			(initial.accessExpiresAt?.getTime() ?? 0) - deps.now() > 120_000
		)
			return old.accessToken;
		const previous = options.previousAccessToken ?? old.accessToken;
		let rotated = false;
		let outcome: string | SiwcAuthError;
		try {
			outcome = await deps.store.lock(userId, async (locked) => {
				const row = await locked.get(),
					secrets = openSecrets<SiwcSecrets>(row?.secretsEnc, deps.key());
				if (
					row?.status !== "connected" ||
					!secrets.accessToken ||
					!secrets.clientId ||
					!hasPlanScope(row.scopes)
				)
					return new SiwcAuthError("needs_login", 401);
				const remains = (row.accessExpiresAt?.getTime() ?? 0) - deps.now();
				if (!secrets.refreshToken) {
					// Login sem refresh_token: usa o access token até expirar, depois pede novo login.
					if (remains > 0 && !options.force) return secrets.accessToken;
					await locked.update({
						status: "needs_login",
						secretsEnc: sealSecrets(deps.identity(secrets), deps.key()),
						accessExpiresAt: null,
						scopes: [],
						oauthStateHash: null,
						lastError: "needs_login",
					});
					return new SiwcAuthError("needs_login", 401);
				}
				// Releitura após lock evita reusar refresh token rotacionado por outro processo.
				if (
					remains > 120_000 &&
					(!options.force || secrets.accessToken !== previous)
				)
					return secrets.accessToken;
				if (
					secrets.earliestRefreshAt &&
					deps.now() < secrets.earliestRefreshAt
				) {
					if (remains > 0 && !options.force) return secrets.accessToken;
					return new SiwcAuthError("refresh_not_available");
				}
				try {
					const codex = secrets.flow === "codex";
					const tokens = await tokenRequest(
						deps.fetcher,
						new URLSearchParams({
							grant_type: "refresh_token",
							client_id: secrets.clientId,
							refresh_token: secrets.refreshToken,
							...(codex ? {} : { resource: SIWC_RESOURCE }),
						}),
						undefined,
						codex ? { url: CODEX_TOKEN_URL, json: true, codex: true } : {},
					);
					rotated = true;
					await locked.update({
						status: "connected",
						secretsEnc: sealSecrets(
							deps.tokensData(secrets, tokens),
							deps.key(),
						),
						accessExpiresAt: new Date(deps.now() + tokens.expires_in * 1000),
						scopes: tokens.scope.split(/\s+/),
						lastError: null,
					});
					return tokens.access_token;
				} catch (error) {
					if (rotated) throw error; // Falha de persistência: transação seguinte limpa credenciais incertas.
					if (
						isFatalSiwcError(error) ||
						(error instanceof SiwcAuthError &&
							error.code.startsWith("invalid_token_response"))
					) {
						await locked.update({
							status: "needs_login",
							secretsEnc: sealSecrets(deps.identity(secrets), deps.key()),
							accessExpiresAt: null,
							scopes: [],
							oauthStateHash: null,
							lastError:
								error instanceof SiwcAuthError &&
								error.code.startsWith("invalid_token_response")
									? error.code
									: "needs_login",
						});
						return new SiwcAuthError("needs_login", 401);
					}
					return new SiwcAuthError("token_unavailable");
				}
			});
		} catch {
			if (rotated) {
				await markNeedsLogin(userId);
				throw new SiwcAuthError("needs_login", 401);
			}
			throw new SiwcAuthError("token_unavailable");
		}
		// Erro fatal lançado somente após COMMIT da limpeza (nunca rollback de needs_login).
		if (outcome instanceof SiwcAuthError) throw outcome;
		return outcome;
	}
	async function getAccessToken(
		userId: string,
		options: SiwcAccessOptions = {},
	): Promise<string> {
		await deps.authorize(userId);
		const pending = inFlight.get(userId);
		if (pending) {
			const token = await pending;
			if (
				!options.force ||
				(options.previousAccessToken && token !== options.previousAccessToken)
			)
				return token;
			// Um 401 não pode herdar a chamada normal em voo que devolveu o mesmo token.
			if (inFlight.get(userId) === pending) inFlight.delete(userId);
			return getAccessToken(userId, {
				...options,
				previousAccessToken: options.previousAccessToken ?? token,
			});
		}
		const promise = refresh(userId, options);
		inFlight.set(userId, promise);
		try {
			return await promise;
		} finally {
			if (inFlight.get(userId) === promise) inFlight.delete(userId);
		}
	}
	return { getAccessToken, markNeedsLogin };
}
