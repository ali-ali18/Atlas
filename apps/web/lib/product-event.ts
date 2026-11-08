import { parseProductCard, type PersistedProductCard } from "@workspace/shared";

/**
 * Cartão `product` ao vivo: passa pelo MESMO `parseProductCard` do cartão gravado (recalcula o total e o "mais barata",
 * descarta foto insegura e item inválido), então o que aparece durante o run é igual ao que volta ao recarregar.
 * `null` = nenhum item válido: o cartão não é mostrado.
 */
export function parseLiveProductEvent(event: { cardId: string; items: unknown; runId?: string }): PersistedProductCard | null {
	return parseProductCard({ cardId: event.cardId, items: event.items, ...(event.runId ? { runId: event.runId } : {}) } as Record<string, unknown>);
}
