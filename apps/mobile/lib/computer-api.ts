// Computador do bot (VM) pelo app: os mesmos endpoints do web (`apps/web/lib/atlas-api.ts`), sempre por `apiFetch`
// (a sessão sai só para a origem do servidor salvo). Nada aqui loga nem guarda o link da tela: ele carrega um token
// que dá controle da VM por alguns minutos.
import { resolveApiUrl } from "./api-fetch";
import { checkVmText, vmTextProblem } from "./computer-text";
import type { ApiFetch } from "./home-sync";

export type ComputerSessionStatus = "starting" | "running" | "stopped" | "error";
export type ComputerSession = { sessionId: string; status: ComputerSessionStatus };

export type ComputerErrorKind = "unauthorized" | "not-found" | "viewer-unavailable" | "unavailable" | "bad-link" | "bad-input" | "network" | "send";

/** Erro já classificado: o texto técnico do servidor nunca chega à tela (só `computerErrorText`). */
export class ComputerApiError extends Error {
	constructor(
		readonly kind: ComputerErrorKind,
		readonly status = 0,
		message?: string,
	) {
		super(message ?? kind);
	}
}

const JSON_HEADERS = { accept: "application/json", "content-type": "application/json" };
const VIEWER_PATH_PREFIX = "/v1/sandbox/vt/";
const STATUSES: readonly string[] = ["starting", "running", "stopped", "error"];

/** Frase simples em pt-BR para o erro. */
export function computerErrorText(error: unknown): string {
	if (error instanceof ComputerApiError) {
		switch (error.kind) {
			case "unauthorized":
				return "Sua sessão expirou. Entre de novo.";
			case "not-found":
				return "Não encontrei o computador deste bot.";
			case "viewer-unavailable":
				return "A tela ao vivo não está disponível neste servidor.";
			case "unavailable":
				return "O computador não respondeu agora. Tente de novo.";
			case "bad-link":
				return "Não deu para abrir a tela do computador.";
			case "bad-input":
				return error.message;
			case "send":
				return "Não foi possível enviar para a VM.";
			case "network":
				return "Sem conexão com o seu servidor. Tente de novo.";
		}
	}
	return "Sem conexão com o seu servidor. Tente de novo.";
}

async function call(apiFetch: ApiFetch, path: string, init: RequestInit | undefined, notOk: (status: number) => ComputerApiError): Promise<Response> {
	let response: Response;
	try {
		response = await apiFetch(path, init);
	} catch {
		throw new ComputerApiError("network");
	}
	if (!response.ok) throw notOk(response.status);
	return response;
}

function statusError(status: number): ComputerApiError {
	if (status === 401) return new ComputerApiError("unauthorized", status);
	if (status === 404) return new ComputerApiError("not-found", status);
	return new ComputerApiError("unavailable", status);
}

const sendError = (status: number): ComputerApiError => (status === 401 ? new ComputerApiError("unauthorized", status) : new ComputerApiError("send", status));

async function json(response: Response): Promise<unknown> {
	try {
		return await response.json();
	} catch {
		throw new ComputerApiError("unavailable", response.status);
	}
}

function toSession(value: unknown): ComputerSession | null {
	if (typeof value !== "object" || value === null) return null;
	const { sessionId, status } = value as { sessionId?: unknown; status?: unknown };
	if (typeof sessionId !== "string" || !sessionId || typeof status !== "string" || !STATUSES.includes(status)) return null;
	return { sessionId, status: status as ComputerSessionStatus };
}

/** `GET /v1/sandbox/sessions?conversationId=…&wake=0`: a sessão ativa, sem religar a VM desligada. `null` = não há. */
export async function getComputerSession(apiFetch: ApiFetch, conversationId: string): Promise<ComputerSession | null> {
	const response = await call(apiFetch, `/v1/sandbox/sessions?conversationId=${encodeURIComponent(conversationId)}&wake=0`, { headers: { accept: "application/json" } }, statusError);
	const body = (await json(response)) as { session?: unknown } | null;
	return toSession(body?.session);
}

/** `POST /v1/sandbox/sessions`: liga ou acorda o computador da conversa. */
export async function startComputer(apiFetch: ApiFetch, conversationId: string): Promise<ComputerSession> {
	const response = await call(apiFetch, "/v1/sandbox/sessions", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ conversationId }) }, statusError);
	const session = toSession(await json(response));
	if (!session) throw new ComputerApiError("unavailable", response.status);
	return session;
}

/**
 * `GET /v1/sandbox/sessions/:id/viewer-link`: o endereço ABSOLUTO da tela ao vivo (vale 10 min). Recusa o que não for
 * do servidor salvo ou não estiver sob `/v1/sandbox/vt/`: a WebView só carrega a origem do servidor.
 */
export async function getViewerLink(apiFetch: ApiFetch, baseUrl: string, sessionId: string): Promise<string> {
	const response = await call(apiFetch, `/v1/sandbox/sessions/${encodeURIComponent(sessionId)}/viewer-link`, { headers: { accept: "application/json" } }, (status) => (status === 409 ? new ComputerApiError("viewer-unavailable", status) : statusError(status)));
	const body = (await json(response)) as { url?: unknown } | null;
	const path = typeof body?.url === "string" ? body.url : "";
	// Só caminho absoluto sob o prefixo do viewer ("//host/…" e "\\host" virariam outra origem ao resolver).
	if (!path.startsWith(VIEWER_PATH_PREFIX)) throw new ComputerApiError("bad-link", response.status);
	const absolute = resolveApiUrl(baseUrl, path);
	if (!absolute) throw new ComputerApiError("bad-link", response.status);
	return absolute;
}

/** `POST …/type`: digita (ou cola) texto na VM. Valida vazio e o limite antes de chamar o servidor. */
export async function sendText(apiFetch: ApiFetch, sessionId: string, text: string): Promise<void> {
	const checked = checkVmText(text);
	if (!checked.ok) throw new ComputerApiError("bad-input", 0, vmTextProblem(checked.reason));
	await call(apiFetch, `/v1/sandbox/sessions/${encodeURIComponent(sessionId)}/type`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ text: checked.text }) }, sendError);
}

/** Teclas que a barra do teclado manda (nomes do xdotool, como o web). */
export type ComputerKey = "Return" | "BackSpace";

/** `POST …/key`: aperta uma tecla na VM. */
export async function sendKey(apiFetch: ApiFetch, sessionId: string, combo: ComputerKey): Promise<void> {
	await call(apiFetch, `/v1/sandbox/sessions/${encodeURIComponent(sessionId)}/key`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ combo }) }, sendError);
}
