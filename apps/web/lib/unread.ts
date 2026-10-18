import { hasUnread, sourcePreviewPrefix, type MessageSource } from "@workspace/shared";
import type { Bot } from "@workspace/shared";
import { hasUnreadResults } from "./delivery-badge";

/** A conversa tem algo não lido? Estado do servidor; bots de uma API antiga caem no badge de resultados. */
export function botHasUnread(bot: Pick<Bot, "unreadCount" | "manualUnread" | "unreadResults">): boolean {
	if (bot.unreadCount === undefined && bot.manualUnread === undefined) return hasUnreadResults(bot);
	return hasUnread(bot) || hasUnreadResults(bot);
}

/** Total para o título da aba: mensagens novas, e 1 por conversa só marcada como não lida. */
export function totalUnread(items: Array<{ unreadCount?: number; manualUnread?: boolean }>): number {
	let total = 0;
	for (const item of items) {
		const count = item.unreadCount ?? 0;
		total += count > 0 ? count : item.manualUnread ? 1 : 0;
	}
	return total;
}

/** Remove um prefixo "(N)" que a gente mesmo colocou (o navegador apara o espaço final de um título vazio). */
export function stripUnreadTitle(title: string): string {
	if (!title.startsWith("(")) return title;
	const end = title.indexOf(")");
	if (end < 2) return title;
	const digits = title.slice(1, end);
	const numeric = digits.split("").every((char) => char >= "0" && char <= "9");
	return numeric ? title.slice(end + 1).trimStart() : title;
}

/** "(3) Título" quando há não lidas; o título original caso contrário. */
export function withUnreadTitle(title: string, count: number): string {
	const base = stripUnreadTitle(title);
	return count > 0 ? `(${count}) ${base}` : base;
}

/** Mensagens do assistente que chegaram depois da última vista (pílula "↓ N novas"). */
export function newMessagesSince(messages: Array<{ id: string; kind: string }>, seenUpToId: string | null): number {
	const from = seenUpToId ? messages.findIndex((message) => message.id === seenUpToId) : -1;
	// A última vista sumiu (placeholder do stream trocado pela mensagem persistida): sem ponto de partida, não inventa "N novas".
	if (seenUpToId && from < 0) return 0;
	return messages.slice(from + 1).filter((message) => message.kind === "assistant").length;
}

/** Id da mensagem logo antes da âncora de "Novas mensagens" (ponto de partida da contagem). */
export function messageBefore(messages: Array<{ id: string }>, anchorId: string | null): string | null {
	if (!anchorId) return messages.at(-1)?.id ?? null;
	const index = messages.findIndex((message) => message.id === anchorId);
	if (index < 0) return messages.at(-1)?.id ?? null;
	return index > 0 ? messages[index - 1]!.id : null;
}

/** Reenvio da leitura quando o servidor ainda diz "não lida" depois de enviarmos (corrida com a persistência). */
export const MARK_READ_RESEND_MS = 3000;
export const MARK_READ_MAX_RESENDS = 3;

export type MarkReadInput = {
	bottomVisible: boolean;
	documentVisible: boolean;
	focused: boolean;
	lastMessageId: string | null;
	lastSentId: string | null;
	/** Há algo a limpar: bolinha acesa ou mensagem nova desde que abriu. */
	pending: boolean;
	/** O servidor ainda reporta não lida (contagem ou marca manual) para esta conversa. */
	serverUnread?: boolean;
	/** Quando (ms) e quantas vezes já enviamos para este mesmo id. */
	lastSentAt?: number;
	resends?: number;
	now?: number;
};

/**
 * Só marca como lida com a última mensagem à vista, aba visível e em foco. Mensagem nova marca sempre;
 * o MESMO id só é reenviado se o servidor ainda diz "não lida" (a mensagem foi gravada depois do nosso
 * "agora", ou uma mensagem escondida veio depois), com espaçamento e limite para nunca entrar em laço.
 */
export function shouldMarkRead(input: MarkReadInput): boolean {
	const attentive = input.bottomVisible && input.documentVisible && input.focused && input.lastMessageId !== null;
	if (!attentive) return false;
	if (input.lastMessageId !== input.lastSentId) return input.pending || input.serverUnread === true;
	if (!input.serverUnread) return false;
	if ((input.resends ?? 0) >= MARK_READ_MAX_RESENDS) return false;
	return (input.now ?? 0) - (input.lastSentAt ?? 0) >= MARK_READ_RESEND_MS;
}

function sourceKey(source: MessageSource): string {
	return `${source.kind}|${source.label}|${source.at}`;
}

/** Mensagens que abrem um trecho de mesma origem: só elas ganham o marcador "Rotina · X · 20:00". */
export function sourceMarkerIds(messages: Array<{ id: string; runSource?: MessageSource | null }>): Set<string> {
	const ids = new Set<string>();
	let previous: string | null = null;
	for (const message of messages) {
		const key = message.runSource ? sourceKey(message.runSource) : null;
		if (key && key !== previous) ids.add(message.id);
		previous = key;
	}
	return ids;
}

/** Prévia da lista: "Rotina: Resumo da agenda · texto". */
export function previewWithSource(text: string, source: Pick<MessageSource, "kind" | "label"> | null | undefined): string {
	const prefix = sourcePreviewPrefix(source);
	return prefix ? `${prefix} · ${text}` : text;
}

/** Campos da lista que vêm do servidor a cada atualização (sem tocar no resto do bot). */
export function agentUnreadPatch(bot: Bot): {
	notifications: boolean | undefined;
	unreadCount: number;
	firstUnreadMessageId: string | null;
	manualUnread: boolean;
	lastMessage: string | null;
	lastMessageAt: string | null;
} {
	return {
		notifications: botHasUnread(bot) ? true : undefined,
		unreadCount: bot.unreadCount ?? 0,
		firstUnreadMessageId: bot.firstUnreadMessageId ?? null,
		manualUnread: bot.manualUnread ?? false,
		lastMessage: bot.lastMessage ? previewWithSource(bot.lastMessage.content, bot.lastMessage.source) : null,
		lastMessageAt: bot.lastMessage?.createdAt ?? null,
	};
}
