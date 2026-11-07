// Pagamento do v4 no worker (F6.2, F6.3, F6.4): cofre de cartões do dono, `card_fill` sobre a porta `Sandbox` e o mandato.
// Tudo escopado pelo `userId` do RUN (40-seguranca). Número e CVV só existem dentro do `card_fill`; as tools e o modelo
// veem bandeira e final.
import { createCardFill, createCardVaultAdapter, type CheckoutDeps, type CvvEscrow, type Sandbox } from "@workspace/agent";
import { getPurchaseMandate, getSavedCardMeta, getSavedCardSealed, listSavedCards, lowerPurchaseMandateUses } from "@workspace/db";
import { openCardSecretsJson } from "@workspace/agent-runtime";
import type { Mandate } from "@workspace/shared";

export type V4PaymentDeps = {
	listCards: typeof listSavedCards;
	getMeta: typeof getSavedCardMeta;
	getSealed: typeof getSavedCardSealed;
	openJson(sealed: string): string;
	getMandate: typeof getPurchaseMandate;
	lowerUses: typeof lowerPurchaseMandateUses;
};

export const realV4PaymentDeps: V4PaymentDeps = { listCards: listSavedCards, getMeta: getSavedCardMeta, getSealed: getSavedCardSealed, openJson: (sealed) => openCardSecretsJson(sealed), getMandate: getPurchaseMandate, lowerUses: lowerPurchaseMandateUses };

export type V4Payment = {
	/** Ausente quando o dono não tem cartão salvo ou o canal do CVV não existe: a capacidade de pagamento nem é oferecida. */
	checkout?: CheckoutDeps;
	/** Mandato vivo do dono (F6.4), só para run com o dono presente. */
	mandate?: Mandate;
	onMandateSpent: (usesLeft: number) => Promise<void>;
};

export async function createV4Payment(input: { userId: string; escrow: CvvEscrow | null | undefined; sandbox: Sandbox; ownerPresent: boolean; now?: () => Date; deps?: V4PaymentDeps; log?: (message: string) => void }): Promise<V4Payment> {
	const deps = input.deps ?? realV4PaymentDeps;
	const onMandateSpent = async (usesLeft: number) => {
		await deps.lowerUses(input.userId, usesLeft).catch(() => input.log?.("[engine-v4] não consegui gravar o uso do mandato"));
	};
	// Sem dono na conversa não há quem aprove ou digite o CVV: dinheiro nem é oferecido (a política já esconde).
	if (!input.ownerPresent) return { onMandateSpent };
	try {
		const [cards, row] = await Promise.all([deps.listCards(input.userId), deps.getMandate(input.userId)]);
		const mandate: Mandate | undefined = row && row.usesLeft > 0 && row.until.getTime() > (input.now ?? (() => new Date()))().getTime() ? { maxAmount: row.maxAmount, currency: row.currency, merchants: row.merchants, until: row.until.toISOString(), usesLeft: row.usesLeft } : undefined;
		if (!input.escrow || cards.length === 0) return { ...(mandate && { mandate }), onMandateSpent };
		const vault = createCardVaultAdapter({
			meta: async (userId, cardId) => {
				const meta = await deps.getMeta(userId, cardId);
				return meta ? { id: meta.id, brand: meta.brand, last4: meta.last4, label: meta.label } : null;
			},
			sealed: async (userId, cardId) => (await deps.getSealed(userId, cardId))?.secretsEnc ?? null,
			open: (sealed) => deps.openJson(sealed),
		});
		const fill = createCardFill({ vault, escrow: input.escrow, sandbox: input.sandbox });
		return { checkout: { cards: cards.map((c) => ({ id: c.id, brand: c.brand, last4: c.last4, label: c.label })), fill }, ...(mandate && { mandate }), onMandateSpent };
	} catch {
		// Falha ao ler o cofre não derruba o run: segue sem pagamento (e o log não leva dado de cartão).
		input.log?.("[engine-v4] pagamento indisponível: falha ao ler cartões do dono; o run segue sem ele");
		return { onMandateSpent };
	}
}
