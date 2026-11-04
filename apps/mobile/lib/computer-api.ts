// Computador do bot (VM) pelo app: os mesmos endpoints do web (`apps/web/lib/atlas-api.ts`), sempre por `apiFetch`
// (a sessão sai só para a origem do servidor salvo). Nada aqui loga nem guarda o link da tela: ele carrega um token
// que dá controle da VM por alguns minutos.
import type { ApiFetch } from "./home-sync";
import { parseViewerSocketUrl } from "./viewer-link";

export type ComputerSessionStatus = "starting" | "running" | "stopped" | "error";
export type ComputerSession = { sessionId: string; status: ComputerSessionStatus };

export type ComputerErrorKind = "unauthorized" | "not-found" | "viewer-unavailable" | "unavailable" | "bad-link" | "network";

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
 * `GET /v1/sandbox/sessions/:id/viewer-link`: devolve o endereço `wss://` do WebSocket do viewer (com o token `ws`, que
 * vale 10 min e só é conferido ao conectar). Usa só o `path=` da resposta; a rota HTTP `vt` e o token dela são descartados.
 * Recusa o que não for o formato do servidor, de outra sessão ou de outra origem que não a do servidor salvo.
 */
export async function getViewerSocket(apiFetch: ApiFetch, baseUrl: string, sessionId: string): Promise<string> {
	const response = await call(apiFetch, `/v1/sandbox/sessions/${encodeURIComponent(sessionId)}/viewer-link`, { headers: { accept: "application/json" } }, (status) => (status === 409 ? new ComputerApiError("viewer-unavailable", status) : statusError(status)));
	const body = (await json(response)) as { url?: unknown } | null;
	const socket = parseViewerSocketUrl(baseUrl, sessionId, body?.url);
	if (!socket) throw new ComputerApiError("bad-link", response.status);
	return socket;
}

/** Tamanho máximo aceito para uma captura (a miniatura não precisa de mais; protege a memória do celular). */
export const MAX_FRAME_BYTES = 6 * 1024 * 1024;

/** Blob → `data:` URI (o `Image` do React Native lê assim, sem arquivo em disco). */
function blobToDataUri(blob: Blob): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onloadend = () => (typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("leitura")));
		reader.onerror = () => reject(new Error("leitura"));
		reader.readAsDataURL(blob);
	});
}

/**
 * `GET /v1/sandbox/sessions/:id/screenshot` (`apps/api/src/routes/sandbox.ts`): uma captura PNG da tela da VM, sem abrir o
 * viewer. É o que a miniatura do cartão "Computador" mostra. Devolve um `data:` URI. Recusa o que não for imagem ou
 * passar de `MAX_FRAME_BYTES`. `toDataUri` é injetável nos testes.
 */
export async function getComputerFrame(apiFetch: ApiFetch, sessionId: string, toDataUri: (blob: Blob) => Promise<string> = blobToDataUri): Promise<string> {
	const response = await call(apiFetch, `/v1/sandbox/sessions/${encodeURIComponent(sessionId)}/screenshot`, { headers: { accept: "image/png" } }, statusError);
	if (!(response.headers.get("content-type") ?? "").startsWith("image/")) throw new ComputerApiError("unavailable", response.status);
	let blob: Blob;
	try {
		blob = await response.blob();
	} catch {
		throw new ComputerApiError("network");
	}
	if (blob.size === 0 || blob.size > MAX_FRAME_BYTES) throw new ComputerApiError("unavailable", response.status);
	return toDataUri(blob);
}
