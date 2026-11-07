/**
 * Fatos do cartão de COMPRA tirados do evento `approval_request` do `checkout` (F6.3). Função pura: valida o que veio
 * (`riskFacts` é tipado pelo motor, mas o cliente não confia em formato) e devolve só o que o cartão mostra.
 * Nunca há número do cartão aqui: o motor só manda bandeira e final.
 */
import type { ApprovalRequestEvent } from "@workspace/shared";

export type PurchaseFacts = {
	/** Domínio da loja (o motor deriva da URL de pagamento). */
	store: string;
	items: string[];
	amount: number;
	currency: string;
	shipping: number | null;
	/** "Visa final 1111". */
	card: string | null;
};

export type PurchaseRequest = {
	requestId: string;
	runId: string;
	facts: PurchaseFacts;
	/** Mandato vale: o cartão não pede "confirmar", só o campo do CVV. */
	inputOnly: boolean;
};

const isString = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 300;

/** `null` se o evento não é um pedido de compra (outra tool, sem campo de CVV) ou vem malformado. */
export function purchaseRequestFromEvent(event: ApprovalRequestEvent): PurchaseRequest | null {
	if (event.ownerInput !== "card_cvv" || !event.runId) return null;
	const f = event.riskFacts;
	const amount = typeof f.amount === "number" && Number.isFinite(f.amount) && f.amount >= 0 ? f.amount : null;
	const currency = isString(f.currency) && f.currency.length === 3 ? f.currency.toUpperCase() : null;
	const store = isString(f.merchant) ? f.merchant : isString(f.target) ? f.target : null;
	if (amount === null || currency === null || store === null) return null;
	const items = Array.isArray(f.items) ? f.items.filter(isString).slice(0, 30) : [];
	return {
		requestId: event.requestId,
		runId: event.runId,
		inputOnly: event.inputOnly === true,
		facts: { store, items, amount, currency, shipping: typeof f.shipping === "number" && Number.isFinite(f.shipping) ? f.shipping : null, card: isString(f.card) ? f.card : null },
	};
}

export function formatMoney(amount: number, currency: string, locale: string): string {
	try {
		return new Intl.NumberFormat(locale, { style: "currency", currency }).format(amount);
	} catch {
		return `${amount.toFixed(2)} ${currency}`;
	}
}
