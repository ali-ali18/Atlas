import { isRetryableLlmError } from "../config.js";
const failures: Record<string, { status: number; message: string }> = {
	subscription_sharing_usage_limit_exceeded: { status: 429, message: "Limite do plano ChatGPT atingido." },
	subscription_sharing_unsupported_capability: { status: 400, message: "Este modelo do ChatGPT não oferece a capacidade solicitada." },
	subscription_sharing_not_eligible: { status: 403, message: "Esta conta não está habilitada para compartilhar o plano ChatGPT." },
	subscription_sharing_user_not_eligible: { status: 403, message: "Esta conta não está habilitada para compartilhar o plano ChatGPT." },
	subscription_sharing_invalid_user: { status: 401, message: "Reconecte o ChatGPT nas configurações." },
	subscription_sharing_usage_unavailable: { status: 503, message: "O plano ChatGPT está indisponível. Tente novamente depois." },
	needs_login: { status: 401, message: "Reconecte o ChatGPT nas configurações." },
};

/** Mensagens externas são descartadas: nenhum segredo do request pode sair no erro. */
export class ChatgptProviderError extends Error {
	readonly status: number;
	readonly code: string;
	constructor(status: number, code = "upstream_error") {
		const known = Object.hasOwn(failures, code) ? failures[code] : undefined;
		super(known?.message ?? `Não foi possível concluir a chamada ao ChatGPT (HTTP ${status}).`);
		this.name = "ChatgptProviderError";
		this.status = known?.status ?? status;
		this.code = known ? code : ["network_error", "stream_interrupted", "invalid_stream", "incomplete_response", "upstream_error"].includes(code) ? code : "upstream_error";
	}
}

export function chatgptErrorFrom(value: unknown, status: number): ChatgptProviderError {
	if (value !== null && typeof value === "object") {
		const raw = value as Record<string, unknown>;
		const detail = raw.error && typeof raw.error === "object" ? raw.error as Record<string, unknown> : raw;
		return new ChatgptProviderError(status, typeof detail.code === "string" ? detail.code : undefined);
	}
	return new ChatgptProviderError(status);
}

export function isRetryableChatgptError(error: unknown): boolean {
	if (error instanceof ChatgptProviderError && Object.hasOwn(failures, error.code)) return false;
	return isRetryableLlmError(error);
}
