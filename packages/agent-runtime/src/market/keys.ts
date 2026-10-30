import { getMcpConnectionByCatalogId, type McpConnectionRecord } from "@workspace/db";
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
