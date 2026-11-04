// Regra de "lida" do app, a mesma do web (`apps/web/lib/unread.ts` + `use-mark-read.ts`): a conversa só é marcada
// quando a última mensagem está à vista e há algo a limpar (a home mostra não lida, ou chegou mensagem nova com a
// conversa aberta). Manda o id da última mensagem; o servidor usa o horário dela, nunca o do aparelho.

export type SeenInput = {
	/** A home mostra esta conversa como não lida. */
	unread: boolean;
	/** Id da última mensagem do fio (a que está à vista). */
	lastId: string | null;
	/** Último id já enviado ao servidor nesta abertura. */
	lastSentId: string | null;
	/** Último id visto numa conferência anterior desta abertura (`null` na primeira). */
	baselineId: string | null;
};

export function shouldMarkSeen({ unread, lastId, lastSentId, baselineId }: SeenInput): boolean {
	if (!lastId || lastId === lastSentId) return false;
	return unread || (baselineId !== null && lastId !== baselineId);
}
