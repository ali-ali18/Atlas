// Pagamento do v4 no worker (F6.2, F6.3, F6.4): cofre de cartões do dono, `card_fill` sobre a porta `Sandbox` e o mandato.
// Tudo escopado pelo `userId` do RUN (40-seguranca). Número e CVV só existem dentro do `card_fill`; as tools e o modelo
// veem bandeira e final.
import { createHash } from "node:crypto";
import { createCardFill, createCardVaultAdapter, type CheckoutDeps, type CvvEscrow, type PaymentLedger, type Sandbox } from "@workspace/agent";
import { appendAgentJournalEntry, getPurchaseMandate, getSavedCardMeta, getSavedCardSealed, listSavedCards, consumePurchaseMandateUse, restorePurchaseMandateUse, type MandateToken } from "@workspace/db";
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
	/** Journal durável do v4: guarda "pagamento iniciado" por pedido de aprovação (idempotência entre retomadas e processos). */
	appendJournal: typeof appendAgentJournalEntry;
};

/** Chave do pagamento no journal: um pedido de aprovação = um pagamento. */
export const paymentJournalKey = (approvalId: string): string => `pay:${approvalId}`;

/** Livro de pagamentos sobre o journal do db (dono e run vêm do run, nunca do modelo). `started` é o claim; só `failed` reabre. */
export function paymentLedgerFromJournal(append: typeof appendAgentJournalEntry): PaymentLedger {
	const entry = (scope: { userId: string; runId: string; approvalId: string }, outcome: "started" | "succeeded" | "failed") => {
		const idempotencyKey = paymentJournalKey(scope.approvalId);
		return { runId: scope.runId, userId: scope.userId, step: 0, idempotencyKey, toolName: "card_fill", argsHash: createHash("sha256").update(idempotencyKey).digest("hex"), outcome };
	};
	return {
		start: async (scope) => (await append(entry(scope, "started"))).claimed,
		release: async (scope) => void (await append(entry(scope, "failed"))),
		settle: async (scope) => void (await append(entry(scope, "succeeded"))),
	};
}

export const realV4PaymentDeps: V4PaymentDeps = { listCards: listSavedCards, getMeta: getSavedCardMeta, getSealed: getSavedCardSealed, openJson: (sealed) => openCardSecretsJson(sealed), getMandate: getPurchaseMandate, consumeUse: consumePurchaseMandateUse, restoreUse: restorePurchaseMandateUse, appendJournal: appendAgentJournalEntry };

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
	// O mandato que ESTE run viu (id + revisão): gasto e devolução só valem para ele. Se o dono trocar o mandato no meio do run,
	// o gasto falha (a compra volta a pedir confirmação) e a devolução não mexe no mandato novo.
	let token: MandateToken | undefined;
	const mandateUses = {
		// Falha do banco ou sem mandato visto = sem uso (fail-closed): nunca roda sem o uso gravado.
		claim: () => (token ? deps.consumeUse(input.userId, now(), token).catch(() => (input.log?.("[engine-v4] não consegui gastar o uso do mandato"), false)) : Promise.resolve(false)),
		release: () => (token ? deps.restoreUse(input.userId, token).catch(() => input.log?.("[engine-v4] não consegui devolver o uso do mandato")) : Promise.resolve()),
	};
	// Sem dono na conversa não há quem aprove ou digite o CVV: dinheiro nem é oferecido (a política já esconde).
	if (!input.ownerPresent) return { mandateUses };
	try {
		const [cards, row] = await Promise.all([deps.listCards(input.userId), deps.getMandate(input.userId)]);
		if (row) token = { id: row.id, rev: row.rev };
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
		const fill = createCardFill({ vault, escrow: input.escrow, sandbox: input.sandbox, ledger: paymentLedgerFromJournal(deps.appendJournal) });
		return { checkout: { cards: cards.map((c) => ({ id: c.id, brand: c.brand, last4: c.last4, label: c.label })), fill }, ...(mandate && { mandate }), mandateUses };
	} catch {
		// Falha ao ler o cofre não derruba o run: segue sem pagamento (e o log não leva dado de cartão).
		input.log?.("[engine-v4] pagamento indisponível: falha ao ler cartões do dono; o run segue sem ele");
		return { mandateUses };
	}
}
