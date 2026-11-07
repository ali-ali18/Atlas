// Capacidade lazy com o `checkout` (F6.3). Id próprio até a frente P juntar `product_search` e `record_purchase`:
// depois do merge basta mover `createCheckoutTool(deps)` para a lista de tools da capacidade `shopping`.
import { defineCapability } from "../define-capability.js";
import { type CheckoutDeps, createCheckoutTool } from "./checkout.js";

export function createCheckoutCapability(deps: CheckoutDeps) {
	return defineCapability({
		id: "checkout",
		title: "Pagamento",
		summary: "Pay a prepared cart with a saved card; the owner confirms and types the card code.",
		tools: [createCheckoutTool(deps)],
		instructions: "Before checkout: the cart must be on the store's payment page and the owner must have agreed on items, total and shipping. After it: the owner may be asked to finish a bank verification; wait for them, then check the order page.",
	});
}
