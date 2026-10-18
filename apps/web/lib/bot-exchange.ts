import type { BotExchangeItem } from "@workspace/shared";

/**
 * Conversa entre dois bots (puro): cada troca do servidor (pedido + resposta)
 * vira até duas falas de balão, em ordem cronológica.
 */

export type ExchangeEntryKind = "request" | "reply";

export type ExchangeEntry = {
	/** Chave estável da fala (`<id da troca>:req|reply`); também o alvo do destaque. */
	key: string;
	botMessageId: string;
	kind: ExchangeEntryKind;
	/** Quem falou. */
	authorId: string;
	/** `true` = fala do bot da conversa aberta (balão à direita). */
	self: boolean;
	text: string;
	/** Título da troca (só no pedido). */
	title?: string;
	createdAt: string;
};

export function exchangeEntryKey(botMessageId: string, kind: ExchangeEntryKind): string {
	return `${botMessageId}:${kind === "request" ? "req" : "reply"}`;
}

/** Chave da fala a destacar a partir da marcação da thread (`answer` e `reply` são a resposta). */
export function exchangeFocusKey(botMessageId: string | undefined, kind: "request" | "reply" | "answer" | "sent"): string | null {
	if (!botMessageId) return null;
	return exchangeEntryKey(botMessageId, kind === "request" || kind === "sent" ? "request" : "reply");
}

function timeOf(value: string): number {
	const time = Date.parse(value);
	return Number.isNaN(time) ? 0 : time;
}

export function flattenBotExchange(items: readonly BotExchangeItem[], selfBotId: string): ExchangeEntry[] {
	const entries: ExchangeEntry[] = [];
	for (const item of items) {
		entries.push({
			key: exchangeEntryKey(item.id, "request"),
			botMessageId: item.id,
			kind: "request",
			authorId: item.fromBotId,
			self: item.fromBotId === selfBotId,
			text: item.content,
			...(item.title.trim() ? { title: item.title.trim() } : {}),
			createdAt: item.createdAt,
		});
		if (item.replyContent?.trim()) {
			entries.push({
				key: exchangeEntryKey(item.id, "reply"),
				botMessageId: item.id,
				kind: "reply",
				authorId: item.toBotId,
				self: item.toBotId === selfBotId,
				text: item.replyContent,
				createdAt: item.repliedAt ?? item.createdAt,
			});
		}
	}
	// Estável: empate (resposta no mesmo instante) mantém pedido antes da resposta.
	return entries
		.map((entry, index) => ({ entry, index }))
		.sort((a, b) => timeOf(a.entry.createdAt) - timeOf(b.entry.createdAt) || a.index - b.index)
		.map(({ entry }) => entry);
}

/** Junta páginas (mais antigas antes), sem repetir trocas. */
export function mergeExchangeItems(older: readonly BotExchangeItem[], current: readonly BotExchangeItem[]): BotExchangeItem[] {
	const seen = new Set(current.map((item) => item.id));
	return [...older.filter((item) => !seen.has(item.id)), ...current];
}
