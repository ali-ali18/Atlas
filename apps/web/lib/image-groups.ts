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
