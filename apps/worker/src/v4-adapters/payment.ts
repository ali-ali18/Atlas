// Pagamento do v4 no worker (F6.2, F6.3, F6.4): cofre de cartões do dono, `card_fill` sobre a porta `Sandbox` e o mandato.
// Tudo escopado pelo `userId` do RUN (40-seguranca). Número e CVV só existem dentro do `card_fill`; as tools e o modelo
// veem bandeira e final.
import { createCardFill, createCardVaultAdapter, type CheckoutDeps, type CvvEscrow, type Sandbox } from "@workspace/agent";
import { getPurchaseMandate, getSavedCardMeta, getSavedCardSealed, listSavedCards, consumePurchaseMandateUse, restorePurchaseMandateUse } from "@workspace/db";
import { openCardSecretsJson } from "@workspace/agent-runtime";
import type { Mandate } from "@workspace/shared";

export type V4PaymentDeps = {
	listCards: typeof listSavedCards;
	getMeta: typeof getSavedCardMeta;
	getSealed: typeof getSavedCardSealed;
	openJson(sealed: string): string;
	getMandate: typeof getPurchaseMandate;
	consumeUse: typeof consumePurchaseMandateUse;
	restoreUse: typeof restorePurchaseMandateUse;
};

export const realV4PaymentDeps: V4PaymentDeps = { listCards: listSavedCards, getMeta: getSavedCardMeta, getSealed: getSavedCardSealed, openJson: (sealed) => openCardSecretsJson(sealed), getMandate: getPurchaseMandate, consumeUse: consumePurchaseMandateUse, restoreUse: restorePurchaseMandateUse };

export type V4Payment = {
	/** Ausente quando o dono não tem cartão salvo ou o canal do CVV não existe: a capacidade de pagamento nem é oferecida. */
	checkout?: CheckoutDeps;
	/** Mandato vivo do dono (F6.4), só para run com o dono presente. */
	mandate?: Mandate;
	/** Gasto atômico do uso do mandato no banco (o executor o chama antes de pagar e devolve se a compra falhar sem pagar). */
	mandateUses: { claim(): Promise<boolean>; release(): Promise<void> };
};

export async function createV4Payment(input: { userId: string; escrow: CvvEscrow | null | undefined; sandbox: Sandbox; ownerPresent: boolean; now?: () => Date; deps?: V4PaymentDeps; log?: (message: string) => void }): Promise<V4Payment> {
	const deps = input.deps ?? realV4PaymentDeps;
	const now = input.now ?? (() => new Date());
	const mandateUses = {
		// Falha do banco = sem uso (fail-closed): a compra cai no cartão completo, nunca roda sem o uso gravado.
		claim: () => deps.consumeUse(input.userId, now()).catch(() => (input.log?.("[engine-v4] não consegui gastar o uso do mandato"), false)),
		release: () => deps.restoreUse(input.userId).catch(() => input.log?.("[engine-v4] não consegui devolver o uso do mandato")),
	};
	// Sem dono na conversa não há quem aprove ou digite o CVV: dinheiro nem é oferecido (a política já esconde).
	if (!input.ownerPresent) return { mandateUses };
	try {
		const [cards, row] = await Promise.all([deps.listCards(input.userId), deps.getMandate(input.userId)]);
		const mandate: Mandate | undefined = row && row.usesLeft > 0 && row.until.getTime() > now().getTime() ? { maxAmount: row.maxAmount, currency: row.currency, merchants: row.merchants, until: row.until.toISOString(), usesLeft: row.usesLeft } : undefined;
		if (!input.escrow || cards.length === 0) return { ...(mandate && { mandate }), mandateUses };
		const vault = createCardVaultAdapter({
			meta: async (userId, cardId) => {
				const meta = await deps.getMeta(userId, cardId);
				return meta ? { id: meta.id, brand: meta.brand, last4: meta.last4, label: meta.label } : null;
			},
			sealed: async (userId, cardId) => (await deps.getSealed(userId, cardId))?.secretsEnc ?? null,
			open: (sealed) => deps.openJson(sealed),
		});
		const fill = createCardFill({ vault, escrow: input.escrow, sandbox: input.sandbox });
		return { checkout: { cards: cards.map((c) => ({ id: c.id, brand: c.brand, last4: c.last4, label: c.label })), fill }, ...(mandate && { mandate }), mandateUses };
	} catch {
		// Falha ao ler o cofre não derruba o run: segue sem pagamento (e o log não leva dado de cartão).
		input.log?.("[engine-v4] pagamento indisponível: falha ao ler cartões do dono; o run segue sem ele");
		return { mandateUses };
	}
}
