import { MODEL_CAPABILITY_OVERRIDES, type ModelCapabilityFields } from "./model-capabilities-data.js";
import { parseModelRef, type ModelProvider } from "./model-ref.js";

export type ModelCapabilitySource = "catalog" | "override" | "heuristic" | "unknown";

export type ModelCapabilities = {
	vision: boolean;
	/** PDF nativo: o provedor lê o documento sem extração de texto prévia. */
	pdf: boolean;
	tools: boolean;
	reasoning: boolean;
	contextTokens: number | null;
	maxOutputTokens: number | null;
	streaming: boolean;
	/** De onde veio o dado mais forte: override curado > catálogo do provedor > heurística > nada. */
	source: ModelCapabilitySource;
};

/** Recorte do catálogo do provedor que alimenta a decisão (aceita `ProviderModel`/`OpenRouterModel` direto). */
export type ModelCatalogInfo = {
	inputModalities?: readonly string[];
	contextLength?: number | null;
	maxOutputTokens?: number | null;
	/** `supported_parameters` do OpenRouter. */
	supportedParameters?: readonly string[];
	capabilities?: "unknown" | { tools?: boolean; vision?: boolean };
};

/** Funções que um modelo pode ter na conta e a capacidade que cada uma exige. */
export type ModelRole = "default" | "coding" | "maintenance" | "vision" | "reflection" | "fallback";
export const MODEL_ROLE_REQUIRES: Record<ModelRole, readonly ("vision" | "tools")[]> = {
	default: ["tools"],
	coding: ["tools"],
	maintenance: ["tools"],
	reflection: ["tools"],
	vision: ["vision"],
	fallback: ["tools"],
};

function safeRef(modelRef: string): { provider: ModelProvider; slug: string } | null {
	try {
		return parseModelRef(modelRef);
	} catch {
		return null;
	}
}

/** Nome do modelo sem vendor nem variante ("anthropic/claude-x:free" -> "claude-x"). */
function baseSlug(slug: string): string {
	const last = slug.slice(slug.lastIndexOf("/") + 1);
	const colon = last.indexOf(":");
	return (colon >= 0 ? last.slice(0, colon) : last).toLowerCase();
}

const VENDOR_OF_NAME: readonly (readonly [string, string])[] = [["claude-", "anthropic"], ["gpt-", "openai"], ["gemini-", "google"]];

/** No OpenRouter, o nome só vale com o vendor certo ("someone/gpt-5-clone" não é GPT-5). */
function vendorMatchesName(provider: ModelProvider, slug: string, name: string): boolean {
	if (provider !== "openrouter") return true;
	const vendor = slug.includes("/") ? slug.slice(0, slug.indexOf("/")).toLowerCase() : null;
	for (const [prefix, expected] of VENDOR_OF_NAME) if (name.startsWith(prefix)) return vendor === expected;
	return true;
}

function overrideFor(provider: ModelProvider, slug: string): ModelCapabilityFields | undefined {
	const name = baseSlug(slug);
	for (const rule of MODEL_CAPABILITY_OVERRIDES) {
		if (rule.providers && !rule.providers.includes(provider)) continue;
		if (!vendorMatchesName(provider, slug, name)) continue;
		if (rule.slug.test(name)) return rule.caps;
	}
	return undefined;
}

function positive(value: number | null | undefined): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/** Campos que o catálogo declara de fato; o que ele não diz fica ausente. */
export function catalogFields(info: ModelCatalogInfo | undefined): ModelCapabilityFields {
	if (!info) return {};
	const out: ModelCapabilityFields = {};
	const declared = info.capabilities && info.capabilities !== "unknown" ? info.capabilities : undefined;
	const modalities = info.inputModalities?.length ? info.inputModalities : undefined;
	const params = info.supportedParameters?.length ? info.supportedParameters : undefined;
	if (typeof declared?.vision === "boolean") out.vision = declared.vision;
	else if (modalities) out.vision = modalities.includes("image");
	if (modalities) out.pdf = modalities.includes("file");
	if (typeof declared?.tools === "boolean") out.tools = declared.tools;
	else if (params) out.tools = params.includes("tools");
	if (params) out.reasoning = params.includes("reasoning") || params.includes("include_reasoning");
	const context = positive(info.contextLength);
	if (context !== undefined) out.contextTokens = context;
	const maxOut = positive(info.maxOutputTokens);
	if (maxOut !== undefined) out.maxOutputTokens = maxOut;
	return out;
}

/** Heurística conservadora, só por provedor: nada de adivinhar por nome. Desconhecido = sem visão/PDF. */
function heuristicFields(provider: ModelProvider): ModelCapabilityFields {
	const base: ModelCapabilityFields = { vision: false, pdf: false, tools: true, reasoning: false, streaming: true };
	// Anthropic lê imagem e PDF por padrão; o plano ChatGPT tenta imagem e o erro oficial informa a capacidade.
	if (provider === "anthropic") return { ...base, vision: true, pdf: true };
	if (provider === "chatgpt") return { ...base, vision: true };
	return base;
}

/**
 * Fonte única de capacidades por modelo. Por campo: override curado > catálogo do
 * provedor > heurística. Sem informação, imagem e PDF NÃO são presumidos; `tools`
 * segue o comportamento atual (presumido). `catalog` é opcional.
 */
export function getModelCapabilities(modelRef: string, catalog?: ModelCatalogInfo): ModelCapabilities {
	const ref = safeRef(modelRef);
	const provider = ref?.provider ?? "openrouter";
	const override = ref ? overrideFor(provider, ref.slug) : undefined;
	const fromCatalog = catalogFields(catalog);
	const heuristic = heuristicFields(provider);
	const pick = <K extends keyof ModelCapabilityFields>(key: K): ModelCapabilityFields[K] => override?.[key] ?? fromCatalog[key] ?? heuristic[key];
	const hasCatalog = Object.keys(fromCatalog).length > 0;
	const source: ModelCapabilitySource = override ? "override" : hasCatalog ? "catalog" : provider === "anthropic" || provider === "chatgpt" ? "heuristic" : "unknown";
	return {
		vision: pick("vision") === true,
		pdf: pick("pdf") === true,
		tools: pick("tools") !== false,
		reasoning: pick("reasoning") === true,
		contextTokens: pick("contextTokens") ?? null,
		maxOutputTokens: pick("maxOutputTokens") ?? null,
		streaming: pick("streaming") !== false,
		source,
	};
}

/** Capacidades que a função exige e o modelo não tem. */
export function missingForRole(role: ModelRole, caps: ModelCapabilities): ("vision" | "tools")[] {
	return MODEL_ROLE_REQUIRES[role].filter((need) => !caps[need]);
}

/** "200k" / "1M" / "1,5M" para a janela de contexto. */
export function formatContextTokens(tokens: number | null | undefined): string | null {
	if (!tokens || tokens <= 0) return null;
	if (tokens >= 1_000_000) {
		const millions = tokens / 1_000_000;
		return `${Number.isInteger(millions) ? millions : millions.toFixed(1).replace(".", ",")}M`;
	}
	return `${Math.round(tokens / 1000)}k`;
}

/** Aviso (pt-BR) quando o modelo escolhido para a função não tem a capacidade; `null` = sem aviso. */
export function roleCapabilityWarning(role: ModelRole, caps: ModelCapabilities): string | null {
	const missing = missingForRole(role, caps);
	if (!missing.length) return null;
	if (missing.includes("vision")) {
		return caps.source === "unknown"
			? "Não sabemos se este modelo lê imagens; a leitura pode falhar."
			: "Este modelo não lê imagens. Escolha um com o selo Imagem.";
	}
	return role === "maintenance" || role === "reflection"
		? "Este modelo não tem ferramentas; resumo e revisão de memória podem falhar."
		: "Este modelo não tem ferramentas; o agente não consegue agir com ele.";
}
