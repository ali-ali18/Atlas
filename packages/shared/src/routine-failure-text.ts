/**
 * Motivo de falha de rotina em pt-BR para o usuário (histórico e push). O erro guardado no run é técnico
 * e muitas vezes em inglês ("This request requires more credits…"): aqui vira uma frase curta e sem
 * segredo. Função pura; nunca lança.
 */
import { redactSecrets } from "./redact-secrets.js";

export type RoutineFailureKind =
	| "credits"
	| "rate_limit"
	| "auth"
	| "timeout"
	| "provider_down"
	| "network"
	| "context"
	| "unknown"
	| "text";

export type RoutineFailureDescription = {
	kind: RoutineFailureKind;
	/** Frase curta no começo de uma linha ("Sem créditos no provedor do modelo"). */
	headline: string;
};

const RULES: ReadonlyArray<readonly [Exclude<RoutineFailureKind, "unknown" | "text">, RegExp, string]> = [
	["credits", /(?:more credits|insufficient (?:credits?|funds|quota)|payment required|credit balance|can only afford|exceeded your current quota|(?:http|status|error|code)[ :=]*402\b)/i, "Sem créditos no provedor do modelo"],
	["rate_limit", /(?:rate[- ]?limit|too many requests|(?:http|status|error|code)[ :=]*429\b)/i, "O provedor do modelo está limitando pedidos"],
	["auth", /(?:invalid[_ ]api[_ ]key|(?:invalid|incorrect|missing|revoked) api key|unauthorized|(?:http|status|error|code)[ :=]*40[13]\b)/i, "A chave do provedor do modelo foi recusada"],
	["context", /(?:context[_ ](?:length|window)|maximum context|prompt is too long|too many tokens)/i, "A conversa ficou grande demais para o modelo"],
	["timeout", /(?:timed? ?out|aborted due to timeout|deadline exceeded)/i, "O modelo demorou demais para responder"],
	["provider_down", /(?:overloaded|service unavailable|bad gateway|temporarily unavailable|(?:http|status|error|code)[ :=]*50[0234]\b)/i, "O provedor do modelo está fora do ar"],
	["network", /(?:econnreset|etimedout|econnrefused|enotfound|eai_again|fetch failed|socket hang up|network error)/i, "Falha de conexão com o provedor do modelo"],
];

/** Texto já escrito em pt-BR pelo próprio sistema ("Rotina pausada", "Página apagada"): vale como está. */
const LOOKS_PORTUGUESE = /[áàâãéêíóôõúç]|\b(?:rotina|bot|página|pausada|limite|passos|falha|não|execução|resposta)\b/i;

const PASSTHROUGH_MAX = 120;

function firstLine(text: string): string {
	const line = (text.split("\n")[0] ?? "").trim();
	// Laço em vez de /[.\s]+$/: a regex era quadrática em linhas com milhares de tabs/espaços.
	let end = line.length;
	while (end > 0 && /[.\s]/.test(line[end - 1]!)) end--;
	return line.slice(0, end);
}

export function describeRoutineFailure(error: string | null | undefined): RoutineFailureDescription {
	const raw = redactSecrets(typeof error === "string" ? error : "");
	for (const [kind, pattern, headline] of RULES) {
		if (pattern.test(raw)) return { kind, headline };
	}
	const line = firstLine(raw);
	if (line && LOOKS_PORTUGUESE.test(line)) {
		const clipped = line.length > PASSTHROUGH_MAX ? `${line.slice(0, PASSTHROUGH_MAX - 1).trimEnd()}…` : line;
		return { kind: "text", headline: clipped };
	}
	return { kind: "unknown", headline: "Erro inesperado" };
}

/** Motivo para o histórico da rotina: "sem créditos no provedor do modelo". */
export function formatRoutineRunReason(error: string | null | undefined): string {
	const { headline } = describeRoutineFailure(error);
	return headline.charAt(0).toLowerCase() + headline.slice(1);
}

/** Texto do push quando a rotina falha: "Sem créditos no provedor do modelo — a rotina Vendas não rodou". */
export function formatRoutineFailurePush(input: { routineName: string; error: string | null | undefined }): string {
	const { headline } = describeRoutineFailure(input.error);
	const name = input.routineName.replace(/\s+/g, " ").trim().slice(0, 60) || "sem nome";
	return `${headline} — a rotina ${name} não rodou`;
}
