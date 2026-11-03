// Catálogo de modelos do seletor do chat, o mesmo que o web usa (`apps/web/components/model-picker.tsx`):
// `GET /v1/models` (catálogo), "principais" = modelos cadastrados nos níveis da conta (`GET /v1/settings`, igual ao
// grupo "Dos seus níveis" do web) e o modelo fixo do bot (`openRouterModel` de `GET /v1/bots`). Tudo puro: a rede fica
// em `model-catalog-api.ts`. Sem lista fixa de modelos: só o recorte de recomendados do `shared` quando a conta não
// cadastrou níveis (o mesmo fallback do web).
import {
	availableReasoningEfforts,
	formatContextTokens,
	getModelCapabilities,
	modelDisplayName,
	normalizeModelTiers,
	RECOMMENDED_MODELS,
	registeredTierModels,
	type ModelCatalogInfo,
	type ReasoningEffort,
} from "@workspace/shared";

/** Modelo como o seletor desenha: nome de exibição (sem id interno), uma linha de descrição e os níveis de raciocínio que aceita. */
export type ModelOption = {
	id: string;
	name: string;
	/** Uma linha: o que o modelo faz ("Lê imagens · Raciocínio · 200k de contexto"). Vazia quando o catálogo não diz nada. */
	description: string;
	/** Níveis de esforço (raciocínio) que o modelo aceita; vazio = sem a linha "Esforço". */
	efforts: ReasoningEffort[];
	info: ModelCatalogInfo;
};

export type ModelCatalog = {
	/** Modelo fixo do bot (`null` = o bot não fixa; vale o Automático). */
	botModel: string | null;
	featured: ModelOption[];
	others: ModelOption[];
};

export type RawModel = { id: string; name: string; info: ModelCatalogInfo };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const strings = (value: unknown): string[] | undefined => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : undefined);
const count = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null);

/** `GET /v1/models` -> `{ models }`. Resposta fora do formato = `null` (o seletor mostra "não consegui carregar"). */
export function parseModels(body: unknown): RawModel[] | null {
	if (!isRecord(body) || !Array.isArray(body.models)) return null;
	const out: RawModel[] = [];
	const seen = new Set<string>();
	for (const entry of body.models) {
		if (!isRecord(entry) || typeof entry.id !== "string" || !entry.id.trim() || seen.has(entry.id)) continue;
		seen.add(entry.id);
		const inputModalities = strings(entry.inputModalities);
		const supportedParameters = strings(entry.supportedParameters);
		out.push({
			id: entry.id,
			name: typeof entry.name === "string" ? entry.name : "",
			info: {
				contextLength: count(entry.contextLength),
				maxOutputTokens: count(entry.maxOutputTokens),
				...(inputModalities ? { inputModalities } : {}),
				...(supportedParameters ? { supportedParameters } : {}),
			},
		});
	}
	return out;
}

/** Modelos dos níveis da conta (`GET /v1/settings` -> `effective.models.tiers.value`), Fácil a Difícil, sem repetição. Falha = vazio. */
export function parseTierModelIds(body: unknown): string[] {
	if (!isRecord(body) || !isRecord(body.effective) || !isRecord(body.effective.models) || !isRecord(body.effective.models.tiers)) return [];
	return registeredTierModels(normalizeModelTiers(body.effective.models.tiers.value));
}

/** Modelo fixo do bot, lido da lista de bots do dono (`GET /v1/bots`). Sem bot ou sem modelo = `null`. */
export function parseBotModel(body: unknown, botId: string): string | null {
	if (!isRecord(body) || !Array.isArray(body.bots)) return null;
	const bot = body.bots.find((entry) => isRecord(entry) && entry.id === botId);
	const model = isRecord(bot) && typeof bot.openRouterModel === "string" ? bot.openRouterModel.trim() : "";
	return model || null;
}

/** "Lê imagens · Raciocínio · 200k de contexto": só o que o catálogo confirma. */
export function describeModel(id: string, info: ModelCatalogInfo): string {
	const caps = getModelCapabilities(id, info);
	const context = formatContextTokens(caps.contextTokens);
	return [caps.vision ? "Lê imagens" : null, caps.reasoning ? "Raciocínio" : null, context ? `${context} de contexto` : null].filter((part): part is string => part !== null).join(" · ");
}

export function toOption(model: RawModel): ModelOption {
	return { id: model.id, name: modelDisplayName(model.name, model.id), description: describeModel(model.id, model.info), efforts: availableReasoningEfforts(model.id, model.info), info: model.info };
}

/** Modelo que o catálogo não lista (ex.: o fixo do bot vindo de outro provedor): aparece pelo nome, nunca pelo id cru com prefixo. */
export function unlistedOption(id: string): ModelOption {
	return toOption({ id, name: "", info: {} });
}

/**
 * Principais = o fixo do bot + os dos níveis da conta (sem níveis cadastrados, os recomendados do `shared` que o catálogo
 * tem). Outros = o resto do catálogo por nome. Nível cadastrado que sumiu do catálogo não aparece (como no web).
 */
export function buildCatalog(input: { models: RawModel[]; tierIds: readonly string[]; botModel: string | null }): ModelCatalog {
	const byId = new Map(input.models.map((model) => [model.id, model]));
	const wanted = input.tierIds.length > 0 ? [...input.tierIds] : RECOMMENDED_MODELS.map((entry) => entry.id);
	const featuredIds = [...new Set([...(input.botModel ? [input.botModel] : []), ...wanted])];
	const featured: ModelOption[] = [];
	for (const id of featuredIds) {
		const model = byId.get(id);
		if (model) featured.push(toOption(model));
		else if (id === input.botModel) featured.push(unlistedOption(id));
	}
	const taken = new Set(featured.map((option) => option.id));
	const others = input.models
		.filter((model) => !taken.has(model.id))
		.map(toOption)
		.sort((a, b) => a.name.localeCompare(b.name, "pt-BR", { sensitivity: "base" }));
	return { botModel: input.botModel, featured, others };
}

/** Procura o modelo nos dois grupos (o escolhido pode estar em "Outros"). */
export function findOption(catalog: ModelCatalog | null, id: string): ModelOption | null {
	if (!catalog) return null;
	return catalog.featured.find((option) => option.id === id) ?? catalog.others.find((option) => option.id === id) ?? null;
}
