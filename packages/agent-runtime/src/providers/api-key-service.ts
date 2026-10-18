import type { ApiKeyProvider, ApiKeyProviderStatus } from "@workspace/shared";
import {
	deleteProviderConnection,
	getProviderConnection,
	saveProviderConnection,
	updateProviderConnection,
	type ProviderConnectionRecord,
	type ProviderConnectionUpdate,
} from "@workspace/db";
import { SecretBoxError, isSecretBoxConfigured, openSecrets, sealSecrets } from "../mcp/secret-box.js";

/** Conteúdo do envelope cifrado: a chave nunca é gravada em outro lugar. */
export type ApiKeySecrets = { apiKey: string; modelCount?: number };

export class ApiKeyServiceError extends Error {
	constructor(
		readonly code: "vault_unavailable" | "invalid_key" | "not_connected",
		readonly status: 400 | 404 | 503,
		message: string,
	) {
		super(message);
		this.name = "ApiKeyServiceError";
	}
}

export type ApiKeyStore = {
	get(userId: string, provider: ApiKeyProvider): Promise<ProviderConnectionRecord | null>;
	save(userId: string, provider: ApiKeyProvider, data: ProviderConnectionUpdate): Promise<unknown>;
	update(userId: string, provider: ApiKeyProvider, data: ProviderConnectionUpdate): Promise<unknown>;
	remove(userId: string, provider: ApiKeyProvider): Promise<unknown>;
};
const databaseStore: ApiKeyStore = {
	get: getProviderConnection,
	save: saveProviderConnection,
	update: updateProviderConnection,
	remove: deleteProviderConnection,
};

/** Chave plausível: sem espaços/controles, tamanho razoável. Nunca devolve nem registra o valor. */
export function normalizeApiKey(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const key = value.trim();
	// eslint-disable-next-line no-control-regex
	if (key.length < 8 || key.length > 512 || /[\s\u0000-\u001f\u007f]/.test(key)) return null;
	return key;
}

/**
 * Chaves de API do usuário (Anthropic, OpenCode Go) no cofre cifrado
 * (`ProviderConnection.secretsEnc`, AES-256-GCM com `CONNECTOR_ENCRYPTION_KEY`).
 */
export function createApiKeyService(deps: { store?: ApiKeyStore; vaultReady?: () => boolean } = {}) {
	const store = deps.store ?? databaseStore;
	const vaultReady = deps.vaultReady ?? (() => isSecretBoxConfigured());

	function open(row: ProviderConnectionRecord | null): ApiKeySecrets | null {
		if (!row?.secretsEnc) return null;
		try {
			const secrets = openSecrets<Partial<ApiKeySecrets>>(row.secretsEnc);
			return typeof secrets.apiKey === "string" && secrets.apiKey ? { apiKey: secrets.apiKey, modelCount: secrets.modelCount } : null;
		} catch (error) {
			if (error instanceof SecretBoxError) return null;
			throw error;
		}
	}

	return {
		vaultReady,
		async status(userId: string, provider: ApiKeyProvider): Promise<ApiKeyProviderStatus> {
			const row = await store.get(userId, provider);
			const secrets = row?.status === "connected" || row?.status === "error" ? open(row) : null;
			const connected = row?.status === "connected" && secrets !== null;
			return {
				provider,
				status: connected ? "connected" : row?.status === "error" ? "error" : "disconnected",
				modelCount: connected ? (secrets.modelCount ?? null) : null,
				updatedAt: row?.updatedAt.toISOString() ?? null,
				lastLimitAt: row?.lastLimitAt?.toISOString() ?? null,
				lastError: row?.status === "connected" ? null : (row?.lastError ?? null),
			};
		},
		/** Chave em claro, só para o servidor montar a chamada; `null` sem conexão. */
		async getKey(userId: string, provider: ApiKeyProvider): Promise<string | null> {
			const row = await store.get(userId, provider);
			return row?.status === "connected" ? (open(row)?.apiKey ?? null) : null;
		},
		async save(userId: string, provider: ApiKeyProvider, apiKey: unknown, modelCount?: number): Promise<void> {
			const key = normalizeApiKey(apiKey);
			if (!key) throw new ApiKeyServiceError("invalid_key", 400, "Chave inválida");
			if (!vaultReady()) throw new ApiKeyServiceError("vault_unavailable", 503, "Defina CONNECTOR_ENCRYPTION_KEY no .env da API e do worker");
			await store.save(userId, provider, {
				status: "connected",
				secretsEnc: sealSecrets<ApiKeySecrets>({ apiKey: key, ...(modelCount === undefined ? {} : { modelCount }) }),
				lastError: null,
			});
		},
		/** Atualiza só a contagem de modelos, mantendo a mesma chave. */
		async setModelCount(userId: string, provider: ApiKeyProvider, modelCount: number): Promise<void> {
			const row = await store.get(userId, provider);
			const secrets = open(row);
			if (!secrets || !vaultReady()) return;
			await store.update(userId, provider, { secretsEnc: sealSecrets<ApiKeySecrets>({ ...secrets, modelCount }) });
		},
		async markError(userId: string, provider: ApiKeyProvider, code: string): Promise<void> {
			await store.update(userId, provider, { lastError: code.slice(0, 40) });
		},
		async markLimitAt(userId: string, provider: ApiKeyProvider, at: Date): Promise<void> {
			await store.update(userId, provider, { lastLimitAt: at });
		},
		async remove(userId: string, provider: ApiKeyProvider): Promise<void> {
			await store.remove(userId, provider);
		},
	};
}
export type ApiKeyService = ReturnType<typeof createApiKeyService>;
export const apiKeyService = createApiKeyService();
