import { isCreditsExhaustedText, isProviderExhaustedStatus, isProviderExhaustedText } from "@workspace/shared";

/**
 * Estado do run: provedores externos (conector MCP, API paga de busca/extração)
 * que já responderam "sem créditos / cota / chave recusada". Depois da primeira
 * vez o run não insiste: a tool devolve um aviso curto e o modelo segue por outra
 * via. Vive só na memória do run; um resume paga uma falha para redescobrir.
 */
export type ProviderHealth = {
	isExhausted(id: string): boolean;
	/** Marca o provedor; devolve true só na primeira vez (para avisar o modelo uma vez). */
	markExhausted(id: string): boolean;
	any(): boolean;
};

export function createProviderHealth(): ProviderHealth {
	const exhausted = new Set<string>();
	return {
		isExhausted: (id) => exhausted.has(id),
		markExhausted(id) {
			if (exhausted.has(id)) return false;
			exhausted.add(id);
			return true;
		},
		any: () => exhausted.size > 0,
	};
}

/** Ids dos provedores da API paga (fora do conector MCP). */
export const WEB_EXTRACT_API_PROVIDER = "api:web_extract";
export const WEB_SEARCH_API_PROVIDER = "api:web_search";

/** Alternativas que existem NESTE run (a dica nunca cita tool que o modelo não tem). */
export function availableWebFallbacks(hasTool: (name: string) => boolean): string[] {
	return ["web_search", "web_extract", "navigate"].filter(hasTool);
}

function alternativesClause(alternatives: readonly string[]): string {
	return alternatives.length > 0
		? `Continue the same work with ${alternatives.join(", ")}.`
		: "No other tool can cover it: say plainly what could not be covered and why.";
}

/** Aviso único na primeira falha por esgotamento. */
export function exhaustedNotice(label: string, alternatives: readonly string[]): string {
	return `${label} is out of credits or over its quota for this run and will not be called again. ${alternativesClause(alternatives)}`;
}

/** Resposta curta das chamadas seguintes (sem repetir o pedido ao provedor). */
export function exhaustedBlockedMessage(label: string, alternatives: readonly string[]): string {
	return `${label} is unavailable for the rest of this run (credits or quota exhausted). ${alternativesClause(alternatives)}`;
}

export { isCreditsExhaustedText };

/** Erro da API paga (texto `HTTP 402…` das nossas mensagens) que a deixa fora do run. */
export function isApiProviderExhausted(message: string): boolean {
	const status = /HTTP (\d{3})/.exec(message)?.[1];
	return isProviderExhaustedStatus(status ? Number(status) : undefined) || isProviderExhaustedText(message);
}

/** Abaixo disso o run ainda tem folga para continuar em vez de entregar parcial. */
export const CONTINUE_BUDGET_FRACTION = 0.8;

/** Maior fração gasta entre passos, tokens e relógio (teto ausente/zero = ignora). */
export function budgetUsedFraction(input: {
	step: number;
	maxSteps: number;
	tokens?: number;
	maxTokens?: number;
	wallMs?: number;
	maxWallMs?: number;
}): number {
	const ratio = (used: number | undefined, max: number | undefined) =>
		used !== undefined && max !== undefined && max > 0 ? used / max : 0;
	return Math.max(ratio(input.step, input.maxSteps), ratio(input.tokens, input.maxTokens), ratio(input.wallMs, input.maxWallMs));
}

/**
 * Cutuca uma vez quando a resposta final chega depois de um provedor esgotado, há
 * outra via de leitura e sobra orçamento. O sinal é o estado do run (provedor
 * esgotado), não o texto da resposta: vale em qualquer idioma.
 */
export function shouldContinueAfterExhaustion(input: {
	anyExhausted: boolean;
	alternatives: readonly string[];
	alreadyNudged: boolean;
	usedFraction: number;
}): boolean {
	return (
		input.anyExhausted &&
		!input.alreadyNudged &&
		input.alternatives.length > 0 &&
		input.usedFraction < CONTINUE_BUDGET_FRACTION
	);
}

export const CONTINUE_AFTER_EXHAUSTION_NOTE =
	"A tool or connector ran out of credits during this run. If part of the request is still open, continue it now with the tools that still work instead of offering to continue later. If everything that can be covered is done, give the final answer and state plainly what could not be verified.";
