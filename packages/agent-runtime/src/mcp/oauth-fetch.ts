import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";

/**
 * O SDK do MCP decide se a resposta de erro OAuth é uma `Response` com
 * `input instanceof Response`. Quando o `fetch` vem de outro realm/polyfill
 * (ou um mock) o teste falha e o objeto vira texto: "Raw body: [object Response]".
 * Este wrapper garante sempre uma `Response` global, com o corpo já lido.
 */
export function normalizingFetch(base: FetchLike = (input, init) => fetch(input, init)): FetchLike {
	return async (input, init) => {
		const res = (await base(input, init)) as unknown;
		if (res instanceof Response) return res;
		const like = res as {
			status?: number;
			statusText?: string;
			headers?: HeadersInit | { forEach?: unknown };
			arrayBuffer?: () => Promise<ArrayBuffer>;
			text?: () => Promise<string>;
		};
		const body = like.arrayBuffer ? await like.arrayBuffer() : like.text ? await like.text() : "";
		const status = typeof like.status === "number" && like.status >= 200 && like.status <= 599 ? like.status : 502;
		const nullBody = status === 204 || status === 205 || status === 304;
		return new Response(nullBody ? null : body, {
			status,
			statusText: like.statusText ?? "",
			headers: new Headers((like.headers ?? {}) as HeadersInit),
		});
	};
}

const MAX_RAW = 200;

function clip(text: string): string {
	const clean = text.replace(/\s+/g, " ").trim();
	return clean.length > MAX_RAW ? `${clean.slice(0, MAX_RAW)}…` : clean;
}

/**
 * Mensagem curta e legível (pt-BR) para falhas do início do login OAuth.
 * Nunca devolve objetos crus, corpo bruto longo ou tokens.
 */
export function humanizeOAuthError(error: unknown, context: { redirectUrl?: string } = {}): string {
	const raw = error instanceof Error ? error.message : String(error ?? "");
	const code = (error as { errorCode?: unknown } | null)?.errorCode;
	const lower = raw.toLowerCase();
	const status = /\bhttp (\d{3})\b/i.exec(raw)?.[1];
	if (lower.includes("[object response]") || lower.includes("[object object]")) {
		return "O servidor respondeu de forma inesperada ao pedido de login. Tente novamente em instantes.";
	}
	if (lower.includes("rate_limited") || lower.includes("too many") || status === "429") {
		return "O servidor limitou as tentativas de cadastro do login (muitas tentativas). Aguarde alguns minutos e tente de novo.";
	}
	if (lower.includes("does not support dynamic client registration")) {
		return "Este servidor não permite cadastro automático do aplicativo (registro dinâmico). Peça ao provedor um client ID ou use uma chave de API.";
	}
	if (code === "invalid_redirect_uri" || lower.includes("invalid_redirect_uri") || lower.includes("redirect_uri") || lower.includes("redirect uri")) {
		let host = "";
		try {
			host = context.redirectUrl ? new URL(context.redirectUrl).host : "";
		} catch {
			host = "";
		}
		return `O servidor só aceita endereços de retorno liberados previamente pelo provedor${host ? ` e o do Atlas (${host}) ainda não está liberado` : ""}. Peça ao provedor para liberá-lo ou use uma chave de API.`;
	}
	if (lower.includes("invalid_client_metadata")) {
		return "O servidor recusou o cadastro do aplicativo (dados do cliente inválidos).";
	}
	if (lower.includes("invalid_scope")) return "O servidor recusou as permissões (escopos) solicitadas.";
	if (lower.includes("no authorization servers") || lower.includes("could not discover") || lower.includes("incompatible auth server")) {
		return "Não encontramos o servidor de login deste MCP. Confira a URL ou use uma chave de API.";
	}
	if (lower.includes("fetch failed") || lower.includes("econnrefused") || lower.includes("enotfound") || lower.includes("timeout")) {
		return "Não foi possível alcançar o servidor. Confira a URL e tente de novo.";
	}
	if (typeof code === "string" && code !== "server_error") {
		return `O servidor recusou o login (${code})${raw ? `: ${clip(raw)}` : "."}`;
	}
	const bodyMatch = /raw body:\s*([\s\S]*)$/i.exec(raw);
	if (status || bodyMatch) {
		const detail = clip(bodyMatch?.[1] ?? "");
		const looksJsonOrHtml = /^\s*[<{]/.test(detail);
		return `O servidor recusou o pedido de login${status ? ` (HTTP ${status})` : ""}${detail && !looksJsonOrHtml ? `: ${detail}` : "."}`;
	}
	return clip(raw) || "Não foi possível iniciar o login deste servidor.";
}
