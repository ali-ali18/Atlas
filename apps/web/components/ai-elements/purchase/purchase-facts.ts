/** Fatos do cartão de COMPRA: a leitura do evento mora em `@workspace/shared` (web e celular usam a mesma). */
export { purchaseRequestFromEvent, type PurchaseFacts, type PurchaseRequest } from "@workspace/shared";
import { AtlasApiError } from "@/lib/atlas-api";

export function formatMoney(amount: number, currency: string, locale: string): string {
	try {
		return new Intl.NumberFormat(locale, { style: "currency", currency }).format(amount);
	} catch {
		return `${amount.toFixed(2)} ${currency}`;
	}
}

/** Chave de texto do erro ao enviar a aprovação: 400 `cvv_required` é o campo do código, 503 é canal indisponível. */
export function purchaseSendErrorKey(cause: unknown): "payments.purchase.cvvInvalid" | "payments.purchase.errorUnavailable" | "payments.purchase.errorSend" {
	if (!(cause instanceof AtlasApiError)) return "payments.purchase.errorSend";
	if (cause.status === 503) return "payments.purchase.errorUnavailable";
	const code = (cause.details as { error?: unknown } | undefined)?.error;
	if (cause.status === 400 && (cause.message === "cvv_required" || code === "cvv_required")) return "payments.purchase.cvvInvalid";
	return "payments.purchase.errorSend";
}
