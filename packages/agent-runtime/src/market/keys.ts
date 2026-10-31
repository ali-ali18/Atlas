import { getMcpConnectionByCatalogId, updateMcpConnection, type McpConnectionRecord } from "@workspace/db";
import { probeBrapiKey, type MarketKeys } from "@workspace/search";
import { isSecretBoxConfigured, openSecrets } from "../mcp/secret-box.js";

/**
 * Chaves das fontes de mercado: vivem no Marketplace como conexões do dono (entradas `data_source` do catálogo),
 * seladas em `secretsEnc` como qualquer outro conector. Nunca vêm de variável de ambiente do operador.
 *
 * `resolveMarketKeys` é escopado pelo dono do alerta: lê só a conexão desse `userId` (`ownerIds` no db, sem
 * "default" nem "qualquer um"), abre o cofre em memória e entrega a chave só para a chamada em curso.
 */
export const MARKET_KEY_CATALOG_IDS = { brapi: "brapi" } as const satisfies Record<keyof MarketKeys, string>;

export type MarketKeyDeps = {
	getConnection?: (catalogId: string, userId: string) => Promise<Pick<McpConnectionRecord, "status" | "secretsEnc"> | null>;
	boxReady?: () => boolean;
	open?: (sealed: string | null | undefined) => { apiKey?: string };
};

export async function resolveMarketKeys(userId: string | undefined, deps: MarketKeyDeps = {}): Promise<MarketKeys> {
	if (!userId || userId === "default") return {};
	if (!(deps.boxReady ?? isSecretBoxConfigured)()) return {};
	const getConnection = deps.getConnection ?? ((catalogId, owner) => getMcpConnectionByCatalogId(catalogId, owner));
	const keys: MarketKeys = {};
	for (const [provider, catalogId] of Object.entries(MARKET_KEY_CATALOG_IDS) as Array<[keyof MarketKeys, string]>) {
		const connection = await getConnection(catalogId, userId).catch(() => null);
		if (!connection || connection.status !== "connected" || !connection.secretsEnc) continue;
		try {
			const apiKey = (deps.open ?? openSecrets)(connection.secretsEnc).apiKey?.trim();
			if (apiKey) keys[provider] = apiKey;
		} catch {
			// cofre ilegível (chave de criptografia trocada): trata como sem chave; a UI pede para reconectar
		}
	}
	return keys;
}

/** Texto para o usuário quando a chave não passa no teste (nunca ecoa a chave). */
export async function probeMarketKey(catalogId: string, key: string, probe: (key: string) => Promise<void> = (value) => probeBrapiKey(value)): Promise<void> {
	if (catalogId !== MARKET_KEY_CATALOG_IDS.brapi) throw new Error("fonte de dados desconhecida");
	try {
		await probe(key);
	} catch (error) {
		const code = (error as { code?: string }).code;
		if (code === "auth") throw new Error("A brapi recusou essa chave. Confira se copiou o token inteiro do painel da brapi.");
		if (code === "rate_limit") throw new Error("A chave da brapi chegou ao limite do plano. Tente de novo mais tarde.");
		throw new Error("Não consegui validar a chave na brapi agora. Tente de novo em instantes.");
	}
}

const REJECTED_MESSAGE = "A brapi recusou a chave. Reconecte a brapi no Marketplace com uma chave válida.";

export type RejectedKeyDeps = {
	getConnection?: (catalogId: string, userId: string) => Promise<Pick<McpConnectionRecord, "id" | "status" | "secretsEnc"> | null>;
	update?: (id: string, patch: { status: "error"; lastError: string }, userId: string) => Promise<unknown>;
	open?: (sealed: string | null | undefined) => { apiKey?: string };
};

/**
 * A brapi recusou a chave (401/403, ex.: revogada): marca a conexão do DONO como erro. Assim o `propose_connector`
 * oferece o cartão de reconexão (conexão fora de "connected" = reconectar) e `resolveMarketKeys` deixa de entregar a
 * chave morta (sem beco sem saída: o alerta não fica pedindo uma chave que o usuário nunca vê como quebrada).
 * Escopado pelo dono (`ownerIds` no db) e só se a chave guardada ainda é a que foi recusada: se o usuário já
 * reconectou com outra enquanto a leitura rodava, não derruba a nova.
 */
export async function reportRejectedMarketKey(userId: string | undefined, rejectedKey: string, deps: RejectedKeyDeps = {}): Promise<boolean> {
	if (!userId || userId === "default" || !rejectedKey) return false;
	const getConnection = deps.getConnection ?? ((catalogId, owner) => getMcpConnectionByCatalogId(catalogId, owner));
	const connection = await getConnection(MARKET_KEY_CATALOG_IDS.brapi, userId).catch(() => null);
	if (!connection || connection.status !== "connected") return false;
	try {
		if ((deps.open ?? openSecrets)(connection.secretsEnc).apiKey?.trim() !== rejectedKey) return false;
	} catch {
		return false;
	}
	const update = deps.update ?? ((id, patch, owner) => updateMcpConnection(id, patch, owner));
	await update(connection.id, { status: "error", lastError: REJECTED_MESSAGE }, userId).catch(() => undefined);
	return true;
}

/**
 * Acesso às chaves de mercado do DONO durante uma leitura: entrega as chaves e, se a brapi recusar a usada, marca a
 * conexão do dono como erro. Usado pelo worker e pelo teste da criação.
 */
export function ownerMarketAccess(userId: string | undefined, deps: { resolveKeys?: (userId: string | undefined) => Promise<MarketKeys>; onRejected?: (userId: string | undefined, key: string) => Promise<unknown> } = {}) {
	let used: MarketKeys = {};
	return {
		getKeys: async (): Promise<MarketKeys> => {
			used = await (deps.resolveKeys ?? resolveMarketKeys)(userId);
			return used;
		},
		afterRead: async (result: { ok: boolean; code?: string }): Promise<void> => {
			if (!result.ok && result.code === "auth" && used.brapi) await (deps.onRejected ?? reportRejectedMarketKey)(userId, used.brapi).catch(() => undefined);
		},
	};
}
