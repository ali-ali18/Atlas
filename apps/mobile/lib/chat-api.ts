// Chamadas do chat ao servidor: os mesmos endpoints do web (`apps/web/lib/atlas-api.ts`), sempre por `apiFetch`
// (a sessão sai só para a origem do servidor salvo).
import type { CompactConversationResponse } from "@workspace/shared";
import { StreamHttpError } from "./chat-stream";
import { messagesPath, PAGE_SIZE, parsePage, type MessagePage, type PageCursor } from "./chat-thread";
import type { ApiFetch } from "./home-sync";
import type { RunModelFields } from "./model-choice";

export class ChatApiError extends Error {
	constructor(
		message: string,
		readonly status: number,
		/** A mensagem veio do corpo da resposta do servidor (e não do texto do status HTTP). */
		readonly fromServer = false,
	) {
		super(message);
	}
}

/** O modelo escolhido no seletor foi recusado pelo servidor (sumiu do catálogo, provedor desconectado). */
export const MODEL_UNAVAILABLE_TEXT = "O modelo escolhido não está mais disponível; voltei ao modelo do bot. Envie de novo.";
export class ModelUnavailableError extends ChatApiError {
	constructor(status: number) {
		super(MODEL_UNAVAILABLE_TEXT, status);
	}
}

/**
 * A recusa do `POST /v1/runs` é por causa do modelo enviado? Só 400/404/409 com mensagem de modelo ou de provedor
 * (`validateRunModel`, `validateProviderModel`); conversa ocupada e catálogo momentaneamente fora do ar não contam
 * (passam por nova tentativa, e a escolha continua valendo).
 */
export function isModelRejection(reason: unknown): boolean {
	if (!(reason instanceof ChatApiError) || ![400, 404, 409].includes(reason.status)) return false;
	if (reason.message.startsWith("A conversa já tem uma tarefa") || reason.message.startsWith("Catálogo")) return false;
	return /model|conecte|ative o plano/i.test(reason.message);
}

/** O servidor recusou a sessão: quem chamou encerra a sessão como na home. */
export const isUnauthorized = (error: unknown): boolean => (error instanceof ChatApiError || error instanceof StreamHttpError) && error.status === 401;

/** Sem resposta do servidor (rede, DNS, tempo): o app segue com o que tem. */
export const isNetworkError = (error: unknown): boolean => !(error instanceof ChatApiError);

async function failure(response: Response): Promise<never> {
	let message = response.statusText || `HTTP ${response.status}`;
	let fromServer = false;
	try {
		const body = (await response.json()) as { error?: unknown };
		if (typeof body.error === "string" && body.error.trim()) {
			message = body.error;
			fromServer = true;
		}
	} catch {
		// corpo sem JSON: fica o texto do status
	}
	throw new ChatApiError(message, response.status, fromServer);
}

export async function json<T>(apiFetch: ApiFetch, path: string, init: RequestInit = {}): Promise<T> {
	const response = await apiFetch(path, { ...init, headers: { accept: "application/json", ...(init.body ? { "content-type": "application/json" } : {}), ...(init.headers as Record<string, string> | undefined) } });
	if (!response.ok) return failure(response);
	return (await response.json()) as T;
}

export async function fetchMessagePage(apiFetch: ApiFetch, conversationId: string, options: { limit?: number; before?: PageCursor | null; signal?: AbortSignal } = {}): Promise<MessagePage> {
	const body = await json<unknown>(apiFetch, messagesPath(conversationId, { limit: options.limit ?? PAGE_SIZE, before: options.before }), { signal: options.signal });
	const page = parsePage(body);
	if (!page) throw new ChatApiError("Resposta inesperada do servidor.", 502);
	return page;
}

export async function createConversation(apiFetch: ApiFetch): Promise<string> {
	const body = await json<{ id?: unknown }>(apiFetch, "/v1/conversations", { method: "POST" });
	if (typeof body.id !== "string") throw new ChatApiError("Resposta inesperada do servidor.", 502);
	return body.id;
}

export type CreateRunInput = { content: string; conversationId: string; botId: string; decisionConfirmId?: string; clientKey?: string; replyToMessageId?: string; model?: RunModelFields };
export type CreateRunResult = { runId: string | null; status: string };

/**
 * `POST /v1/runs`, igual ao do web (`createAgentRun`). O modelo vem da escolha do usuário (`input.model`, ver `runModelFields`):
 * `modelAuto: true` só quando ele escolheu "Automático". Sem escolha o corpo não diz nada e o servidor respeita o modelo do bot.
 */
export async function createRun(apiFetch: ApiFetch, input: CreateRunInput): Promise<CreateRunResult> {
	const body = {
		messages: [{ role: "user", content: input.content }],
		conversationId: input.conversationId,
		botId: input.botId,
		...(input.model?.model ? { model: input.model.model } : {}),
		...(input.model?.modelAuto ? { modelAuto: true } : {}),
		...(input.model?.model && input.model.reasoningEffort ? { reasoningEffort: input.model.reasoningEffort } : {}),
		...(input.decisionConfirmId ? { decisionConfirmId: input.decisionConfirmId } : {}),
		...(input.clientKey ? { clientKey: input.clientKey } : {}),
		...(input.replyToMessageId ? { replyToMessageId: input.replyToMessageId } : {}),
	};
	const result = await json<{ runId?: unknown; status?: unknown }>(apiFetch, "/v1/runs", {
		method: "POST",
		body: JSON.stringify(body),
		...(input.clientKey ? { headers: { "Idempotency-Key": input.clientKey } } : {}),
	});
	return { runId: typeof result.runId === "string" ? result.runId : null, status: typeof result.status === "string" ? result.status : "" };
}

/** Fala enviada com o run em andamento: entra nele (`mode: "join"`), como no web. */
export async function createRunInput(apiFetch: ApiFetch, runId: string, content: string, clientKey: string, replyToMessageId?: string): Promise<void> {
	const body = { content, mode: "join", clientKey, ...(replyToMessageId ? { replyToMessageId } : {}) };
	await json(apiFetch, `/v1/runs/${encodeURIComponent(runId)}/inputs`, { method: "POST", body: JSON.stringify(body) });
}

export async function cancelRun(apiFetch: ApiFetch, runId: string): Promise<void> {
	await json(apiFetch, `/v1/runs/${encodeURIComponent(runId)}/cancel`, { method: "POST" });
}

export async function getRunStatus(apiFetch: ApiFetch, runId: string): Promise<string | null> {
	const body = await json<{ run?: { status?: unknown } }>(apiFetch, `/v1/runs/${encodeURIComponent(runId)}`);
	return typeof body.run?.status === "string" ? body.run.status : null;
}

export async function listActiveRuns(apiFetch: ApiFetch, conversationId: string): Promise<{ id: string; status: string }[]> {
	const body = await json<{ runs?: unknown }>(apiFetch, `/v1/conversations/${encodeURIComponent(conversationId)}/runs?active=1`);
	if (!Array.isArray(body.runs)) return [];
	return body.runs.filter((run): run is { id: string; status: string } => typeof run?.id === "string" && typeof run?.status === "string");
}

/** Responde um questionário sem balão do usuário e cria o run silencioso para o bot reagir. */
export async function submitQuestionnaire(apiFetch: ApiFetch, input: { conversationId: string; questionnaireId: string; botId: string; answers: Record<string, string | string[]> }): Promise<{ runId: string | null }> {
	const result = await json<{ runId?: unknown }>(apiFetch, "/v1/questionnaire/submit", { method: "POST", body: JSON.stringify(input) });
	return { runId: typeof result.runId === "string" ? result.runId : null };
}

/** `PUT /v1/messages/:id/reaction`: troca a reação do usuário (uma por mensagem). */
export async function setReaction(apiFetch: ApiFetch, messageId: string, emoji: string): Promise<void> {
	await json(apiFetch, `/v1/messages/${encodeURIComponent(messageId)}/reaction`, { method: "PUT", body: JSON.stringify({ emoji }) });
}

/** `DELETE /v1/messages/:id/reaction`: tira a reação do usuário. */
export async function clearReaction(apiFetch: ApiFetch, messageId: string): Promise<void> {
	await json(apiFetch, `/v1/messages/${encodeURIComponent(messageId)}/reaction`, { method: "DELETE" });
}

/** `POST /v1/conversations/:id/unread`: marca a conversa inteira como não lida (vale em todos os aparelhos). */
export async function markConversationUnread(apiFetch: ApiFetch, conversationId: string): Promise<void> {
	await json(apiFetch, `/v1/conversations/${encodeURIComponent(conversationId)}/unread`, { method: "POST" });
}

/**
 * `/compact`: resume a conversa levada (`POST /v1/conversations/:id/compact`, o mesmo do web). A resposta traz o cartão
 * (conversa compactada) ou o aviso de que nada foi feito (conversa curta); execução em andamento ou aprovação pendente
 * voltam como 409 com a mensagem.
 */
export async function compactConversation(apiFetch: ApiFetch, conversationId: string, focus?: string): Promise<CompactConversationResponse> {
	return json<CompactConversationResponse>(apiFetch, `/v1/conversations/${encodeURIComponent(conversationId)}/compact`, { method: "POST", body: JSON.stringify(focus ? { focus } : {}) });
}

export const COMPACT_FAILED_TEXT = "Não consegui compactar a conversa agora. Tente de novo em instantes.";

/** Aviso do `/compact` que falhou: a mensagem que a API mandou (bloqueio, falha do resumo) ou, sem ela (proxy, rede), o aviso amigável. */
export function compactErrorText(error: unknown): string {
	if (error instanceof ChatApiError) {
		if (error.status === 401) return "Sua sessão expirou. Entre de novo.";
		if (error.fromServer && error.message.trim()) return error.message.trim();
	}
	return COMPACT_FAILED_TEXT;
}

/** Aviso amigável para um erro ao enviar (sem expor o texto técnico). */
export function sendErrorText(error: unknown): string {
	if (error instanceof ModelUnavailableError) return error.message;
	if (error instanceof ChatApiError) {
		if (error.status === 401) return "Sua sessão expirou. Entre de novo.";
		if (error.status === 409) return error.message;
		if (error.status === 429) return "Muitas mensagens seguidas. Espere um instante.";
		return "Não consegui enviar agora. Tente de novo.";
	}
	return "Sem conexão com o seu servidor. Tente de novo.";
}
