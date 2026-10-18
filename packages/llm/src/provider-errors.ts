import { isRetryableLlmError } from "./config.js";

export type ProviderErrorCode =
	| "auth_failed"
	| "limit_exceeded"
	| "rate_limited"
	| "bad_request"
	| "unavailable"
	| "network_error"
	| "stream_interrupted"
	| "upstream_error";

export type KeyProviderName = "anthropic" | "opencode-go";

/**
 * Erro de provedor por chave de API. A mensagem vem de uma tabela fixa (pt-BR):
 * texto livre do upstream e a chave nunca entram no erro, nos logs ou nos eventos.
 */
export class ProviderApiError extends Error {
	readonly status: number;
	readonly code: ProviderErrorCode;
	readonly provider: KeyProviderName;
	/** Espera sugerida pelo Retry-After do upstream, em ms, quando o cabeçalho veio. */
	readonly retryAfterMs?: number;
	/** Motivo conhecido de um `bad_request` (hoje só: o modelo não aceita imagens). */
	readonly reason?: "no_image_support";
	constructor(provider: KeyProviderName, status: number, code: ProviderErrorCode, retryAfterMs?: number, reason?: "no_image_support") {
		super(reason === "no_image_support" ? imageRefusalText(provider) : providerErrorText(provider, code, status));
		if (reason) this.reason = reason;
		if (retryAfterMs !== undefined) this.retryAfterMs = retryAfterMs;
		this.name = "ProviderApiError";
		this.provider = provider;
		this.status = status;
		this.code = code;
	}
}

const NAME = { anthropic: "Anthropic", "opencode-go": "OpenCode Go" } as const;

export function imageRefusalText(provider: KeyProviderName): string {
	return `${NAME[provider]}: este modelo não lê imagens. Escolha um modelo com visão ou envie sem a imagem.`;
}

export function providerErrorText(provider: KeyProviderName, code: ProviderErrorCode, status: number): string {
	const name = NAME[provider];
	switch (code) {
		case "auth_failed":
			return `Chave de API do ${name} inválida ou sem permissão. Confira em Configurações > Avançado > Provedores.`;
		case "limit_exceeded":
			return provider === "opencode-go" ? "Limite do OpenCode Go atingido." : "Limite de uso ou saldo da Anthropic atingido.";
		case "rate_limited":
			return `${name} limitou a taxa de requisições. Tente novamente em instantes.`;
		case "bad_request":
			return `${name} recusou a requisição (HTTP ${status}).`;
		case "unavailable":
			return `${name} está indisponível no momento (HTTP ${status}).`;
		case "network_error":
			return `Não foi possível falar com ${name}.`;
		case "stream_interrupted":
			return `A resposta de ${name} foi interrompida.`;
		default:
			return `Falha na chamada ao ${name} (HTTP ${status}).`;
	}
}

type ErrorBody = { error?: { type?: string; message?: string; code?: string | number } | string; message?: string };

/** Natureza da falha do provedor: decide cooldown, retry e fallback. */
export type ProviderFailureKind = "plan_limit" | "upstream" | "auth" | "bad_request" | "other";

export function providerFailureKind(error: ProviderApiError): ProviderFailureKind {
	switch (error.code) {
		case "limit_exceeded":
			return "plan_limit";
		case "auth_failed":
			return "auth";
		case "bad_request":
			return "bad_request";
		case "unavailable":
		case "rate_limited":
		case "network_error":
		case "stream_interrupted":
			return "upstream";
		default:
			return "other";
	}
}

/** `Retry-After` em segundos ou data HTTP; ms, ou undefined se ausente/ilegível. */
export function parseRetryAfterMs(value: string | null | undefined, now = Date.now()): number | undefined {
	const text = value?.trim();
	if (!text) return undefined;
	if (/^[0-9]+$/.test(text)) return Number(text) * 1000;
	const at = Date.parse(text);
	return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

const IMAGE_WORDING = /image|vision|multimodal|modalit|image_url|input_image|visual/;

/** Trecho curto do corpo do erro para diagnóstico: sem quebras, sem credenciais, no máximo 400 caracteres. */
export function redactedErrorSnippet(body: unknown): string {
	let text: string;
	try {
		text = typeof body === "string" ? body : JSON.stringify(body) ?? "";
	} catch {
		text = "";
	}
	return text
		.replace(/\s+/g, " ")
		.replace(/(bearer\s+)[\w.~+/=-]+/gi, "$1[chave]")
		.replace(/\b(sk|key|tok|ghp|xox[a-z])[-_][\w-]{8,}/gi, "[chave]")
		.slice(0, 400);
}

const LIMIT_WORDING = /limit|quota|usage|exceeded|insufficient|balance|credit|billing/;

/** Classifica pelo status e por marcadores do corpo; o corpo nunca é repassado. */
export function classifyProviderHttpError(provider: KeyProviderName, status: number, body: unknown, headers?: { get(name: string): string | null } | null): ProviderApiError {
	const raw = (body && typeof body === "object" ? body : {}) as ErrorBody;
	const err = typeof raw.error === "object" && raw.error ? raw.error : {};
	const text = `${err.type ?? ""} ${err.code ?? ""} ${typeof raw.error === "string" ? raw.error : ""} ${err.message ?? ""} ${raw.message ?? ""}`.toLowerCase();
	const limitText = /usage limit|limit (reached|exceeded)|quota|weekly|monthly|rolling|insufficient|balance/.test(text);
	const retryAfter = parseRetryAfterMs(headers?.get("retry-after"));
	const make = (code: ProviderErrorCode, reason?: "no_image_support") => new ProviderApiError(provider, status, code, retryAfter, reason);
	if (status >= 400 && status < 500 && ![401, 402, 403, 429].includes(status)) {
		console.warn(`${provider} http ${status} body=${redactedErrorSnippet(body)}`);
	}
	if (status === 401 || status === 403) return make(provider === "opencode-go" && limitText ? "limit_exceeded" : "auth_failed");
	if (provider === "opencode-go") {
		if (status === 402) return make("limit_exceeded");
		// 429 sem palavra de limite (ex.: inference_failed) é falha do upstream, não do plano.
		if (status === 429) return make(LIMIT_WORDING.test(text) ? "limit_exceeded" : "unavailable");
		if (limitText && status < 500) return make("limit_exceeded");
	} else {
		if (status === 402 || /credit balance|billing/.test(text)) return make("limit_exceeded");
		if (status === 429) return make("rate_limited");
	}
	if (status === 529 || status >= 500) return make("unavailable");
	if (status >= 400) return make("bad_request", status < 500 && IMAGE_WORDING.test(text) ? "no_image_support" : undefined);
	return make("upstream_error");
}

export function isRetryableProviderError(error: unknown): boolean {
	if (error instanceof ProviderApiError)
		return !(error.code === "limit_exceeded" || error.code === "auth_failed" || error.code === "bad_request");
	return isRetryableLlmError(error);
}

/** Remove qualquer ocorrência da chave de um texto antes de log/evento. */
export function redactKey(text: string, key: string | undefined): string {
	return key && key.length >= 4 ? text.split(key).join("[chave]") : text;
}
