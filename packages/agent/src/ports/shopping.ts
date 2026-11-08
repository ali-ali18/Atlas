// Portas de compras (F6): ler a página de um produto, mostrar o cartão e guardar a compra do dono. A busca é a porta
// `Search` que já existe. Toda chamada leva o `userId` do RUN (nunca do modelo). Falha da porta = `throw` com a mensagem
// real (a tool a devolve como `ok:false`). A frente C (checkout) acrescenta as portas dela em outro arquivo.
import type { ProductOffer, PurchaseInput, PurchaseView } from "@workspace/shared";

/** O HTML BRUTO de uma página de produto (o JSON-LD está nele; o texto extraído não o traz). SSRF barrado no adaptador. */
export interface ProductPages {
	fetchHtml(userId: string, url: string, signal?: AbortSignal): Promise<{ url: string; html: string }>;
}

export type ProductCardPayload = { cardId: string; items: ProductOffer[]; cheapestUrl?: string; incomplete?: boolean };

export interface ProductCards {
	/** Mostra (e grava na conversa) o cartão `product`. O mesmo `cardId` não duplica. */
	show(userId: string, runId: string, card: ProductCardPayload): Promise<void>;
}

export type RecordedPurchase = {
	purchase: PurchaseView;
	duplicate: boolean;
	/** Vigia de entrega ligado à compra (se houver). Serve para recriar o vigia que já acabou. */
	deliveryWatchId?: string | null;
};

export interface Purchases {
	/** Grava a compra do dono. O mesmo pedido duas vezes devolve o existente (`duplicate`), com o que faltava acrescentado (rastreio, link, número). `timeZone` define o "dia" da chave. */
	record(userId: string, runId: string, purchase: PurchaseInput, options?: { timeZone?: string }): Promise<RecordedPurchase>;
	/** Liga a compra ao vigia de entrega da agenda. */
	attachDeliveryWatch(userId: string, purchaseId: string, watchId: string): Promise<void>;
	/** Uma compra do dono. `null` = não existe ou é de outro dono (a tool responde igual). */
	get(userId: string, purchaseId: string): Promise<(PurchaseView & { deliveryWatchId?: string | null }) | null>;
	/** Troca os dados da compra (já validados e mesclados pela tool). `null` = não existe ou é de outro dono. Lança se colidir com outra compra. */
	update(userId: string, purchaseId: string, purchase: PurchaseInput, options?: { timeZone?: string }): Promise<PurchaseView | null>;
	/** Apaga a compra. Devolve o vigia de entrega que estava ligado a ela. `null` = não existe ou é de outro dono. */
	remove(userId: string, purchaseId: string): Promise<{ deliveryWatchId: string | null } | null>;
	/** Mostra (e grava na conversa) o cartão `purchase`. */
	show(userId: string, runId: string, purchase: PurchaseView): Promise<void>;
	list(userId: string, options?: { limit?: number }): Promise<PurchaseView[]>;
}

export type ShoppingPorts = { pages: ProductPages; cards: ProductCards; purchases: Purchases };
