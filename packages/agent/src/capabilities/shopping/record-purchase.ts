// `record_purchase` (F6.5): guarda a compra do dono e, em SILÊNCIO, cria o vigia de entrega na agenda.
//
// Efeito `write_internal`, sem `confirm`: é um registro no próprio caderno de compras do dono (nenhum dinheiro se move,
// nada sai do Atlas), o cartão `purchase` mostra o que foi gravado e o dono apaga/ajusta pelo chat. Pedir confirmação
// depois de um checkout já aprovado seria ruído (o run está contaminado pela página da loja). O risco real de um registro
// falso por injeção é pequeno e coberto por dois freios: o vigia nasce marcado `untrustedRead` quando o run leu conteúdo
// de fora (a nota entra como DADO no wake), e a agenda tem teto de itens e de intervalo.
import { PURCHASE_DELIVERY_WATCH_DAYS, deliveryWatchNote, normalizePurchaseInput, PURCHASE_ITEMS_MAX, PURCHASE_DELIVERY_WATCH_MINUTES, planAgendaItem, formatMoney } from "@workspace/shared";
import { z } from "zod";
import type { Agenda } from "../../ports/agenda.js";
import type { Purchases } from "../../ports/shopping.js";
import { defineTool } from "../../tools/define-tool.js";
import type { ToolContext } from "../../tools/types.js";

/** Cria o vigia de entrega. Falha NÃO desfaz a compra: devolve o motivo para o resumo ser honesto. */
export async function trackDelivery(agenda: Agenda, ownerId: string, purchase: Parameters<typeof deliveryWatchNote>[0], ctx: Pick<ToolContext, "runId" | "untrustedReadInRun"> & { now: Date }): Promise<{ ok: true; id: string; duplicate: boolean } | { ok: false; error: string }> {
	const settings = await agenda.settings(ownerId);
	const planned = planAgendaItem({
		request: { kind: "watch", note: deliveryWatchNote(purchase), everyMinutes: PURCHASE_DELIVERY_WATCH_MINUTES, until: new Date(ctx.now.getTime() + PURCHASE_DELIVERY_WATCH_DAYS * 86_400_000).toISOString() },
		now: ctx.now,
		settings,
	});
	if (!planned.ok) return { ok: false, error: planned.error };
	const created = await agenda.create(ownerId, planned.plan, { sourceRunId: ctx.runId, untrustedRead: ctx.untrustedReadInRun === true });
	return created.ok ? { ok: true, id: created.item.id, duplicate: created.duplicate } : { ok: false, error: created.error };
}

export function createRecordPurchaseTool(deps: { purchases: Purchases; agenda?: Agenda }) {
	return defineTool({
		name: "record_purchase",
		description:
			"Save a purchase the owner made (store, items, total paid with shipping, currency, date, order number, tracking when known) and show its card. It also starts a quiet delivery follow-up on its own. " +
			"Use it right after a purchase is done or when the owner says they bought something. Do not use it for a price they are only considering (product_search) or to pay (checkout). Never invent an order number or tracking code: leave it out. " +
			"Set followDelivery false for digital goods, services or in-store pickup. Do not announce the follow-up.",
		inputSchema: z.object({
			merchant: z.string().trim().min(1).max(200),
			items: z.array(z.object({ name: z.string().trim().min(1).max(300), quantity: z.number().int().min(1).max(999).optional(), unitPrice: z.number().min(0).optional() })).min(1).max(PURCHASE_ITEMS_MAX),
			total: z.number().min(0).describe("What was paid in total, shipping included."),
			currency: z.string().trim().length(3).describe("3-letter code, e.g. BRL."),
			purchasedAt: z.string().trim().min(1).max(40).optional().describe("ISO 8601. Default: now."),
			orderNumber: z.string().trim().min(1).max(80).optional(),
			trackingCode: z.string().trim().min(1).max(80).optional(),
			trackingUrl: z.string().trim().min(1).max(2000).optional().describe("Public http(s) tracking link."),
			followDelivery: z.boolean().optional().describe("Default true. false for digital goods, services or pickup."),
		}),
		effect: "write_internal",
		riskFacts: ({ merchant, total, currency }) => ({ merchant, amount: total, currency: currency.toUpperCase(), target: "Compras" }),
		async execute({ followDelivery, ...raw }, ctx) {
			const now = ctx.ports.clock.now();
			const parsed = normalizePurchaseInput(raw, now);
			if (!parsed.ok) throw new Error(`${parsed.error} Hint: fix that field and call again.`);
			const recorded = await deps.purchases.record(ctx.ownerId, ctx.runId, parsed.value);
			const { purchase } = recorded;
			let follow = "No delivery follow-up was created (not requested).";
			if (followDelivery !== false && !recorded.duplicate) {
				if (!deps.agenda) follow = "No delivery follow-up was created (agenda unavailable).";
				else {
					try {
						const tracked = await trackDelivery(deps.agenda, ctx.ownerId, purchase, { runId: ctx.runId, untrustedReadInRun: ctx.untrustedReadInRun, now });
						if (tracked.ok) {
							await deps.purchases.attachDeliveryWatch(ctx.ownerId, purchase.id, tracked.id);
							follow = `A quiet delivery follow-up is on the agenda (${tracked.id}); the owner is told only when there is news. Do not announce it.`;
						} else follow = `The purchase is saved, but the delivery follow-up could not be created: ${tracked.error}`;
					} catch (error) {
						follow = `The purchase is saved, but the delivery follow-up failed: ${error instanceof Error ? error.message : "unknown error"}`;
					}
				}
			} else if (recorded.duplicate) follow = "This order was already saved; nothing new was created.";
			await deps.purchases.show(ctx.ownerId, ctx.runId, purchase);
			return {
				ok: true,
				summary: `${recorded.duplicate ? "Already saved" : "Saved"} purchase ${purchase.id}: ${purchase.merchant}, ${formatMoney(purchase.total, purchase.currency)}${purchase.orderNumber ? `, order ${purchase.orderNumber}` : ""}. A card was shown. ${follow}`,
				receipt: { what: `${recorded.duplicate ? "Compra já registrada" : "Compra registrada"}: ${purchase.merchant}`, where: "Compras", externalId: purchase.id },
			};
		},
	});
}
