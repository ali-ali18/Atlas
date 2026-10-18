import { createHmac } from "node:crypto";

/**
 * Cofre dos segredos de conectores MCP (tokens OAuth, client info, api key,
 * headers). AES-256-GCM com `CONNECTOR_ENCRYPTION_KEY` (32 bytes em base64).
 * Formato: `v1:<iv>:<tag>:<ciphertext>` (base64). Sem chave válida o
 * marketplace fica desligado — nunca grava segredo em claro.
 */

export type McpOAuthSecrets = {
	tokens?: Record<string, unknown>;
	/** Quando `tokens` foi salvo (epoch ms) — base para saber se `expires_in` já passou. */
	tokensSavedAt?: number;
	clientInformation?: Record<string, unknown>;
	codeVerifier?: string;
	/** URL de autorização pendente (devolvida à UI para abrir o popup). */
	authorizationUrl?: string;
	/** Início do login pendente (epoch ms): o callback recusa `state` velho. */
	stateCreatedAt?: number;
};

export type McpConnectorSecrets = {
	apiKey?: string;
	/** URL real quando a credencial vai na própria URL (a coluna guarda a versão pública). */
	url?: string;
	headers?: Record<string, string>;
	/** Composio: apps sem login ativados (viram `no_auth_apps` do servidor MCP). */
	noAuthApps?: string[];
	oauth?: McpOAuthSecrets;
};

import {
	sealSecrets as sealObject,
	openSecrets as openObject,
	readConnectorKey,
} from "../secrets/secret-box.js";
export {
	SecretBoxError,
	readConnectorKey,
	isSecretBoxConfigured,
} from "../secrets/secret-box.js";
export function sealSecrets<T extends object = McpConnectorSecrets>(
	secrets: T,
	key?: Buffer | null,
): string {
	return sealObject(secrets, key);
}
export function openSecrets<T extends object = McpConnectorSecrets>(
	sealed: string | null | undefined,
	key?: Buffer | null,
): T {
	return openObject<T>(sealed, key);
}

/** Info fixa do HMAC; mudar quebraria assinaturas anteriores. */
const GITHUB_WEBHOOK_HMAC_INFO = "atlas:github-webhook:v1";

/**
 * Secret do webhook do GitHub (gatilho de rotina) — derivado de forma
 * unidirecional a partir da MESMA `CONNECTOR_ENCRYPTION_KEY` do cofre de
 * conectores (sem env var própria: um segredo a menos pra configurar/vazar).
 * `HMAC-SHA256(CONNECTOR_ENCRYPTION_KEY, "atlas:github-webhook:v1")` em hex —
 * estável (mesma chave => mesmo secret sempre), nunca reversível pra achar a
 * chave. `undefined` sem `CONNECTOR_ENCRYPTION_KEY` configurada (nunca lança,
 * nunca loga o valor derivado).
 */
export function getGithubWebhookSecret(
	env: NodeJS.ProcessEnv = process.env,
): string | undefined {
	const key = readConnectorKey(env);
	if (!key) return undefined;
	return createHmac("sha256", key)
		.update(GITHUB_WEBHOOK_HMAC_INFO)
		.digest("hex");
}

/** Valores sensíveis em claro, para redigir de mensagens de erro/resultado. */
export function secretValues(secrets: McpConnectorSecrets): string[] {
	const values: string[] = [];
	if (secrets.apiKey) values.push(secrets.apiKey);
	if (secrets.url) values.push(secrets.url);
	for (const value of Object.values(secrets.headers ?? {})) values.push(value);
	const tokens = secrets.oauth?.tokens ?? {};
	for (const name of ["access_token", "refresh_token", "id_token"]) {
		const value = tokens[name];
		if (typeof value === "string") values.push(value);
	}
	const secret = secrets.oauth?.clientInformation?.client_secret;
	if (typeof secret === "string") values.push(secret);
	return values.filter((value) => value.length >= 6);
}
