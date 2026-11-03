// Biblioteca do bot: documentos (`GET /v1/bots/:botId/artifacts`, com cursor) e painéis (`GET /v1/bots/:botId/pages`,
// de uma vez). O servidor filtra tudo pelo dono da sessão (bot de outro dono dá 404); o app só manda o id do bot.
import { ChatApiError } from "./chat-api";
import type { ApiFetch } from "./home-sync";

export type LibraryFile = { id: string; filename: string; size: number; version: number; mime: string; createdAt: string };
export type LibraryPanel = { id: string; title: string; updatedAt: string };

export const LIBRARY_FILES_PAGE = 30;
/** Teto dos painéis numa chamada só (o servidor limita a 200). */
export const LIBRARY_PANELS_LIMIT = 200;

const base = (botId: string) => `/v1/bots/${encodeURIComponent(botId)}`;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

async function readBody(response: Response): Promise<Record<string, unknown>> {
	if (!response.ok) throw new ChatApiError(response.statusText || `HTTP ${response.status}`, response.status);
	const body: unknown = await response.json().catch(() => null);
	// Resposta que não é o objeto esperado é erro do servidor (502), não "lista vazia": a pessoa vê "tentar de novo".
	if (!isRecord(body)) throw new ChatApiError("Resposta inválida", 502);
	return body;
}

function toFile(value: unknown): LibraryFile | null {
	if (!isRecord(value) || typeof value.id !== "string" || typeof value.filename !== "string" || typeof value.createdAt !== "string") return null;
	return { id: value.id, filename: value.filename, size: typeof value.size === "number" ? value.size : 0, version: typeof value.version === "number" ? value.version : 1, mime: typeof value.mime === "string" ? value.mime : "", createdAt: value.createdAt };
}

function toPanel(value: unknown): LibraryPanel | null {
	if (!isRecord(value) || typeof value.id !== "string" || typeof value.updatedAt !== "string") return null;
	return { id: value.id, title: typeof value.title === "string" && value.title.trim() ? value.title : "Painel sem título", updatedAt: value.updatedAt };
}

/** `GET /v1/bots/:botId/artifacts?limit&cursor`: uma página de documentos, mais novos primeiro. */
export async function listLibraryFiles(apiFetch: ApiFetch, botId: string, options: { cursor?: string | null; limit?: number } = {}): Promise<{ files: LibraryFile[]; nextCursor: string | null }> {
	const query = new URLSearchParams({ limit: String(options.limit ?? LIBRARY_FILES_PAGE) });
	if (options.cursor) query.set("cursor", options.cursor);
	const body = await readBody(await apiFetch(`${base(botId)}/artifacts?${query}`, { headers: { accept: "application/json" } }));
	if (!Array.isArray(body.files)) throw new ChatApiError("Resposta inválida", 502);
	const files = body.files.map(toFile).filter((file): file is LibraryFile => file !== null);
	return { files, nextCursor: typeof body.nextCursor === "string" && body.nextCursor ? body.nextCursor : null };
}

/** `GET /v1/bots/:botId/pages?limit`: os painéis do bot (usa `updatedAt`; o servidor não manda data de criação). */
export async function listLibraryPanels(apiFetch: ApiFetch, botId: string, limit = LIBRARY_PANELS_LIMIT): Promise<LibraryPanel[]> {
	const body = await readBody(await apiFetch(`${base(botId)}/pages?limit=${limit}`, { headers: { accept: "application/json" } }));
	if (!Array.isArray(body.items)) throw new ChatApiError("Resposta inválida", 502);
	return body.items.map(toPanel).filter((panel): panel is LibraryPanel => panel !== null);
}

/** Frase simples para o erro (sem texto técnico). */
export function libraryErrorText(error: unknown): string {
	if (error instanceof ChatApiError) {
		if (error.status === 401) return "Sua sessão expirou. Entre de novo.";
		if (error.status === 404) return "Não encontrei este bot.";
		return "Não consegui carregar a Biblioteca agora.";
	}
	// Falha de rede no RN chega como TypeError: é "sem conexão", não erro do servidor.
	return "Sem conexão com o seu servidor. Tente de novo.";
}
