// Conversa entre dois bots, somente leitura (puro): cada troca do servidor (pedido + resposta) vira até duas falas,
// em ordem cronológica. Porta do `apps/web/lib/bot-exchange.ts`; os dados vêm do mesmo endpoint escopado ao dono.
import type { BotExchangeItem, BotExchangeResponse } from "@workspace/shared";
import type { ApiFetch } from "./home-sync";

export type ExchangeEntry = {
	/** Chave estável da fala (`<id da troca>:req|reply`); também o alvo do destaque. */
	key: string;
	kind: "request" | "reply";
	/** Quem falou. */
	authorId: string;
	/** `true` = fala do bot da conversa aberta (balão à direita). */
	self: boolean;
	text: string;
	/** Título da troca (só no pedido). */
	title?: string;
	createdAt: string;
};

export function exchangeEntryKey(botMessageId: string, kind: ExchangeEntry["kind"]): string {
	return `${botMessageId}:${kind === "request" ? "req" : "reply"}`;
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
				kind: "reply",
				authorId: item.toBotId,
				self: item.toBotId === selfBotId,
				text: item.replyContent,
				createdAt: item.repliedAt ?? item.createdAt,
			});
		}
	}
	// Estável: empate (resposta no mesmo instante) mantém o pedido antes da resposta.
	return entries
		.map((entry, index) => ({ entry, index }))
		.sort((a, b) => timeOf(a.entry.createdAt) - timeOf(b.entry.createdAt) || a.index - b.index)
		.map(({ entry }) => entry);
}

/** Intervalo sem falas a partir do qual a conversa ganha uma linha de data e hora. */
export const STAMP_GAP_MS = 30 * 60 * 1000;

/** Falas que abrem um trecho novo (a primeira, e as que vêm depois de uma pausa): levam a data e hora acima. */
export function stampBreaks(entries: readonly ExchangeEntry[], gapMs: number = STAMP_GAP_MS): Set<string> {
	const keys = new Set<string>();
	entries.forEach((entry, index) => {
		const previous = entries[index - 1];
		if (!previous || timeOf(entry.createdAt) - timeOf(previous.createdAt) >= gapMs) keys.add(entry.key);
	});
	return keys;
}

/** Junta páginas (as mais antigas antes), sem repetir trocas. */
export function mergeExchangeItems(older: readonly BotExchangeItem[], current: readonly BotExchangeItem[]): BotExchangeItem[] {
	const seen = new Set(current.map((item) => item.id));
	return [...older.filter((item) => !seen.has(item.id)), ...current];
}

/** Lê a página do servidor sem confiar no formato: troca sem os campos que a tela usa é descartada. */
export function parseExchangePage(body: unknown): BotExchangeResponse | null {
	if (typeof body !== "object" || body === null) return null;
	const { messages, nextCursor } = body as { messages?: unknown; nextCursor?: unknown };
	if (!Array.isArray(messages)) return null;
	const isText = (value: unknown): value is string => typeof value === "string";
	const rows = messages.filter(
		(row): row is BotExchangeItem =>
			typeof row === "object" && row !== null && isText((row as BotExchangeItem).id) && isText((row as BotExchangeItem).fromBotId) && isText((row as BotExchangeItem).toBotId) && isText((row as BotExchangeItem).content) && isText((row as BotExchangeItem).createdAt),
	).map((row) => ({ ...row, title: isText(row.title) ? row.title : "", replyContent: isText(row.replyContent) ? row.replyContent : null, repliedAt: isText(row.repliedAt) ? row.repliedAt : null }));
	return { messages: rows, nextCursor: isText(nextCursor) ? nextCursor : null };
}

export class ExchangeError extends Error {
	constructor(
		message: string,
		readonly status: number,
	) {
		super(message);
	}
}

/**
 * `GET /v1/bots/:botId/exchanges/:peerBotId` (o mesmo do web): com a sessão do dono, o servidor só responde se os dois
 * bots são dele (outro dono recebe 404). `cursor` busca trocas mais antigas.
 */
export async function fetchBotExchange(apiFetch: ApiFetch, botId: string, peerBotId: string, options: { limit?: number; cursor?: string | null; signal?: AbortSignal } = {}): Promise<BotExchangeResponse> {
	const params: string[] = [];
	if (options.limit) params.push(`limit=${options.limit}`);
	if (options.cursor) params.push(`cursor=${encodeURIComponent(options.cursor)}`);
	const path = `/v1/bots/${encodeURIComponent(botId)}/exchanges/${encodeURIComponent(peerBotId)}${params.length ? `?${params.join("&")}` : ""}`;
	const response = await apiFetch(path, { headers: { accept: "application/json" }, signal: options.signal });
	if (!response.ok) throw new ExchangeError(response.status === 404 ? "Conversa não encontrada." : "Não consegui carregar a conversa.", response.status);
	const page = parseExchangePage(await response.json());
	if (!page) throw new ExchangeError("Resposta inesperada do servidor.", 502);
	return page;
}
