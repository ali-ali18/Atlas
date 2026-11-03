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
	API_KEY_PROVIDER_LABEL,
	hasModelTiers,
	normalizeModelTiers,
	parseModelRef,
	readBotModelTiers,
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
	/** Origem quando não é o catálogo geral ("ChatGPT", "Anthropic", "OpenCode Go"): vira um selo na linha, para modelos de mesmo nome não se confundirem. */
	source: string | null;
	/** Níveis de esforço (raciocínio) que o modelo aceita; vazio = sem a linha "Esforço". */
	efforts: ReasoningEffort[];
	info: ModelCatalogInfo;
};

/** O que se sabe do bot: `known: false` = não consegui ler (diferente de "o bot não fixa modelo"). */
export type BotModelInfo = { known: boolean; model: string | null; /** O bot tem níveis próprios: sem escolha a API roda no Automático. */ tiers: boolean };

export type ModelCatalog = {
	bot: BotModelInfo;
	featured: ModelOption[];
	others: ModelOption[];
	/** Todas as fontes responderam: só então um modelo salvo que não aparece pode ser tratado como indisponível. */
	complete: boolean;
};

/** "Outros modelos" mostra só os primeiros até a pessoa pedir "Ver tudo (n)" (a lista pode ter centenas). */
export const OTHERS_PREVIEW = 50;

export function visibleOthers(others: readonly ModelOption[], showAll: boolean, limit = OTHERS_PREVIEW): { shown: ModelOption[]; hidden: number } {
	if (showAll || others.length <= limit) return { shown: [...others], hidden: 0 };
	return { shown: others.slice(0, limit), hidden: others.length - limit };
}

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

/** Modelo fixo e níveis próprios do bot, lidos da lista de bots do dono (`GET /v1/bots`). Resposta ausente, torta ou sem o bot = não sei. */
export function parseBotInfo(body: unknown, botId: string): BotModelInfo {
	if (!isRecord(body) || !Array.isArray(body.bots)) return { known: false, model: null, tiers: false };
	const bot = body.bots.find((entry) => isRecord(entry) && entry.id === botId);
	if (!isRecord(bot)) return { known: false, model: null, tiers: false };
	const model = typeof bot.openRouterModel === "string" ? bot.openRouterModel.trim() : "";
	return { known: true, model: model || null, tiers: hasModelTiers(readBotModelTiers(bot.policyJson)) };
}

/** De onde vem o modelo quando não é o catálogo geral (plano ChatGPT, chave própria); vazio nos demais. */
export function sourceLabel(id: string): string | null {
	try {
		const ref = parseModelRef(id);
		if (ref.provider === "chatgpt") return "ChatGPT";
		if (ref.provider === "anthropic" || ref.provider === "opencode-go") return API_KEY_PROVIDER_LABEL[ref.provider];
	} catch {
		// id fora do formato: sem rótulo
	}
	return null;
}

/** "Lê imagens · Raciocínio · 200k de contexto": só o que o catálogo confirma. */
export function describeModel(id: string, info: ModelCatalogInfo): string {
	const caps = getModelCapabilities(id, info);
	const context = formatContextTokens(caps.contextTokens);
	return [caps.vision ? "Lê imagens" : null, caps.reasoning ? "Raciocínio" : null, context ? `${context} de contexto` : null].filter((part): part is string => part !== null).join(" · ");
}

export function toOption(model: RawModel): ModelOption {
	return { id: model.id, name: modelDisplayName(model.name, model.id), description: describeModel(model.id, model.info), source: sourceLabel(model.id), efforts: availableReasoningEfforts(model.id, model.info), info: model.info };
}

/** Modelo que o catálogo não lista (ex.: o fixo do bot vindo de outro provedor): aparece pelo nome, nunca pelo id cru com prefixo. */
export function unlistedOption(id: string): ModelOption {
	return toOption({ id, name: "", info: {} });
}

/**
 * Principais = o fixo do bot + os dos níveis da conta (sem níveis cadastrados, os recomendados do `shared` que o catálogo
 * tem). Outros = o resto do catálogo por nome. Nível cadastrado que sumiu do catálogo não aparece (como no web).
 */
export function buildCatalog(input: { models: RawModel[]; tierIds: readonly string[]; bot: BotModelInfo; complete?: boolean }): ModelCatalog {
	const botModel = input.bot.model;
	const byId = new Map(input.models.map((model) => [model.id, model]));
	const wanted = input.tierIds.length > 0 ? [...input.tierIds] : RECOMMENDED_MODELS.map((entry) => entry.id);
	const featuredIds = [...new Set([...(botModel ? [botModel] : []), ...wanted])];
	const featured: ModelOption[] = [];
	for (const id of featuredIds) {
		const model = byId.get(id);
		if (model) featured.push(toOption(model));
		else if (id === botModel) featured.push(unlistedOption(id));
	}
	const taken = new Set(featured.map((option) => option.id));
	const others = input.models
		.filter((model) => !taken.has(model.id))
		.map(toOption)
		.sort((a, b) => a.name.localeCompare(b.name, "pt-BR", { sensitivity: "base" }));
	return { bot: input.bot, featured, others, complete: input.complete ?? true };
}

/** Procura o modelo nos dois grupos (o escolhido pode estar em "Outros"). */
export function findOption(catalog: ModelCatalog | null, id: string): ModelOption | null {
	if (!catalog) return null;
	return catalog.featured.find((option) => option.id === id) ?? catalog.others.find((option) => option.id === id) ?? null;
}
