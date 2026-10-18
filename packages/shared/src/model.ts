import type { ApiKeyProvider, ModelProvider } from "./model-ref.js";

/** Modelo disponível no OpenRouter (recorte do `/api/v1/models`). */
export type OpenRouterModel = {
	id: string;
	name: string;
	/** Prefixo do id (ex.: "openai" em "openai/gpt-4o"). */
	provider: string;
	contextLength: number | null;
	inputModalities?: string[];
	outputModalities?: string[];
	/** `supported_parameters` do OpenRouter (ex.: "tools", "reasoning"). */
	supportedParameters?: string[];
	maxOutputTokens?: number | null;
};

export function modelSupportsImageInput(model: OpenRouterModel | undefined): boolean {
	return model?.inputModalities?.includes("image") === true;
}

/** Contrato do catálogo: provedor de inferência separado do vendor do OpenRouter. */
export type ProviderModel = Omit<OpenRouterModel, "provider"> & {
	provider: ModelProvider;
	vendor?: string;
	visibility?: string;
	capabilities: "unknown" | { tools?: boolean; vision?: boolean };
};

export type ProviderConnectionStatus = "connected" | "disconnected" | "needs_login" | "error";
export type ProviderStatus = {
	provider: "chatgpt";
	status: ProviderConnectionStatus;
	accountEmail: string | null;
	updatedAt: string | null;
	lastLimitAt: string | null;
	/** Código do último erro de login (sem valores); use `providerErrorMessage`. */
	lastError?: string | null;
};
/** Provedor por chave de API do usuário: a chave nunca sai do servidor. */
export type ApiKeyProviderStatus = {
	provider: ApiKeyProvider;
	status: "connected" | "disconnected" | "error";
	/** Quantidade de modelos do último teste/catálogo. */
	modelCount: number | null;
	/** ISO da última alteração da conexão. */
	updatedAt: string | null;
	lastLimitAt: string | null;
	lastError: string | null;
};
/** Mensagens curtas (pt-BR) para os códigos específicos gravados em `lastError`. */
export function providerErrorMessage(code: string | null | undefined): string | null {
	if (!code) return null;
	if (code === "invalid_token_response:scope_missing_plan")
		return "A conta não concedeu o uso do plano. Conecte de novo e aceite o acesso.";
	if (code.startsWith("invalid_token_response:"))
		return `Resposta de login do ChatGPT inesperada (${code.slice("invalid_token_response:".length)}). Tente conectar de novo.`;
	if (code === "invalid_token_response")
		return "Resposta de login do ChatGPT inesperada. Tente conectar de novo.";
	if (code === "device_expired") return "O código expirou. Gere um novo código e tente de novo.";
	if (code === "device_failed" || code === "device_invalid_response")
		return "Não foi possível concluir o login por código. Gere um novo código e tente de novo.";
	if (code === "invalid_id_token")
		return "Não foi possível validar a identidade da conta. Tente conectar de novo.";
	return null;
}
export type ListProvidersResponse = { providers: ProviderStatus[] };
export type ProviderModelsResponse = {
	models: ProviderModel[];
	status: ProviderConnectionStatus;
	/** Distingue ausência de modelo de falha temporária do catálogo. */
	catalogAvailable: boolean;
};
/** Modelo de transcrição (ditado). `pricePerMinuteUsd` é `null` quando o preço não é por duração. */
export type TranscriptionModel = {
	id: string;
	name: string;
	vendor: string;
	pricePerMinuteUsd: number | null;
};
export type TranscriptionModelsResponse = {
	provider: "openai" | "openrouter";
	/** Modelo usado quando a conta não escolhe: `ATLAS_STT_MODEL` ou o padrão do provedor. */
	defaultModel: string;
	models: TranscriptionModel[];
};
export type ListModelsResponse = {
	models: ProviderModel[];
};
