// Painéis do bot: `GET /v1/pages/:id` (o mesmo endpoint do web). O servidor filtra pelo dono da sessão (painel de outro
// dono dá 404, igual a um que não existe); o app só manda o id. O corpo é dado NÃO confiável: o spec passa por
// `parsePageSpec` antes de qualquer tela tocar nele.
import { type PageSource, type PageSpec, PAGE_MAX_SOURCES, parsePageSpec } from "@workspace/shared";
import { ChatApiError } from "./chat-api";
import type { ApiFetch } from "./home-sync";

export type PageData = {
	id: string;
	botId: string | null;
	title: string;
	spec: PageSpec;
	sources: PageSource[];
	revision: number;
	/** Quando o bot atualizou os dados pela última vez (`refreshedAt`), senão a última edição. */
	updatedAt: string | null;
};

/** A resposta veio, mas não é um painel que o app consiga desenhar. */
export class PageInvalidError extends Error {}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const asText = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value : null);

/** Só `http(s)`: a fonte vem do modelo e abre no navegador do sistema. */
export function safeSourceUrl(url: unknown): string | null {
	if (typeof url !== "string") return null;
	const trimmed = url.trim();
	if (!/^https?:\/\/[^\s<>]+$/i.test(trimmed)) return null;
	try {
		new URL(trimmed);
		return trimmed;
	} catch {
		return null;
	}
}

function parseSources(value: unknown): PageSource[] {
	if (!Array.isArray(value)) return [];
	const out: PageSource[] = [];
	for (const entry of value) {
		if (!isRecord(entry)) continue;
		const title = asText(entry.title)?.trim().slice(0, 200);
		if (!title) continue;
		const url = safeSourceUrl(entry.url);
		out.push({ title, ...(url ? { url } : {}) });
		if (out.length >= PAGE_MAX_SOURCES) break;
	}
	return out;
}

/** Valida a resposta de `GET /v1/pages/:id`. Lança `PageInvalidError` se o painel não puder ser desenhado. */
export function parsePageResponse(body: unknown): PageData {
	const page = isRecord(body) && isRecord(body.page) ? body.page : null;
	if (!page) throw new PageInvalidError("resposta sem painel");
	const id = asText(page.id);
	const revision = typeof page.revision === "number" && Number.isFinite(page.revision) ? page.revision : null;
	const parsed = parsePageSpec(page.spec);
	if (!id || revision === null || !parsed.ok) throw new PageInvalidError(parsed.ok ? "painel incompleto" : parsed.error);
	const stamp = asText(page.refreshedAt) ?? asText(page.updatedAt);
	return {
		id,
		botId: asText(page.botId),
		title: (asText(page.title) ?? parsed.spec.title).trim().slice(0, 120),
		spec: parsed.spec,
		sources: parseSources(page.sources),
		revision,
		updatedAt: stamp && Number.isFinite(Date.parse(stamp)) ? stamp : null,
	};
}

/** Busca um painel. Falha de rede sobe como o erro original (`TypeError` no RN); HTTP != 2xx vira `ChatApiError`. */
export async function fetchPage(apiFetch: ApiFetch, pageId: string): Promise<PageData> {
	const response = await apiFetch(`/v1/pages/${encodeURIComponent(pageId)}`, { headers: { accept: "application/json" } });
	if (!response.ok) throw new ChatApiError(response.statusText || `HTTP ${response.status}`, response.status);
	let body: unknown;
	try {
		body = await response.json();
	} catch {
		throw new PageInvalidError("resposta não é JSON");
	}
	return parsePageResponse(body);
}

/** Frase simples para o erro (sem texto técnico). */
export function pageErrorText(error: unknown): string {
	if (error instanceof ChatApiError) {
		if (error.status === 401) return "Sua sessão expirou. Entre de novo.";
		if (error.status === 404) return "Este painel não existe mais.";
		return "Não consegui carregar este painel agora.";
	}
	if (error instanceof PageInvalidError) return "Não consegui mostrar este painel.";
	// Falha de rede no RN chega como TypeError: é "sem conexão", não erro do servidor.
	return "Sem conexão com o seu servidor. Tente de novo.";
}

/** Tentar de novo só faz sentido quando o painel pode voltar (rede, servidor); "não existe mais" e sessão não. */
export function pageErrorRetryable(error: unknown): boolean {
	return !(error instanceof ChatApiError && (error.status === 404 || error.status === 401));
}
