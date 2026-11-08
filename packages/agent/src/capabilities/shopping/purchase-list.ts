// `purchase_list` (F6.5): leitura das compras do dono. É dado PRIVADO do dono (`privateData`): entra na trifeta da
// cláusula 8, então uma tool que sai para terceiros depois de ler compras, num run contaminado, pede aprovação.
import { formatMoney } from "@workspace/shared";
import { z } from "zod";
import type { Purchases } from "../../ports/shopping.js";
import { defineTool } from "../../tools/define-tool.js";

export function createPurchaseListTool(purchases: Purchases) {
	return defineTool({
		name: "purchase_list",
		description: "List the owner's recorded purchases, newest first (store, items, total, order number, tracking). Use it when the owner asks what they bought, or before recording one to avoid a duplicate. Do not use it to search products (product_search).",
		inputSchema: z.object({ limit: z.number().int().min(1).max(50).optional() }),
		effect: "read",
		privateData: true,
		ownerData: "purchase",
		async execute({ limit }, ctx) {
			const list = await purchases.list(ctx.ownerId, { limit: limit ?? 20 });
			if (list.length === 0) return { ok: true, summary: "No purchases recorded yet." };
			const lines = list.map((p) => `- ${p.id} | ${p.purchasedAt.slice(0, 10)} | ${p.merchant} | ${formatMoney(p.total, p.currency)} | ${p.items.map((i) => `${i.quantity}x ${i.name}`).join(", ")}${p.orderNumber ? ` | order ${p.orderNumber}` : ""}${p.trackingCode ? ` | tracking ${p.trackingCode}` : ""}`);
			return { ok: true, summary: `${list.length} purchase${list.length === 1 ? "" : "s"}:\n${lines.join("\n")}` };
		},
	});
}
