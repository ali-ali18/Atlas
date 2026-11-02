// Chamadas do chat ao servidor: os mesmos endpoints do web (`apps/web/lib/atlas-api.ts`), sempre por `apiFetch`
// (a sessão sai só para a origem do servidor salvo).
import { messagesPath, PAGE_SIZE, parsePage, type MessagePage, type PageCursor } from "./chat-thread";
import type { ApiFetch } from "./home-sync";

export class ChatApiError extends Error {
	constructor(
		message: string,
		readonly status: number,
	) {
		super(message);
	}
}

/** O servidor recusou a sessão: quem chamou encerra a sessão como na home. */
export const isUnauthorized = (error: unknown): boolean => error instanceof ChatApiError && error.status === 401;

/** Sem resposta do servidor (rede, DNS, tempo): o app segue com o que tem. */
export const isNetworkError = (error: unknown): boolean => !(error instanceof ChatApiError);

async function failure(response: Response): Promise<never> {
	let message = response.statusText || `HTTP ${response.status}`;
	try {
		const body = (await response.json()) as { error?: unknown };
		if (typeof body.error === "string" && body.error.trim()) message = body.error;
	} catch {
		// corpo sem JSON: fica o texto do status
	}
	throw new ChatApiError(message, response.status);
}

async function json<T>(apiFetch: ApiFetch, path: string, init: RequestInit = {}): Promise<T> {
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

export type CreateRunInput = { content: string; conversationId: string; botId: string; decisionConfirmId?: string; clientKey?: string };
export type CreateRunResult = { runId: string | null; status: string };

/** `POST /v1/runs`, igual ao do web (`createAgentRun`): o servidor escolhe o modelo (`modelAuto`). */
export async function createRun(apiFetch: ApiFetch, input: CreateRunInput): Promise<CreateRunResult> {
	const body = {
		messages: [{ role: "user", content: input.content }],
		conversationId: input.conversationId,
		botId: input.botId,
		modelAuto: true,
		...(input.decisionConfirmId ? { decisionConfirmId: input.decisionConfirmId } : {}),
		...(input.clientKey ? { clientKey: input.clientKey } : {}),
	};
	const result = await json<{ runId?: unknown; status?: unknown }>(apiFetch, "/v1/runs", {
		method: "POST",
		body: JSON.stringify(body),
		...(input.clientKey ? { headers: { "Idempotency-Key": input.clientKey } } : {}),
	});
	return { runId: typeof result.runId === "string" ? result.runId : null, status: typeof result.status === "string" ? result.status : "" };
}

/** Fala enviada com o run em andamento: entra nele (`mode: "join"`), como no web. */
export async function createRunInput(apiFetch: ApiFetch, runId: string, content: string, clientKey: string): Promise<void> {
	await json(apiFetch, `/v1/runs/${encodeURIComponent(runId)}/inputs`, { method: "POST", body: JSON.stringify({ content, mode: "join", clientKey }) });
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

/** Aviso amigável para um erro ao enviar (sem expor o texto técnico). */
export function sendErrorText(error: unknown): string {
	if (error instanceof ChatApiError) {
		if (error.status === 401) return "Sua sessão expirou. Entre de novo.";
		if (error.status === 409) return error.message;
		if (error.status === 429) return "Muitas mensagens seguidas. Espere um instante.";
		return "Não consegui enviar agora. Tente de novo.";
	}
	return "Sem conexão com o seu servidor. Tente de novo.";
}
