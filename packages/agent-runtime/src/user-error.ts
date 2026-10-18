/**
 * Único tradutor de erro de run -> texto para o usuário (pt-BR, curto, acionável).
 * Ordem: classe/código estruturado do erro (ProviderApiError, status HTTP) primeiro;
 * regex só como fallback, ancorada em palavra/código. O detalhe técnico (`technical`)
 * fica para log e Sentry; nunca vai ao balão.
 */

export type UserErrorKind =
	| "rate_limit"
	| "provider_down"
	| "auth"
	| "credits"
	| "context_too_long"
	| "content_filter"
	| "timeout"
	| "network"
	| "bad_request"
	| "passthrough"
	| "unknown";

type MappedKind = Exclude<UserErrorKind, "passthrough">;

export type DescribedRunError = {
	kind: UserErrorKind;
	/** Texto para o usuário. */
	message: string;
	/** Mensagem original (log/Sentry). */
	technical: string;
};

const MESSAGES: Record<MappedKind, string> = {
	rate_limit: "O provedor do modelo está limitando pedidos agora. Tente em alguns minutos ou troque de modelo.",
	provider_down: "O provedor do modelo está instável ou fora do ar agora. Tente de novo em alguns minutos ou troque de modelo.",
	auth: "A chave do provedor do modelo foi recusada. Confira em Configurações › Provedores.",
	credits: "O saldo ou o limite de uso do provedor do modelo acabou. Recarregue ou confira o plano em Configurações › Provedores.",
	context_too_long: "A conversa ficou grande demais para este modelo. Comece uma nova conversa ou troque para um modelo com janela maior.",
	content_filter: "O provedor bloqueou esta resposta por política de conteúdo. Reformule o pedido ou troque de modelo.",
	timeout: "O modelo demorou demais para responder e foi interrompido. Tente de novo, peça o arquivo em partes menores ou troque de modelo.",
	network: "Não consegui falar com o provedor do modelo (falha de conexão). Tente de novo em instantes.",
	bad_request: "O provedor do modelo recusou o pedido. Tente de novo ou troque de modelo.",
	unknown: "Algo deu errado ao executar esta tarefa. Tente de novo em instantes; se continuar, troque de modelo.",
};

function statusOf(item: unknown): number | undefined {
	if (!item || typeof item !== "object") return undefined;
	const record = item as { status?: unknown; statusCode?: unknown; response?: { status?: unknown } };
	for (const value of [record.status, record.statusCode, record.response?.status]) {
		if (typeof value === "number" && Number.isInteger(value) && value >= 100 && value < 600) return value;
	}
	return undefined;
}

function chainOf(error: unknown): unknown[] {
	const chain: unknown[] = [];
	for (let current: unknown = error, i = 0; current !== undefined && current !== null && i < 6; i += 1) {
		chain.push(current);
		current = current instanceof Error ? current.cause : undefined;
	}
	return chain;
}

const CONTEXT = /\b(?:context[_ ](?:length|window)(?:[_ ]exceeded)?|maximum context|prompt is too long|too many tokens|reduce the length)\b/i;

function fromStatus(status: number, text: string): MappedKind | undefined {
	if (status === 429) return "rate_limit";
	if (status === 401 || status === 403) return "auth";
	if (status === 402) return "credits";
	if (status === 408 || status === 504) return status === 504 ? "provider_down" : "timeout";
	if (status === 413) return "context_too_long";
	if (status === 400 || status === 422) return CONTEXT.test(text) ? "context_too_long" : "bad_request";
	if (status >= 500) return "provider_down";
	return undefined;
}

function fromProviderCode(code: string): MappedKind | undefined {
	switch (code) {
		case "auth_failed":
			return "auth";
		case "limit_exceeded":
			return "credits";
		case "rate_limited":
			return "rate_limit";
		case "unavailable":
		case "upstream_error":
			return "provider_down";
		case "network_error":
		case "stream_interrupted":
			return "network";
		case "bad_request":
			return "bad_request";
		default:
			return undefined;
	}
}

/** Fallback por texto livre: padrões ancorados (código HTTP só com prefixo "HTTP"/"status"). */
const TEXT_RULES: ReadonlyArray<readonly [MappedKind, RegExp]> = [
	["credits", /\b(?:insufficient (?:credits?|funds|quota)|payment required|exceeded your current quota|credit balance)\b/i],
	["rate_limit", /(?:\b(?:http|status(?: code)?|error)[ :=]*429\b|\brate[- ]?limit(?:ed|ing)?\b|\btoo many requests\b|\bretry shortly\b)/i],
	["auth", /(?:\b(?:invalid|incorrect|missing|revoked) api[_ ]?key\b|\binvalid_api_key\b|\bunauthorized\b|\b(?:http|status(?: code)?|error)[ :=]*40[13]\b)/i],
	["context_too_long", CONTEXT],
	["content_filter", /\b(?:content[_ ]filter(?:ed)?|safety (?:system|filter)|violates? (?:our )?(?:usage )?polic)/i],
	["timeout", /(?:aborted due to timeout|\btimed? ?out\b|\bdecision deadline exceeded\b|demorou demais)/i],
	["provider_down", /(?:\b(?:http|status(?: code)?|error)[ :=]*50[0234]\b|\bservice unavailable\b|\bbad gateway\b|\boverloaded\b|\bcould not verify available credits\b|\btemporarily unavailable\b)/i],
	["network", /\b(?:econnreset|etimedout|econnrefused|enotfound|eai_again)\b|\bfetch failed\b|\bsocket hang up\b|\bnetwork error\b/i],
];

/** Texto já escrito em pt-BR pelo runtime (limite, loop, etc.): vale mostrar como está. */
const LOOKS_PORTUGUESE = /[áàâãéêíóôõúç]|\b(?:não|falha|limite|tempo|arquivo|execução|resposta)\b/i;

export function describeRunError(error: unknown): DescribedRunError {
	const technical = error instanceof Error ? error.message : typeof error === "string" ? error : String(error ?? "");
	const chain = chainOf(error);

	// 1) Estruturado: classe/código do provedor e status HTTP.
	for (const item of chain) {
		if (item instanceof Error && item.name === "ProviderApiError") {
			// O adaptador já escreve o texto em pt-BR (inclui "não lê imagens"); só os casos tabelados são trocados.
			const code = (item as { code?: unknown }).code;
			if ((item as { reason?: unknown }).reason) return { kind: "bad_request", message: item.message, technical };
			const kind = typeof code === "string" ? fromProviderCode(code) : undefined;
			if (kind) return { kind, message: MESSAGES[kind], technical };
		}
		if (item instanceof Error && item.name === "NoFallbackModelError") {
			return { kind: "provider_down", message: MESSAGES.provider_down, technical };
		}
		const status = statusOf(item);
		if (status !== undefined) {
			const kind = fromStatus(status, item instanceof Error ? item.message : "");
			if (kind) return { kind, message: MESSAGES[kind], technical };
		}
		if (item instanceof Error && item.name === "TimeoutError") return { kind: "timeout", message: MESSAGES.timeout, technical };
	}

	// 2) Texto livre (fallback).
	for (const [kind, pattern] of TEXT_RULES) {
		if (pattern.test(technical)) return { kind, message: MESSAGES[kind], technical };
	}

	// 3) Mensagem curta já em pt-BR vinda do próprio runtime passa; inglês/técnico/longo vira texto genérico.
	const trimmed = technical.trim();
	if (trimmed && trimmed.length <= 400 && LOOKS_PORTUGUESE.test(trimmed)) {
		return { kind: "passthrough", message: trimmed, technical };
	}
	return { kind: "unknown", message: MESSAGES.unknown, technical };
}
