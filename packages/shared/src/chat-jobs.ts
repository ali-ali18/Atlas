import type {
	ChatCompletionRequest,
	ChatCompletionResponse,
	ChatMessage,
} from "./chat.js";

/** Payload enfileirado para `chat.completion` (modelo pode ser omitido e resolvido no worker). */
export type ChatCompletionJobPayload = ChatCompletionRequest & {
	/** Dono da sessão que enfileirou (conta única: escopa memória por usuário). */
	userId?: string;
	/** Request-id da requisição que enfileirou (logs da API e do worker casam por ele). */
	requestId?: string;
};

/** Valor de retorno do job após processamento bem-sucedido. */
export type ChatCompletionJobResult = ChatCompletionResponse;

/** Payload do job de revisão de memória (roda após cada turno). */
export type MemoryReviewJobPayload = {
	userId?: string;
	botId?: string;
	conversationId?: string;
	messages: ChatMessage[];
};

/** Resultado do job de revisão de memória. */
export type MemoryReviewJobResult = {
	saved: number;
	/** Ledger separado do uso do run principal, persistido no resultado do job. */
	maintenance?: { model: string; calls: number; promptTokens: number; completionTokens: number; totalTokens: number; costUsd?: number };
};

/** Payload do job de resumo de conversa (Fase 1: idle/manual). */
export type SummaryJobPayload = {
	conversationId: string;
	botId?: string;
	/** De onde veio: varredura de inatividade ou pedido manual. */
	trigger: "idle" | "manual";
};

/** Resultado do job de resumo. */
export type SummaryJobResult = {
	summaryId: string | null;
	version: number | null;
	/** Motivo quando nada foi gravado (run ativo, sem conteúdo novo...). */
	skipped?: string;
};

/** Resposta de `POST /v1/chat/jobs`. */
export type ChatCompletionJobEnqueueResponse = {
	jobId: string;
	queue: string;
	name: string;
};

/** Estados expostos pela API de polling (subset legível de BullMQ). */
export type ChatCompletionJobStatus =
	| "waiting"
	| "active"
	| "completed"
	| "failed"
	| "delayed"
	| "paused"
	| "unknown";

/** Resposta de `GET /v1/chat/jobs/:id`. */
export type ChatCompletionJobStatusResponse = {
	id: string;
	status: ChatCompletionJobStatus;
	result: ChatCompletionJobResult | null;
	error: string | null;
};

/** Pré-extração do texto de um anexo de arquivo logo após o upload (roda no worker, num pool de threads). */
export type AttachmentExtractJobPayload = {
	userId: string;
	artifactId: string;
};

export type AttachmentExtractJobResult = {
	status: "cached" | "extracted" | "skipped";
};
