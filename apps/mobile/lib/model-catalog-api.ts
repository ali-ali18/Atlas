// Leitura do catálogo do seletor: os mesmos endpoints do web, sempre por `apiFetch` (a sessão só sai para o servidor salvo).
// O web soma três fontes (`apps/web/components/model-picker.tsx`): o catálogo geral (`/v1/models`), o plano ChatGPT
// (`/v1/providers` + `/v1/providers/chatgpt/models`, só conectado) e as chaves próprias (`/v1/provider-keys` +
// `/v1/provider-keys/:provider/models`, só as conectadas). Aqui é a mesma montagem.
import { ChatApiError } from "./chat-api";
import type { ApiFetch } from "./home-sync";
import { buildCatalog, parseBotInfo, parseModels, parseTierModelIds, type ModelCatalog, type RawModel } from "./model-catalog";

async function read(apiFetch: ApiFetch, path: string): Promise<unknown> {
	const response = await apiFetch(path, { headers: { accept: "application/json" } });
	if (!response.ok) throw new ChatApiError(response.statusText || `HTTP ${response.status}`, response.status);
	return response.json();
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Provedores conectados de uma lista (`{ providers: [{ provider, status }] }`). */
function connected(body: unknown, only?: string): string[] {
	if (!isRecord(body) || !Array.isArray(body.providers)) return [];
	return body.providers.flatMap((entry) => (isRecord(entry) && typeof entry.provider === "string" && entry.status === "connected" && (!only || entry.provider === only) ? [entry.provider] : []));
}

/**
 * Catálogo do bot. O catálogo geral é obrigatório (falha = erro, a folha oferece "tentar de novo"); níveis da conta, modelo
 * do bot e provedores são complementos: se falharem, o seletor segue sem eles (`complete: false` quando uma fonte de
 * provedor falhou, para não descartar como "sumido" um modelo que só não deu para conferir). 401 sobe sempre.
 */
export async function fetchModelCatalog(apiFetch: ApiFetch, botId: string): Promise<ModelCatalog> {
	let complete = true;
	const optional = async (path: string, source?: "provider" | "plan"): Promise<unknown> => {
		try {
			return await read(apiFetch, path);
		} catch (reason) {
			if (reason instanceof ChatApiError && reason.status === 401) throw reason;
			// 403/404 no plano ChatGPT = recurso desligado nesta conta (o web esconde o grupo): não é falha.
			// Só as fontes de provedor entram em `complete` (níveis e bot são outro assunto).
			if (source && !(reason instanceof ChatApiError && (reason.status === 403 || reason.status === 404) && source === "plan")) complete = false;
			return null;
		}
	};
	const [modelsBody, settingsBody, botsBody, providersBody, keysBody] = await Promise.all([
		read(apiFetch, "/v1/models"),
		optional("/v1/settings"),
		optional("/v1/bots"),
		optional("/v1/providers", "plan"),
		optional("/v1/provider-keys", "plan"),
	]);
	const models = parseModels(modelsBody);
	if (!models) throw new ChatApiError("Resposta inesperada do servidor.", 502);
	const extraPaths = [...connected(providersBody, "chatgpt").map(() => "/v1/providers/chatgpt/models"), ...connected(keysBody).map((provider) => `/v1/provider-keys/${encodeURIComponent(provider)}/models`)];
	const extra = await Promise.all(extraPaths.map((path) => optional(path, "provider")));
	const all: RawModel[] = [...models];
	const seen = new Set(all.map((model) => model.id));
	for (const body of extra) {
		for (const model of parseModels(body) ?? []) {
			if (!seen.has(model.id)) {
				seen.add(model.id);
				all.push(model);
			}
		}
	}
	// Se um dos provedores conectados não deu modelo nenhum (falha ou resposta torta) a lista fica incompleta.
	if (extra.some((body) => parseModels(body) === null)) complete = false;
	return buildCatalog({ models: all, tierIds: parseTierModelIds(settingsBody), bot: parseBotInfo(botsBody, botId), complete });
}
