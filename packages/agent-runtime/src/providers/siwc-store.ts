import {
	getProviderConnection,
	findProviderLoginByState,
	getProviderUserEmail,
	withProviderRefreshLock,
	type ProviderConnectionRecord,
	type ProviderConnectionUpdate,
	type ProviderLockedStore,
} from "@workspace/db";
export type SiwcStore = {
	get(userId: string): Promise<ProviderConnectionRecord | null>;
	ownerEmail(userId: string): Promise<string | null>;
	findState(hash: string): Promise<{ userId: string } | null>;
	lock<T>(
		userId: string,
		operation: (store: ProviderLockedStore) => Promise<T>,
	): Promise<T>;
};
export const databaseSiwcStore: SiwcStore = {
	get: (userId) => getProviderConnection(userId, "chatgpt"),
	ownerEmail: getProviderUserEmail,
	findState: findProviderLoginByState,
	lock: (userId, operation) =>
		withProviderRefreshLock(userId, "chatgpt", operation),
};
export type SiwcSecrets = {
	hostId?: string;
	clientId?: string;
	subject?: string;
	accessToken?: string;
	refreshToken?: string;
	idToken?: string;
	earliestRefreshAt?: number;
	/** `codex`: login por código de dispositivo; chamadas vão ao backend do plano ChatGPT. */
	flow?: "codex";
	/** `chatgpt_account_id` do id_token (cabeçalho `ChatGPT-Account-ID`). */
	accountId?: string;
	/** Login por código em andamento; o `deviceAuthId` nunca sai do servidor. */
	device?: {
		deviceAuthId: string;
		userCode: string;
		intervalMs: number;
		expiresAt: number;
		lastPollAt?: number;
	};
	login?: {
		verifier: string;
		nonce: string;
		createdAt: number;
		redirectUri: string;
	};
};
export type SiwcStatus = {
	provider: "chatgpt";
	status: "connected" | "disconnected" | "needs_login" | "error";
	accountEmail: string | null;
	updatedAt: string | null;
	lastLimitAt: string | null;
	lastError?: string | null;
};
export type {
	ProviderConnectionRecord,
	ProviderConnectionUpdate,
	ProviderLockedStore,
};
