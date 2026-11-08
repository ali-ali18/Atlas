// Tool `checkout` (F6.3): paga um carrinho já montado com o cartão salvo do dono. Efeito `money`: SEMPRE cartão de
// aprovação (com mandato, o cartão vira "só o campo do CVV"). A tool NUNCA vê o número do cartão nem o CVV: ela entrega
// o pedido à porta `CardFill`, que junta cofre + CVV do canal efêmero e preenche o formulário da loja na VM.
import { cardDisplayName, normalizeMerchant } from "@workspace/shared";
import { z } from "zod";
import type { CardFill, CardInfo } from "../../ports/payment.js";
import { defineTool } from "../../tools/define-tool.js";

const MAX_ITEMS = 30;

export const checkoutInputSchema = z.object({
	store: z.string().trim().min(1).max(120).describe("Store name as the owner knows it."),
	items: z
		.array(z.strictObject({ name: z.string().trim().min(1).max(160), quantity: z.number().int().min(1).max(999), price: z.number().min(0).max(10_000_000).optional() }))
		.min(1)
		.max(MAX_ITEMS)
		.describe("What is in the cart."),
	total: z.number().positive().max(10_000_000).describe("Final amount charged, shipping included."),
	shipping: z.number().min(0).max(10_000_000).describe("Shipping included in total (0 if free)."),
	discount: z.number().min(0).max(10_000_000).optional().describe("Coupon or discount already taken off the total, in the same currency. Omit when there is none."),
	currency: z.string().trim().length(3).describe("ISO 4217 code, e.g. BRL."),
	checkoutUrl: z.string().url().max(2000).describe("https URL of the store's checkout (payment) page, with the cart already filled."),
	cardId: z.string().trim().min(1).max(100).describe("Id of one of the owner's saved cards (listed in this tool's description)."),
});
export type CheckoutArgs = z.output<typeof checkoutInputSchema>;

/**
 * Loja pelo domínio da URL de pagamento (é o que o mandato compara; o modelo não escolhe). `null` se não é https válido.
 * Usa a MESMA normalização que grava a loja do mandato (`normalizeMerchant`, em shared).
 */
export function merchantOf(checkoutUrl: string): string | null {
	try {
		if (new URL(checkoutUrl).protocol !== "https:") return null;
	} catch {
		return null;
	}
	return normalizeMerchant(checkoutUrl);
}

const cents = (value: number): number => Math.round(value * 100);

/**
 * Menor total possível do carrinho: itens com preço × quantidade (item sem preço não entra) + frete - desconto (cupom,
 * informado e mostrado ao dono no cartão de aprovação). Nunca abaixo de zero. O `total` é o que
 * o dono aprova e o que o mandato compara; um total abaixo disso é conta errada ou tentativa de passar por um teto.
 */
export function minimumTotal(args: Pick<CheckoutArgs, "items" | "shipping" | "discount">): number {
	const itemCents = args.items.reduce((sum, item) => sum + (item.price !== undefined ? cents(item.price) * item.quantity : 0), 0);
	return Math.max(0, itemCents + cents(args.shipping) - cents(args.discount ?? 0)) / 100;
}

export type CheckoutDeps = {
	/** Cartões do dono (só id, bandeira e final) lidos ao montar o run. Sem cartão, a tool não é oferecida. */
	cards: readonly CardInfo[];
	fill: CardFill;
};

const money = (value: number, currency: string): string => `${value.toFixed(2)} ${currency.toUpperCase()}`;

export function createCheckoutTool(deps: CheckoutDeps) {
	const cardById = new Map(deps.cards.map((card) => [card.id, card]));
	const cardList = deps.cards.map((card) => `${card.id} = ${cardDisplayName(card.brand as never, card.last4)}`).join("; ");
	return defineTool({
		name: "checkout",
		description:
			"Pay a cart with one of the owner's saved cards. The owner always confirms on a card and types the card's security code themselves; you never see card numbers or codes. " +
			"Use only after the owner chose what to buy and the cart is on the store's payment page. Do not use to search, compare or just add to a cart. " +
			"total is what the store will charge; if a coupon lowers it below items plus shipping, send the coupon amount as discount so the owner sees it. " +
			`Saved cards: ${cardList || "none"}.`,
		inputSchema: checkoutInputSchema,
		effect: "money",
		ownerInput: "card_cvv",
		// O motivo da recusa e a referência do pedido vêm da loja/banco (texto de terceiro): dado, nunca instrução. O
		// resultado contamina o run antes de voltar ao modelo (efeito seguinte, como o vigia de entrega, sai marcado).
		trust: "untrusted",
		source: "web",
		riskFacts: (args) => {
			const card = cardById.get(args.cardId);
			const merchant = merchantOf(args.checkoutUrl);
			return {
				amount: args.total,
				currency: args.currency.toUpperCase(),
				// Sem loja válida o mandato não casa (fail-closed): a loja é o domínio, nunca o nome que o modelo deu.
				...(merchant && { merchant }),
				target: merchant ?? args.store,
				irreversible: true,
				shipping: args.shipping,
				...(args.discount !== undefined && args.discount > 0 && { discount: args.discount }),
				items: args.items.map((item) => `${item.quantity}× ${item.name}${item.price !== undefined ? ` · ${money(item.price, args.currency)}` : ""}`),
				...(card && { card: cardDisplayName(card.brand as never, card.last4) }),
			};
		},
		async execute(args, ctx) {
			const merchant = merchantOf(args.checkoutUrl);
			if (!merchant) return { ok: false, error: "checkoutUrl must be an https address without credentials.", hint: "Send the store's payment page URL (https)." };
			const floor = minimumTotal(args);
			if (cents(args.total) < cents(floor)) {
				return { ok: false, error: `The total (${money(args.total, args.currency)}) is lower than the items plus shipping (${money(floor, args.currency)}), so nothing was paid.`, hint: "Read the final amount from the store's payment page and send it as total, shipping included." };
			}
			const card = cardById.get(args.cardId);
			if (!card) return { ok: false, error: "That saved card is not available.", hint: `Use one of: ${cardList || "none (the owner has no saved card)"}.` };
			if (!ctx.approvalId) return { ok: false, error: "The purchase was not confirmed by the owner, so nothing was paid.", hint: "Ask the owner to confirm the purchase again." };
			const result = await deps.fill.fill({ userId: ctx.ownerId, runId: ctx.runId, approvalId: ctx.approvalId, cardId: card.id, merchant, checkoutUrl: args.checkoutUrl, amount: args.total, currency: args.currency.toUpperCase() }, ctx.signal);
			const label = cardDisplayName(card.brand as never, card.last4);
			const what = `${money(args.total, args.currency)} at ${args.store} with ${label}`;
			switch (result.status) {
				case "paid":
					return { ok: true, summary: `Payment submitted: ${what}.${result.orderRef ? ` Order reference: ${result.orderRef}.` : ""} Check the store's confirmation before telling the owner it is done.`, receipt: { what: `Purchase: ${what}`, where: merchant, ...(result.orderRef && { externalId: result.orderRef }) } };
				case "challenge":
					return { ok: true, summary: `The store opened a verification step (${result.kind}) for ${what}. The owner must finish it in the computer's browser; the purchase is not confirmed yet.`, receipt: { what: `Purchase started, waiting for the owner's verification: ${what}`, where: merchant }, park: "handoff" };
				case "no_cvv":
					return { ok: false, error: "The card's security code did not arrive (it expires a few minutes after the owner types it), so nothing was paid.", hint: "Tell the owner plainly and ask them to confirm the purchase again. Do not retry on your own." };
				case "no_card":
					return { ok: false, error: "The saved card was not found for this owner.", hint: "Ask the owner to check their saved cards." };
				case "unavailable":
					return { ok: false, error: `The computer (browser) could not be used: ${result.reason}`, hint: "Nothing was paid. Tell the owner and offer the store link so they can pay themselves." };
				case "declined":
					return { ok: false, error: `The store or bank declined the payment: ${result.reason}`, hint: "Nothing was charged. Offer another card or another store." };
				case "failed":
					return { ok: false, error: `The payment could not be completed: ${result.reason}`, hint: "It may or may not have gone through. Check the store's order page before trying again." };
			}
		},
	});
}
