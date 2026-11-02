import type { ChatItem } from "@/lib/chat-types";

/** Assinatura que sobrevive à troca do item ao vivo pelo salvo (o id muda, o texto não). */
function signature(item: ChatItem): string {
	return item.kind === "user" || item.kind === "assistant" ? `${item.kind}:${item.text}` : `${item.kind}:${item.id}`;
}

/**
 * Decide quais mensagens entram com animação. A primeira lista (cache ou servidor ao abrir) só é registrada; depois,
 * anima o que é novo de verdade: id nunca visto e sem um item já mostrado com o mesmo texto. Assim a troca da
 * mensagem otimista ou da resposta ao vivo pela versão salva (id novo, mesmo texto) não pisca de novo, e o texto
 * crescendo no stream (mesmo id) não anima a cada pedaço.
 */
export function createNewItemTracker() {
	let seenIds: Set<string> | null = null;
	const seenSigs = new Set<string>();
	return {
		next(items: readonly ChatItem[]): ReadonlySet<string> {
			const fresh = new Set<string>();
			if (seenIds) {
				for (const item of items) if (!seenIds.has(item.id) && !seenSigs.has(signature(item))) fresh.add(item.id);
			} else seenIds = new Set();
			for (const item of items) {
				seenIds.add(item.id);
				seenSigs.add(signature(item));
			}
			return fresh;
		},
	};
}
