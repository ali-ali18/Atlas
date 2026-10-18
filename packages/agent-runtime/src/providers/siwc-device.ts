import { openSecrets, sealSecrets } from "../secrets/secret-box.js";
import {
	CODEX_CLIENT_ID,
	CODEX_DEVICE_API,
	CODEX_DEVICE_REDIRECT_URI,
	CODEX_DEVICE_VERIFY_URL,
	CODEX_TOKEN_URL,
	SiwcAuthError,
	tokenRequest,
	verifySiwcIdToken,
} from "./siwc-protocol.js";
import type { SiwcSecrets, SiwcStore } from "./siwc-store.js";

/** Mesmo teto do Codex CLI: 15 minutos para o usuário digitar o código. */
const MAX_WAIT_MS = 15 * 60_000;
const MIN_INTERVAL_MS = 3_000;
const MAX_INTERVAL_MS = 30_000;
const USER_CODE = /^[A-Za-z0-9-]{4,32}$/;
const DEVICE_ID = /^[A-Za-z0-9_.:-]{1,256}$/;

export type DeviceStart = {
	userCode: string;
	verificationUrl: string;
	/** ISO. */
	expiresAt: string;
	intervalSeconds: number;
};
export type DevicePoll =
	| { status: "pending"; expiresAt: string; intervalSeconds: number }
	| { status: "connected" }
	| { status: "expired" }
	| { status: "none" };

/**
 * Login por código de dispositivo (Codex CLI `--device-auth`): o servidor pede o
 * código, o usuário o digita em auth.openai.com/codex/device e o servidor faz o
 * polling. Não há redirect, então funciona em Atlas remoto. O `device_auth_id`
 * fica só no cofre do usuário da sessão.
 */
export function createSiwcDeviceFlow(deps: {
	store: SiwcStore;
	fetcher: typeof fetch;
	now: () => number;
	key: () => Buffer | null;
	authorize: (userId: string) => Promise<void>;
	identity: (secrets: SiwcSecrets) => SiwcSecrets;
	verifyIdToken?: (
		token: string,
		audience: string,
		nonce: string | null,
	) => Promise<{ sub: string; email: string | null; accountId?: string }>;
}) {
	async function postJson(url: string, body: unknown): Promise<Response> {
		try {
			return await deps.fetcher(url, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
				redirect: "error",
				signal: AbortSignal.timeout(10_000),
			});
		} catch {
			throw new SiwcAuthError("device_unavailable");
		}
	}
	async function readJson(response: Response): Promise<Record<string, unknown>> {
		try {
			const text = await response.text();
			if (text.length > 100_000) throw new Error();
			const data = JSON.parse(text);
			if (!data || typeof data !== "object") throw new Error();
			return data as Record<string, unknown>;
		} catch {
			throw new SiwcAuthError("device_invalid_response");
		}
	}

	async function start(userId: string): Promise<DeviceStart> {
		await deps.authorize(userId);
		const response = await postJson(`${CODEX_DEVICE_API}/usercode`, {
			client_id: CODEX_CLIENT_ID,
		});
		if (!response.ok)
			throw new SiwcAuthError(
				response.status === 404 ? "device_not_enabled" : "device_unavailable",
			);
		const data = await readJson(response);
		const userCode = data.user_code ?? data.usercode;
		const interval = Number(data.interval ?? 5);
		if (
			typeof userCode !== "string" ||
			!USER_CODE.test(userCode) ||
			typeof data.device_auth_id !== "string" ||
			!DEVICE_ID.test(data.device_auth_id)
		)
			throw new SiwcAuthError("device_invalid_response");
		const intervalMs = Math.min(
			Math.max(Number.isFinite(interval) ? interval * 1000 : 5000, MIN_INTERVAL_MS),
			MAX_INTERVAL_MS,
		);
		const expiresAt = deps.now() + MAX_WAIT_MS;
		await deps.store.lock(userId, async (locked) => {
			const row = await locked.get(),
				secrets = openSecrets<SiwcSecrets>(row?.secretsEnc, deps.key());
			await locked.update({
				secretsEnc: sealSecrets(
					{
						...secrets,
						device: {
							deviceAuthId: data.device_auth_id as string,
							userCode,
							intervalMs,
							expiresAt,
						},
					},
					deps.key(),
				),
				lastError: null,
			});
		});
		return {
			userCode,
			verificationUrl: CODEX_DEVICE_VERIFY_URL,
			expiresAt: new Date(expiresAt).toISOString(),
			intervalSeconds: intervalMs / 1000,
		};
	}

	async function poll(userId: string): Promise<DevicePoll> {
		await deps.authorize(userId);
		return deps.store.lock(userId, async (locked): Promise<DevicePoll> => {
			const row = await locked.get(),
				secrets = openSecrets<SiwcSecrets>(row?.secretsEnc, deps.key());
			const device = secrets.device;
			if (!device) return { status: "none" };
			const clear = async (lastError: string | null) => {
				const rest: SiwcSecrets = { ...secrets };
				delete rest.device;
				await locked.update({
					secretsEnc: sealSecrets(rest, deps.key()),
					...(lastError ? { lastError } : {}),
				});
			};
			const now = deps.now();
			if (now >= device.expiresAt) {
				await clear("device_expired");
				return { status: "expired" };
			}
			const pending: DevicePoll = {
				status: "pending",
				expiresAt: new Date(device.expiresAt).toISOString(),
				intervalSeconds: device.intervalMs / 1000,
			};
			// Respeita o intervalo do provedor mesmo com vários clientes consultando.
			if (device.lastPollAt && now - device.lastPollAt < device.intervalMs)
				return pending;
			let response: Response;
			try {
				response = await postJson(`${CODEX_DEVICE_API}/token`, {
					device_auth_id: device.deviceAuthId,
					user_code: device.userCode,
				});
			} catch {
				return pending;
			}
			if (response.status === 403 || response.status === 404) {
				await locked.update({
					secretsEnc: sealSecrets(
						{ ...secrets, device: { ...device, lastPollAt: now } },
						deps.key(),
					),
				});
				return pending;
			}
			if (!response.ok) {
				await clear("device_failed");
				throw new SiwcAuthError("device_failed", 400);
			}
			try {
				const data = await readJson(response);
				const { authorization_code: code, code_verifier: verifier } = data;
				if (
					typeof code !== "string" ||
					!code ||
					code.length > 4096 ||
					typeof verifier !== "string" ||
					!verifier ||
					verifier.length > 4096
				)
					throw new SiwcAuthError("device_invalid_response");
				// A troca consome o código de uso único: sem retry, falha encerra o fluxo.
				const tokens = await tokenRequest(
					deps.fetcher,
					new URLSearchParams({
						grant_type: "authorization_code",
						code,
						redirect_uri: CODEX_DEVICE_REDIRECT_URI,
						client_id: CODEX_CLIENT_ID,
						code_verifier: verifier,
					}),
					undefined,
					{ url: CODEX_TOKEN_URL, json: false, codex: true },
				);
				if (!tokens.id_token) throw new SiwcAuthError("invalid_id_token", 400);
				const verify =
					deps.verifyIdToken ??
					((token, audience, nonce) =>
						verifySiwcIdToken(token, audience, nonce, deps.fetcher, deps.now()));
				const id = await verify(tokens.id_token, CODEX_CLIENT_ID, null);
				if (!id.accountId) throw new SiwcAuthError("invalid_id_token", 400);
				const base = deps.identity(secrets);
				if (base.subject && base.subject !== id.sub)
					throw new SiwcAuthError("account_mismatch", 400);
				await locked.update({
					status: "connected",
					oauthStateHash: null,
					secretsEnc: sealSecrets(
						{
							hostId: base.hostId,
							clientId: CODEX_CLIENT_ID,
							subject: id.sub,
							flow: "codex",
							accountId: id.accountId,
							accessToken: tokens.access_token,
							...(tokens.refresh_token ? { refreshToken: tokens.refresh_token } : {}),
							idToken: tokens.id_token,
						},
						deps.key(),
					),
					accountEmail: id.email,
					scopes: tokens.scope.split(/\s+/),
					accessExpiresAt: new Date(deps.now() + tokens.expires_in * 1000),
					lastError: null,
					lastLimitAt: null,
				});
				return { status: "connected" };
			} catch (error) {
				const safe =
					error instanceof SiwcAuthError ? error : new SiwcAuthError("device_failed", 400);
				await clear(safe.code);
				throw safe;
			}
		});
	}

	return { start, poll };
}
