// `purchase_update` e `purchase_delete` (F6.5, auditoria F6): corrigir ou apagar uma compra gravada, inclusive uma gravada
// por engano ou por injeção. Escopo do dono do RUN (compra alheia = "not found", igual a inexistente). Como `record_purchase`,
// pedem confirmação quando o run leu conteúdo de fora (`when_untrusted`).
import { PURCHASE_ITEMS_MAX, formatMoney, normalizePurchaseInput } from "@workspace/shared";
import { z } from "zod";
import type { Agenda } from "../../ports/agenda.js";
import type { Purchases } from "../../ports/shopping.js";
import { defineTool } from "../../tools/define-tool.js";

const NOT_FOUND = "Purchase not found. Hint: use purchase_list to see the owner's purchases and their ids.";

export function createPurchaseUpdateTool(deps: { purchases: Purchases; agenda?: Agenda }) {
	return defineTool({
		name: "purchase_update",
		description:
			"Fix a saved purchase: order number, tracking code, tracking link, total paid or the items. Only the fields you send change; the rest stays. " +
			"Use it when the owner corrects something or the store gave a tracking code later. Do not use it to save a new purchase (record_purchase) or to remove one (purchase_delete).",
		inputSchema: z.object({
			purchaseId: z.string().trim().min(1).max(160).describe("Id from purchase_list or from the purchase card."),
			orderNumber: z.string().trim().min(1).max(80).optional(),
			trackingCode: z.string().trim().min(1).max(80).optional(),
			trackingUrl: z.string().trim().min(1).max(2000).optional().describe("Public http(s) tracking link."),
			total: z.number().min(0).optional().describe("What was paid in total, shipping included."),
			items: z.array(z.object({ name: z.string().trim().min(1).max(300), quantity: z.number().int().min(1).max(999).optional(), unitPrice: z.number().min(0).optional() })).min(1).max(PURCHASE_ITEMS_MAX).optional().describe("The full list of items (replaces the saved one)."),
		}),
		effect: "write_internal",
		confirm: "when_untrusted",
		riskFacts: () => ({ target: "Compras" }),
		async execute({ purchaseId, ...patch }, ctx) {
			const current = await deps.purchases.get(ctx.ownerId, purchaseId);
			if (!current) throw new Error(NOT_FOUND);
			const changed = Object.entries(patch).filter(([, v]) => v !== undefined).map(([k]) => k);
			if (changed.length === 0) throw new Error("Nothing to change. Hint: send at least one of orderNumber, trackingCode, trackingUrl, total, items.");
			// Mescla sobre o que está salvo e revalida tudo com a mesma regra da gravação.
			const { id: _id, botId: _bot, createdAt: _created, ...saved } = current;
			void _id;
			void _bot;
			void _created;
			const { deliveryWatchId: _watch, ...fields } = saved as typeof saved & { deliveryWatchId?: string | null };
			void _watch;
			const merged = { ...fields, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) };
			const parsed = normalizePurchaseInput(merged, new Date(ctx.ports.clock.now()));
			if (!parsed.ok) throw new Error(`${parsed.error} Hint: fix that field and call again.`);
			const timeZone = deps.agenda ? (await deps.agenda.settings(ctx.ownerId).catch(() => undefined))?.timezone : undefined;
			const updated = await deps.purchases.update(ctx.ownerId, purchaseId, parsed.value, timeZone ? { timeZone } : undefined);
			if (!updated) throw new Error(NOT_FOUND);
			await deps.purchases.show(ctx.ownerId, ctx.runId, updated);
			return {
				ok: true,
				summary: `Updated purchase ${updated.id} (${changed.join(", ")}): ${updated.merchant}, ${formatMoney(updated.total, updated.currency)}. A card was shown.`,
				receipt: { what: `Purchase updated: ${updated.merchant}`, where: "Purchases", externalId: updated.id },
			};
		},
	});
}

export function createPurchaseDeleteTool(deps: { purchases: Purchases; agenda?: Agenda }) {
	return defineTool({
		name: "purchase_delete",
		description:
			"Delete a saved purchase and stop its delivery follow-up. Use it when the owner says a purchase was recorded by mistake or asks to remove it. " +
			"Do not use it to fix a detail (purchase_update). It does not cancel an order with the store.",
		inputSchema: z.object({ purchaseId: z.string().trim().min(1).max(160).describe("Id from purchase_list or from the purchase card.") }),
		effect: "write_internal",
		confirm: "when_untrusted",
		riskFacts: () => ({ target: "Compras" }),
		async execute({ purchaseId }, ctx) {
			const current = await deps.purchases.get(ctx.ownerId, purchaseId);
			if (!current) throw new Error(NOT_FOUND);
			const removed = await deps.purchases.remove(ctx.ownerId, purchaseId);
			if (!removed) throw new Error(NOT_FOUND);
			let follow = "It had no delivery follow-up.";
			if (removed.deliveryWatchId) {
				const stopped = deps.agenda ? await deps.agenda.change(ctx.ownerId, removed.deliveryWatchId, "cancel").catch(() => null) : null;
				follow = stopped ? "Its delivery follow-up was stopped." : "Its delivery follow-up was already over or could not be stopped.";
			}
			return {
				ok: true,
				summary: `Deleted purchase ${purchaseId} (${current.merchant}, ${formatMoney(current.total, current.currency)}). ${follow}`,
				receipt: { what: `Purchase deleted: ${current.merchant}`, where: "Purchases", externalId: purchaseId },
			};
		},
	});
}
