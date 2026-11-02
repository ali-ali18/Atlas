// Responder uma mensagem: o trecho citado (o mesmo recorte de 160 caracteres que o servidor devolve em
// `SessionMessage.replyTo`) e a leitura segura do que vem dele. Só lógica pura.
import { plainQuoteText } from "@workspace/shared";
import type { ChatItem, ReplyQuote } from "./chat-types";
import { isStoredMessage } from "./message-actions";

/** Tamanho do trecho citado; o servidor corta no mesmo valor. */
export const REPLY_SNIPPET_MAX = 160;

/**
 * Uma linha só (quebras e espaços repetidos viram um espaço), sem markdown (`**negrito**`, título, link, bloco de código:
 * a mesma limpeza do servidor, de `@workspace/shared`), no máximo 160 caracteres; emoji não é cortado ao meio.
 */
export function quoteSnippet(text: string): string {
	const flat = plainQuoteText(text);
	const chars = Array.from(flat);
	return chars.length > REPLY_SNIPPET_MAX ? chars.slice(0, REPLY_SNIPPET_MAX).join("") : flat;
}

/** A citação para responder esta linha; `null` quando ela não pode ser citada (sem id gravado, cartão, vazia). */
export function replyQuoteFor(item: ChatItem): ReplyQuote | null {
	if (!isStoredMessage(item)) return null;
	const text = quoteSnippet(item.text);
	return text ? { id: item.id, role: item.kind, text } : null;
}

/** `replyTo` como o servidor manda; qualquer coisa fora do contrato (ou sem texto) vira `null`. */
export function parseReplyTo(raw: unknown): ReplyQuote | null {
	if (typeof raw !== "object" || raw === null) return null;
	const { id, role, text } = raw as { id?: unknown; role?: unknown; text?: unknown };
	if (typeof id !== "string" || !id || (role !== "user" && role !== "assistant") || typeof text !== "string") return null;
	const snippet = quoteSnippet(text);
	return snippet ? { id, role, text: snippet } : null;
}
