import { compress } from "hono/compress";
import type { MiddlewareHandler } from "hono";

/**
 * Tipos que valem comprimir: JSON e texto. SSE (`text/event-stream`) NUNCA: o gzip segura os bytes até encher
 * o bloco e o stream deixa de ser em tempo real. O padrão do Hono já pula SSE; a regra aqui é explícita para
 * não depender disso numa atualização.
 */
export function isCompressibleContentType(contentType: string): boolean {
	const type = contentType.split(";")[0]!.trim().toLowerCase();
	if (type === "text/event-stream") return false;
	return type === "application/json" || type.endsWith("+json") || type.startsWith("text/") || type === "application/javascript";
}

/**
 * gzip/deflate conforme o Accept-Encoding. O piso de 1 KB só vale quando a resposta traz Content-Length
 * (o `c.json` do Hono não traz). Resposta com `no-transform` também não é tocada.
 */
export function apiCompress(): MiddlewareHandler {
	return compress({ threshold: 1024, contentTypeFilter: isCompressibleContentType });
}
