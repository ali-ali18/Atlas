// Leitura do catálogo do seletor: os mesmos endpoints do web, sempre por `apiFetch` (a sessão só sai para o servidor salvo).
import { ChatApiError } from "./chat-api";
import type { ApiFetch } from "./home-sync";
import { buildCatalog, parseBotModel, parseModels, parseTierModelIds, type ModelCatalog } from "./model-catalog";

async function read(apiFetch: ApiFetch, path: string): Promise<unknown> {
	const response = await apiFetch(path, { headers: { accept: "application/json" } });
	if (!response.ok) throw new ChatApiError(response.statusText || `HTTP ${response.status}`, response.status);
	return response.json();
}

/**
 * Catálogo do bot. O catálogo de modelos é obrigatório (falha = erro, a folha oferece "tentar de novo"); níveis da conta e
 * modelo do bot são complementos: se falharem, o seletor segue sem os "principais" e sem o ✓ no modelo do bot.
 * 401 sobe sempre, para o app encerrar a sessão como no resto.
 */
export async function fetchModelCatalog(apiFetch: ApiFetch, botId: string): Promise<ModelCatalog> {
	const optional = async (path: string): Promise<unknown> => {
		try {
			return await read(apiFetch, path);
		} catch (reason) {
			if (reason instanceof ChatApiError && reason.status === 401) throw reason;
			return null;
		}
	};
	const [modelsBody, settingsBody, botsBody] = await Promise.all([read(apiFetch, "/v1/models"), optional("/v1/settings"), optional("/v1/bots")]);
	const models = parseModels(modelsBody);
	if (!models) throw new ChatApiError("Resposta inesperada do servidor.", 502);
	return buildCatalog({ models, tierIds: parseTierModelIds(settingsBody), botModel: parseBotModel(botsBody, botId) });
}
