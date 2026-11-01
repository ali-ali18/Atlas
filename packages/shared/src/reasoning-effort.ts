import { getModelCapabilities, type ModelCatalogInfo } from "./model-capabilities.js";
import { userAuthoredText } from "./autonomy-request.js";
import { normalizedLower } from "./skill-extract.js";
import { parseModelRef } from "./model-ref.js";

/** Nível de raciocínio pedido ao modelo. `off` = sem raciocínio; ausente = padrão do modelo. */
export const REASONING_EFFORTS = ["off", "low", "medium", "high"] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

/** Rótulos para o usuário (pt-BR). "Padrão do modelo" é a ausência de valor. */
export const REASONING_EFFORT_LABELS: Record<ReasoningEffort, string> = {
	off: "Desligado",
	low: "Baixo",
	medium: "Médio",
	high: "Alto",
};
export const REASONING_DEFAULT_LABEL = "Padrão do modelo";

/** Aceita só os quatro valores exatos; qualquer outra coisa (vazio, caixa errada, número) vira `undefined`. */
export function parseReasoningEffort(value: unknown): ReasoningEffort | undefined {
	return typeof value === "string" && (REASONING_EFFORTS as readonly string[]).includes(value) ? (value as ReasoningEffort) : undefined;
}

/**
 * Modelos que deixam o raciocínio desligado de verdade. Lista conservadora: quem não está aqui (ou é desconhecido)
 * não oferece "Desligado", porque o provedor pode ignorar o pedido ou recusar a chamada.
 */
const CAN_DISABLE: readonly RegExp[] = [
	/^claude-/,
	/^gpt-5\.[1-9]/,
	/^gemini-2\.5-flash/,
	/^deepseek-(v3\.[1-9]|v4)/,
	/^qwen3/,
	/^glm-4\.[5-9]/,
];

function baseName(slug: string): string {
	const last = slug.slice(slug.lastIndexOf("/") + 1);
	const colon = last.indexOf(":");
	return (colon >= 0 ? last.slice(0, colon) : last).toLowerCase();
}

function openRouterSlug(modelRef: string): string | null {
	try {
		const ref = parseModelRef(modelRef);
		return ref.provider === "openrouter" ? ref.slug : null;
	} catch {
		return null;
	}
}

/**
 * O controle de nível só vale para modelos do OpenRouter com raciocínio (catálogo `supported_parameters` ou curadoria).
 * Anthropic direto, plano ChatGPT e OpenCode Go têm caminho próprio e não recebem o parâmetro.
 * `reasoning` já resolvido (ex.: `ModelCapabilities.reasoning` do worker) dispensa o catálogo.
 */
export function supportsReasoningEffort(modelRef: string, catalog?: ModelCatalogInfo, reasoning?: boolean): boolean {
	if (openRouterSlug(modelRef) === null) return false;
	return reasoning ?? getModelCapabilities(modelRef, catalog).reasoning;
}

/** O modelo aceita "Desligado"? Só quando o raciocínio é controlável e o modelo está na lista curada. */
export function canDisableReasoning(modelRef: string, catalog?: ModelCatalogInfo, reasoning?: boolean): boolean {
	if (!supportsReasoningEffort(modelRef, catalog, reasoning)) return false;
	const name = baseName(openRouterSlug(modelRef) ?? "");
	return CAN_DISABLE.some((rule) => rule.test(name));
}

/** Níveis que o seletor oferece para o modelo (vazio = não mostrar o controle). */
export function availableReasoningEfforts(modelRef: string, catalog?: ModelCatalogInfo): ReasoningEffort[] {
	if (!supportsReasoningEffort(modelRef, catalog)) return [];
	return REASONING_EFFORTS.filter((effort) => effort !== "off" || canDisableReasoning(modelRef, catalog));
}

/**
 * Nível a enviar nesta chamada: `undefined` = não mandar nada (modelo sem suporte ou sem escolha).
 * "Desligado" salvo no bot vira "Baixo" quando o modelo da chamada não consegue desligar (ex.: troca de modelo no modo Automático).
 */
export function effortForModel(effort: ReasoningEffort | undefined, modelRef: string, catalog?: ModelCatalogInfo, reasoning?: boolean): ReasoningEffort | undefined {
	if (!effort || !supportsReasoningEffort(modelRef, catalog, reasoning)) return undefined;
	return effort === "off" && !canDisableReasoning(modelRef, catalog, reasoning) ? "low" : effort;
}

/** Precedência: pedido do chat > padrão do bot (`policyJson.reasoningEffort`) > conta > nada (padrão do modelo). */
export function resolveReasoningEffort(input: {
	requested?: unknown;
	policyJson?: unknown;
	account?: unknown;
}): ReasoningEffort | undefined {
	return parseReasoningEffort(input.requested) ?? readBotReasoningEffort(input.policyJson) ?? parseReasoningEffort(input.account);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Padrão do bot em `Bot.policyJson.reasoningEffort`. */
export function readBotReasoningEffort(policyJson: unknown): ReasoningEffort | undefined {
	return isRecord(policyJson) ? parseReasoningEffort(policyJson.reasoningEffort) : undefined;
}

/** Nova política com o padrão do bot trocado (`null` = volta ao padrão do modelo), sem perder as outras chaves. */
export function withBotReasoningEffort(policyJson: unknown, effort: ReasoningEffort | null): Record<string, unknown> {
	const base = isRecord(policyJson) ? { ...policyJson } : {};
	if (effort) base.reasoningEffort = effort;
	else delete base.reasoningEffort;
	return base;
}

/** Nível gravado no run (`budgetJson.reasoningEffort`) quando o chat pediu um. */
export function readRunReasoningEffort(budgetJson: unknown): ReasoningEffort | undefined {
	return isRecord(budgetJson) ? parseReasoningEffort(budgetJson.reasoningEffort) : undefined;
}

/** Resumo em palavras simples ("Raciocínio: Baixo"). */
export function formatReasoningEffort(effort: ReasoningEffort | undefined): string {
	return `Raciocínio: ${effort ? REASONING_EFFORT_LABELS[effort] : REASONING_DEFAULT_LABEL}`;
}

const REASONING_REQUEST_MAX_CHARS = 400;
// Termo explícito: "pensar/pense" soltos são fala comum ("preciso pensar mais nisso") e não pedem nada ao bot.
const REASONING_TERM = /\b(raciocinio|reasoning|thinking|pensamento estendido)\b/;
const REASONING_LEVEL_OR_VERB =
	/\b(baixo|medio|alto|desligad[oa]|desliga|desligue|padrao|default|low|medium|high|off|menos|mais|reduz\w*|aument\w*|diminu\w*|muda\w*|mude|troque|trocar|ajust\w*|configur\w*|defin\w*|coloc\w*|ative|ativa|capricha\w*|profundo|rapido)\b/;

/** Pedido explícito, nas palavras do usuário, de mudar o nível de raciocínio do bot (a tool só existe nesse caso). */
export function looksLikeReasoningEffortRequest(text: string): boolean {
	const authored = userAuthoredText(text);
	if (!authored || authored.length > REASONING_REQUEST_MAX_CHARS) return false;
	const normalized = normalizedLower(authored);
	return REASONING_TERM.test(normalized) && REASONING_LEVEL_OR_VERB.test(normalized);
}

/** Argumento da tool: os quatro níveis, ou "default" para voltar ao padrão do modelo. */
export function parseReasoningEffortToolArg(value: unknown): ReasoningEffort | null {
	if (value === "default") return null;
	const parsed = parseReasoningEffort(value);
	if (!parsed) throw new Error('effort inválido: use "off", "low", "medium", "high" ou "default" (padrão do modelo)');
	return parsed;
}
