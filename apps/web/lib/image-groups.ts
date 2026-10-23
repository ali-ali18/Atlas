import type { ImageItem } from "@/components/ai-elements/images/image-card";
import type { ThreadItem } from "@/lib/bot-thread";

export type ImageRun = { items: ImageItem[]; source: "user" | "assistant" };

/**
 * Agrupa mensagens `images` consecutivas da mesma origem (ex.: vários screenshots
 * seguidos) em um só baralho. A primeira mensagem da sequência carrega todas as
 * imagens; as demais viram `null` (não renderizam). Um separador de horário ou
 * qualquer outra mensagem no meio quebra a sequência.
 */
export function planImageRuns(
	items: readonly ThreadItem[],
	separators: ReadonlyMap<string, string> = new Map(),
): Map<string, ImageRun | null> {
	const plan = new Map<string, ImageRun | null>();
	let head: ImageRun | null = null;
	for (const item of items) {
		const message = item.type === "message" ? item.message : null;
		if (!message || message.kind !== "images") {
			head = null;
			continue;
		}
		if (head && head.source === message.source && !separators.has(item.id)) {
			head.items.push(...message.items);
			plan.set(item.id, null);
			continue;
		}
		head = { items: [...message.items], source: message.source };
		plan.set(item.id, head);
	}
	return plan;
}

/**
 * O plano é refeito a cada mudança da thread (cada token do stream): o baralho que não mudou volta com a
 * mesma lista de antes, para a linha memoizada não redesenhar a galeria à toa.
 */
export function reuseImageRuns(
	next: Map<string, ImageRun | null>,
	previous: ReadonlyMap<string, ImageRun | null> | null,
): Map<string, ImageRun | null> {
	if (!previous) return next;
	for (const [id, run] of next) {
		const before = previous.get(id);
		if (!run || !before || before.source !== run.source || before.items.length !== run.items.length) continue;
		if (before.items.every((item, index) => item === run.items[index])) next.set(id, before);
	}
	return next;
}
