// Capacidade lazy `shopping` (F6): ler produto/preço de lojas e registrar a compra do dono. Uma tool por arquivo.
// A FRENTE C (cartão, checkout, CVV, mandato) estende SEM editar as tools daqui: passa `extraTools` (ex.: `checkout`) e,
// se precisar, `extraInstructions`; o resto da capacidade (id, resumo, cards) fica igual.
import type { Agenda } from "../../ports/agenda.js";
import type { SearchPort } from "../../ports/search.js";
import type { ShoppingPorts } from "../../ports/shopping.js";
import type { Tool } from "../../tools/define-tool.js";
import { defineCapability } from "../define-capability.js";
import { createProductSearchTool } from "./product-search.js";
import { createPurchaseListTool } from "./purchase-list.js";
import { createRecordPurchaseTool } from "./record-purchase.js";

export * from "./product-search.js";
export * from "./purchase-list.js";
export * from "./record-purchase.js";


export type ShoppingDeps = ShoppingPorts & {
	search: SearchPort;
	/** Sem a agenda, a compra é gravada mas o vigia de entrega não nasce (a tool diz). */
	agenda?: Agenda;
	/** Tools da frente C (checkout…), anexadas à mesma capacidade. */
	extraTools?: readonly Tool[];
	extraInstructions?: string;
};

export const SHOPPING_INSTRUCTIONS =
	"Shopping rules: compare stores by the TOTAL (price + shipping) and say when shipping is not informed; never add zero for it. " +
	"The product card already shows photos, price and link, so answer in one or two plain sentences with your pick and why. Say what you could not find instead of guessing. " +
	"After a purchase is done, record_purchase saves it and starts the delivery follow-up by itself: do not announce the follow-up and do not create a watch for it. " +
	"Say \"store\", \"order\" and \"delivery\" to the owner, never tool or field names.";

export function createShoppingCapability(deps: ShoppingDeps) {
	return defineCapability({
		id: "shopping",
		title: "Compras",
		summary: "Find and compare products with price, shipping and total; save purchases and follow their delivery.",
		tools: [createProductSearchTool(deps), createRecordPurchaseTool(deps), createPurchaseListTool(deps.purchases), ...(deps.extraTools ?? [])],
		instructions: deps.extraInstructions ? `${SHOPPING_INSTRUCTIONS} ${deps.extraInstructions}` : SHOPPING_INSTRUCTIONS,
		cards: ["product", "purchase"],
	});
}
