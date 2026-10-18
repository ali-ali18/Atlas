import { clipWithNotice } from "../clip-notice.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";

/**
 * Helpers dos servidores MCP embutidos do Google (`./google.ts`): chamada
 * HTTP autenticada com o token do usuário, decodificação RFC 2822 do Gmail e
 * teto de texto devolvido ao modelo. Nunca loga nem ecoa o access token.
 */

/** Fetch mínimo estrutural (aceita o fetch global e mocks de teste). */
export type GoogleFetchFn = (
	input: string,
	init?: RequestInit,
) => Promise<{
	ok: boolean;
	status: number;
	json(): Promise<unknown>;
	text(): Promise<string>;
}>;

export type GoogleApiContext = {
	/** Renova/valida o token salvo; joga `UnauthorizedError` se não der (reconectar). */
	getAccessToken: () => Promise<string>;
	fetchFn: GoogleFetchFn;
};

/** Erro de uma chamada à REST API do Google que não é 401 (fica como `isError` na tool). */
export class GoogleApiError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
		this.name = "GoogleApiError";
	}
}

/**
 * Traduz um erro HTTP do Google em mensagem acionável para o modelo (pura).
 * Sem regra aplicável devolve a mensagem crua (`HTTP <status>: ...`).
 */
export function mapGoogleApiError(
	status: number,
	message: string,
	product?: "calendar" | "drive" | "gmail" | "sheets",
): string {
	const lower = message.toLowerCase();
	if (status === 403) {
		if (lower.includes("insufficient authentication scopes")) {
			return "Falta permissão no conector: reconecte no Marketplace.";
		}
		if (lower.includes("has not been used") || lower.includes("disabled")) {
			return "A API do Google está desativada no projeto do Google Cloud. O usuário precisa ativá-la.";
		}
		if (lower.includes("does not have permission")) {
			return "A conta Google conectada não tem acesso a esse arquivo (ele pode ter sido criado por outra conta ou pelo navegador). Crie um novo com create_spreadsheet ou peça ao usuário para compartilhar o arquivo com a conta conectada.";
		}
	}
	if (status === 404) {
		return product === "calendar"
			? "calendarId inválido: use list_calendars ou 'primary'."
			: "não encontrado (id errado ou sem acesso).";
	}
	return message;
}

async function googleErrorMessage(res: { json(): Promise<unknown> }, status: number): Promise<string> {
	try {
		const data = (await res.json()) as { error?: { message?: string; errors?: { message?: string }[] } };
		const message = data.error?.message ?? data.error?.errors?.[0]?.message;
		return message ? `HTTP ${status}: ${message}` : `HTTP ${status}`;
	} catch {
		return `HTTP ${status}`;
	}
}

/** Chama a REST API do Google com `Authorization: Bearer <token>`. 401 vira `UnauthorizedError`. */
export async function googleFetch(
	ctx: GoogleApiContext,
	url: string,
	init: RequestInit = {},
): Promise<Awaited<ReturnType<GoogleFetchFn>>> {
	let token: string;
	try {
		token = await ctx.getAccessToken();
	} catch (error) {
		if (error instanceof UnauthorizedError) throw error;
		throw new UnauthorizedError(error instanceof Error ? error.message : String(error));
	}
	const headers = { ...(init.headers as Record<string, string> | undefined), Authorization: `Bearer ${token}` };
	const res = await ctx.fetchFn(url, { ...init, headers });
	if (res.status === 401) throw new UnauthorizedError(await googleErrorMessage(res, 401));
	if (!res.ok) throw new GoogleApiError(res.status, await googleErrorMessage(res, res.status));
	return res;
}

export async function googleJson<T>(ctx: GoogleApiContext, url: string, init?: RequestInit): Promise<T> {
	const res = await googleFetch(ctx, url, init);
	return (await res.json()) as T;
}

export async function googleText(ctx: GoogleApiContext, url: string, init?: RequestInit): Promise<string> {
	const res = await googleFetch(ctx, url, init);
	return res.text();
}

/** Teto do texto devolvido ao modelo (igual ao teto geral de resultado de tool MCP). */
export const GOOGLE_TEXT_MAX_CHARS = 20_000;

export function capGoogleText(text: string, maxChars = GOOGLE_TEXT_MAX_CHARS): string {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, maxChars)}\n[truncado: ${text.length} caracteres]`;
}

export function base64UrlEncode(input: string): string {
	return Buffer.from(input, "utf8").toString("base64url");
}

export function base64UrlDecode(input: string): string {
	return Buffer.from(input, "base64url").toString("utf8");
}

/** Resultado padrão de sucesso: um único bloco de texto. */
export function textResult(text: string): { content: { type: "text"; text: string }[] } {
	return { content: [{ type: "text", text }] };
}

/** Resultado padrão de erro (nunca ecoa o token; a mensagem já vem sanitizada). */
export function errorResult(text: string): { isError: true; content: { type: "text"; text: string }[] } {
	return { isError: true, content: [{ type: "text", text }] };
}
