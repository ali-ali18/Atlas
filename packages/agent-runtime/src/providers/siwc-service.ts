import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
	readConnectorKey,
	sealSecrets,
	openSecrets,
} from "../secrets/secret-box.js";
import {
	SIWC_AUTHORIZE_URL,
	SIWC_RESOURCE,
	SIWC_SCOPE,
	SiwcAuthError,
	tokenRequest,
	verifySiwcIdToken,
	type SiwcTokens,
} from "./siwc-protocol.js";
import {
	databaseSiwcStore,
	type SiwcStore,
	type SiwcSecrets,
	type SiwcStatus,
} from "./siwc-store.js";
import { createSiwcAccessTokens } from "./siwc-refresh.js";
import { createSiwcDeviceFlow } from "./siwc-device.js";
import { accountChatgptGate, envChatgptGate, type ChatgptGateResolver } from "./chatgpt-gate.js";
const TTL_MS = 15 * 60_000;
const stateHash = (state: string) =>
	createHash("sha256").update(state).digest("hex");
const identity = (secrets: SiwcSecrets): SiwcSecrets => ({
	hostId: secrets.hostId,
	// Cliente do fluxo Codex não serve ao login loopback: não sobrevive a desconectar/reconectar.
	clientId: secrets.flow === "codex" ? undefined : secrets.clientId,
	subject: secrets.subject,
});
export type SiwcDependencies = {
	/** Porta do plano por usuário. Omitido = só o env (`ATLAS_PROVIDER_CHATGPT_ENABLED`). */
	gate?: ChatgptGateResolver;
	store?: SiwcStore;
	fetch?: typeof fetch;
	now?: () => number;
	env?: NodeJS.ProcessEnv;
	verifyIdToken?: (
		token: string,
		audience: string,
		nonce: string,
	) => Promise<{ sub: string; email: string | null; accountId?: string }>;
};
export function createChatgptAuthService(dependencies: SiwcDependencies = {}) {
	const store = dependencies.store ?? databaseSiwcStore,
		fetcher = dependencies.fetch ?? fetch;
	const now = dependencies.now ?? Date.now,
		env = dependencies.env ?? process.env;
	const key = () => readConnectorKey(env);
	const gate = dependencies.gate ?? envChatgptGate(env);
	/**
	 * Dono sempre; plano ligado para ESTE usuário (conta > env) salvo em
	 * `requireEnabled: false` (desconectar apaga tokens mesmo com o plano desligado).
	 */
	async function authorize(userId: string, options: { requireEnabled?: boolean } = {}) {
		if (options.requireEnabled !== false && !(await gate(userId)).enabled)
			throw new SiwcAuthError("not_found", 404);
		const email = await store.ownerEmail(userId),
			owner = env.ATLAS_OWNER_EMAIL?.trim().toLowerCase();
		if (!owner || email?.trim().toLowerCase() !== owner)
			throw new SiwcAuthError("not_found", 404);
		if (!key()) throw new SiwcAuthError("vault_unavailable", 503);
	}
	function tokensData(base: SiwcSecrets, tokens: SiwcTokens) {
		if (base.flow === "codex")
			return {
				...identity(base),
				clientId: base.clientId,
				flow: "codex" as const,
				...(base.accountId ? { accountId: base.accountId } : {}),
				accessToken: tokens.access_token,
				...(tokens.refresh_token ?? base.refreshToken
					? { refreshToken: tokens.refresh_token ?? base.refreshToken }
					: {}),
				...(tokens.id_token ?? base.idToken
					? { idToken: tokens.id_token ?? base.idToken }
					: {}),
			};
		return {
			...identity(base),
			accessToken: tokens.access_token,
			// Sem refresh_token novo mantém o anterior; troca inicial sem ele fica sem renovação.
			...(tokens.refresh_token ?? base.refreshToken
				? { refreshToken: tokens.refresh_token ?? base.refreshToken }
				: {}),
			...(tokens.id_token ? { idToken: tokens.id_token } : {}),
			...(tokens.earliestRefreshAt
				? { earliestRefreshAt: tokens.earliestRefreshAt }
				: {}),
		};
	}
	async function status(userId: string): Promise<SiwcStatus> {
		await authorize(userId);
		const row = await store.get(userId);
		return {
			provider: "chatgpt",
			status:
				row?.status === "connected" ||
				row?.status === "needs_login" ||
				row?.status === "error"
					? row.status
					: "disconnected",
			accountEmail: row?.accountEmail ?? null,
			updatedAt: row?.updatedAt.toISOString() ?? null,
			lastLimitAt: row?.lastLimitAt?.toISOString() ?? null,
			// Só o código do protocolo (sem valores): a UI o traduz em mensagem curta.
			lastError: row?.status === "connected" ? null : (row?.lastError ?? null),
		};
	}
	async function connect(userId: string) {
		await authorize(userId);
		const port = Number(env.ATLAS_SIWC_CALLBACK_PORT ?? 53682);
		if (!Number.isInteger(port) || port < 1024 || port > 65535)
			throw new SiwcAuthError("invalid_callback_port");
		return store.lock(userId, async (locked) => {
			const row = await locked.get(),
				previous = openSecrets<SiwcSecrets>(row?.secretsEnc, key());
			const prior = previous.flow === "codex" ? identity(previous) : previous;
			const base = {
				...prior,
				hostId: prior.hostId ?? `urn:uuid:${randomUUID()}`,
			};
			const state = randomBytes(32).toString("base64url"),
				verifier = randomBytes(32).toString("base64url"),
				nonce = randomBytes(32).toString("base64url");
			const redirectUri = `http://127.0.0.1:${port}/callback`;
			const params = new URLSearchParams({
				response_type: "code",
				client_id: base.clientId ?? "dynamic_agent_client",
				redirect_uri: redirectUri,
				scope: SIWC_SCOPE,
				resource: SIWC_RESOURCE,
				state,
				nonce,
				code_challenge_method: "S256",
				code_challenge: createHash("sha256")
					.update(verifier)
					.digest("base64url"),
				ext_agent_host_id: base.hostId,
			});
			if (!base.clientId) params.set("agent_name_hint", "Atlas");
			await locked.update({
				oauthStateHash: stateHash(state),
				secretsEnc: sealSecrets(
					{
						...base,
						login: { verifier, nonce, createdAt: now(), redirectUri },
					},
					key(),
				),
				lastError: null,
			});
			return { authorizeUrl: `${SIWC_AUTHORIZE_URL}?${params}` };
		});
	}
	async function callback(params: URLSearchParams): Promise<void> {
		const state = params.get("state");
		if (!state || !/^[A-Za-z0-9_-]{43}$/.test(state))
			throw new SiwcAuthError("invalid_state", 400);
		// state de uso único → userId → plano ligado e dono; o callback não tem sessão.
		const found = await store.findState(stateHash(state));
		if (!found) throw new SiwcAuthError("invalid_state", 400);
		await authorize(found.userId);

		const claim = await store.lock(found.userId, async (locked) => {
			const row = await locked.get(),
				saved = openSecrets<SiwcSecrets>(row?.secretsEnc, key());
			if (
				row?.oauthStateHash !== stateHash(state) ||
				!saved.login ||
				now() - saved.login.createdAt > TTL_MS ||
				now() < saved.login.createdAt
			)
				return new SiwcAuthError("invalid_state", 400);
			const login = saved.login,
				base = identity(saved),
				issued = params.get("client_id") ?? base.clientId;
			const code = params.get("code");
			const valid =
				!params.has("error") &&
				issued &&
				/^oaiapp_[A-Za-z0-9_-]{1,200}$/.test(issued) &&
				(!base.clientId || base.clientId === issued) &&
				code &&
				code.length <= 4096;
			if (valid) base.clientId = issued;
			// COMMIT do state consumido e client emitido antes de qualquer troca de código.
			// Nonce retido no cofre é a geração do login: disconnect/reconnect invalidam o acabamento antigo.
			await locked.update({
				oauthStateHash: null,
				status: "needs_login",
				accessExpiresAt: null,
				scopes: [],
				accountEmail: null,
				secretsEnc: sealSecrets(valid ? { ...base, login } : base, key()),
				lastError: valid ? null : "authorization_failed",
			});
			return valid
				? { login, base, issued, code }
				: new SiwcAuthError("authorization_failed", 400);
		});
		if (claim instanceof SiwcAuthError) throw claim;
		try {
			const tokens = await tokenRequest(
				fetcher,
				new URLSearchParams({
					grant_type: "authorization_code",
					client_id: claim.issued,
					code: claim.code,
					code_verifier: claim.login.verifier,
					redirect_uri: claim.login.redirectUri,
					resource: SIWC_RESOURCE,
				}),
			);
			if (!tokens.id_token) throw new SiwcAuthError("invalid_id_token", 400);
			const id = await (dependencies.verifyIdToken
				? dependencies.verifyIdToken(
						tokens.id_token,
						claim.issued,
						claim.login.nonce,
					)
				: verifySiwcIdToken(
						tokens.id_token,
						claim.issued,
						claim.login.nonce,
						fetcher,
						now(),
					));
			if (claim.base.subject && claim.base.subject !== id.sub)
				throw new SiwcAuthError("account_mismatch", 400);
			claim.base.subject = id.sub;
			const applied = await store.lock(found.userId, async (locked) => {
				const row = await locked.get(),
					current = openSecrets<SiwcSecrets>(row?.secretsEnc, key());
				if (
					row?.oauthStateHash !== null ||
					current.login?.nonce !== claim.login.nonce
				)
					return false;
				await locked.update({
					status: "connected",
					secretsEnc: sealSecrets(tokensData(claim.base, tokens), key()),
					accountEmail: id.email,
					scopes: tokens.scope.split(/\s+/),
					accessExpiresAt: new Date(now() + tokens.expires_in * 1000),
					lastError: null,
					lastLimitAt: null,
				});
				return true;
			});
			if (!applied) throw new SiwcAuthError("authorization_cancelled", 400);
		} catch (error) {
			const safe =
				error instanceof SiwcAuthError
					? error
					: new SiwcAuthError("authorization_failed");
			await store.lock(found.userId, async (locked) => {
				const row = await locked.get(),
					current = openSecrets<SiwcSecrets>(row?.secretsEnc, key());
				if (
					row?.oauthStateHash === null &&
					current.login?.nonce === claim.login.nonce
				)
					await locked.update({
						status: "needs_login",
						secretsEnc: sealSecrets(identity(current), key()),
						accessExpiresAt: null,
						scopes: [],
						accountEmail: null,
						lastError: safe.code,
					});
			});
			throw safe;
		}
	}

	async function disconnect(
		userId: string,
	): Promise<{ revocationConfirmed: boolean }> {
		await authorize(userId, { requireEnabled: false });
		const saved = await store.lock(userId, async (locked) => {
			const row = await locked.get(),
				secrets = openSecrets<SiwcSecrets>(row?.secretsEnc, key());
			await locked.update({
				status: "disconnected",
				secretsEnc: sealSecrets(identity(secrets), key()),
				oauthStateHash: null,
				accessExpiresAt: null,
				scopes: [],
				accountEmail: null,
				lastError: null,
				lastLimitAt: null,
			});
			return secrets;
		});
		// COMMIT local precede a tentativa remota; resultado nunca contém as credenciais.
		if (!saved.refreshToken || !saved.clientId)
			return { revocationConfirmed: false };
		try {
			const meta = await fetcher(
				"https://auth.openai.com/.well-known/openid-configuration",
				{ redirect: "error", signal: AbortSignal.timeout(5000) },
			);
			if (!meta.ok) return { revocationConfirmed: false };
			const json = (await meta.json()) as { revocation_endpoint?: unknown };
			if (typeof json.revocation_endpoint !== "string")
				return { revocationConfirmed: false };
			const url = new URL(json.revocation_endpoint);
			if (
				url.origin !== "https://auth.openai.com" ||
				url.username ||
				url.password ||
				url.search ||
				url.hash
			)
				return { revocationConfirmed: false };
			const response = await fetcher(url, {
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded" },
				redirect: "error",
				signal: AbortSignal.timeout(5000),
				body: new URLSearchParams({
					client_id: saved.clientId,
					token: saved.refreshToken,
					token_type_hint: "refresh_token",
				}),
			});
			return { revocationConfirmed: response.ok };
		} catch {
			return { revocationConfirmed: false };
		}
	}

	const device = createSiwcDeviceFlow({
		store,
		fetcher,
		now,
		key,
		authorize,
		identity,
		verifyIdToken: dependencies.verifyIdToken
			? (token, audience, nonce) =>
					dependencies.verifyIdToken!(token, audience, nonce ?? "")
			: undefined,
	});
	/** Conta do ChatGPT para o cabeçalho `ChatGPT-Account-ID`; `null` fora do fluxo Codex. */
	async function getAccountId(userId: string): Promise<string | null> {
		await authorize(userId);
		const row = await store.get(userId),
			secrets = openSecrets<SiwcSecrets>(row?.secretsEnc, key());
		return secrets.flow === "codex" ? (secrets.accountId ?? null) : null;
	}
	const access = createSiwcAccessTokens({
		store,
		fetcher,
		now,
		key,
		authorize,
		identity,
		tokensData,
	});
	/** Só confere o dono (e o cofre), com o plano ligado ou não: 404 para quem não é dono. */
	const assertOwner = (userId: string) => authorize(userId, { requireEnabled: false });
	return {
		status,
		assertOwner,
		connect,
		callback,
		startDeviceLogin: device.start,
		pollDeviceLogin: device.poll,
		getAccountId,
		disconnect,
		getAccessToken: access.getAccessToken,
		markNeedsLogin: access.markNeedsLogin,
	};
}
export type ChatgptAuthService = ReturnType<typeof createChatgptAuthService>;
export const chatgptAuthService = createChatgptAuthService({ gate: accountChatgptGate() });
