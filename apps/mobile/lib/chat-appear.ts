import type { ChatItem } from "@/lib/chat-types";

/** Assinatura que sobrevive à troca do item ao vivo pelo salvo (o id muda, o conteúdo não). */
function signature(item: ChatItem): string {
	return item.kind === "user" || item.kind === "assistant" ? `${item.kind}:${item.text}` : `${item.kind}:${item.id}`;
}

/**
 * Decide quais mensagens entram com animação. A primeira lista (cache ou servidor ao abrir) só é registrada. Depois,
 * anima só o que entrou no fim da conversa (depois do último item já visto), com id novo, e que não é a troca de um
 * item que acabou de sair com o mesmo conteúdo (mensagem otimista ou resposta ao vivo virando a versão salva).
 * Mensagens antigas carregadas ao rolar para cima ficam antes do que já foi visto e não animam. Guarda só ids e a
 * lista anterior (sem acumular os textos do stream).
 */
export function createNewItemTracker() {
	let seenIds: Set<string> | null = null;
	let previous: readonly ChatItem[] = [];
	return {
		next(items: readonly ChatItem[]): ReadonlySet<string> {
			const fresh = new Set<string>();
			if (seenIds) {
				const present = new Set(items.map((item) => item.id));
				const replaced = new Set(previous.filter((item) => !present.has(item.id)).map(signature));
				let lastSeen = -1;
				items.forEach((item, index) => {
					if (seenIds!.has(item.id)) lastSeen = index;
				});
				for (let index = lastSeen + 1; index < items.length; index += 1) {
					const item = items[index]!;
					if (!seenIds.has(item.id) && !replaced.has(signature(item))) fresh.add(item.id);
				}
			} else seenIds = new Set();
			for (const item of items) seenIds.add(item.id);
			previous = items;
			return fresh;
		},
	};
}
