import type { BudgetContinueData, BudgetContinueEvent, BudgetContinueStatus } from "@workspace/shared";
import type { Message } from "@/components/ui/templates/template-4/data";

export type BudgetContinueMessage = Extract<Message, { kind: "budget-continue" }>;

/** Evento SSE `budget-continue` -> dados do card (status ausente = pendente). */
export function budgetContinueFromEvent(event: BudgetContinueEvent): BudgetContinueData {
	const { type: _type, status, ...rest } = event;
	return { ...rest, status: status ?? "pending" };
}

/** Card ao vivo: id estável por oferta, para o evento recebido de novo não duplicar. */
export function budgetContinueMessageFromEvent(event: BudgetContinueEvent): BudgetContinueMessage {
	return { id: `budget-continue-${event.offerId}`, kind: "budget-continue", offer: budgetContinueFromEvent(event) };
}

export type BudgetContinueChange = "applying" | { status: BudgetContinueStatus; continuationRunId?: string | null; error?: string } | { error: string };

/** Troca o estado de uma oferta (por `offerId`); o resto da thread fica igual. */
export function setBudgetContinueState(messages: Message[], offerId: string, change: BudgetContinueChange): Message[] {
	return messages.map((item) => {
		if (item.kind !== "budget-continue" || item.offer.offerId !== offerId) return item;
		if (change === "applying") return { ...item, isApplying: true, error: null };
		if (!("status" in change)) return { ...item, isApplying: false, error: change.error };
		return {
			...item,
			isApplying: false,
			error: change.error ?? null,
			offer: { ...item.offer, status: change.status, ...(change.continuationRunId ? { continuationRunId: change.continuationRunId } : {}) },
		};
	});
}

/**
 * O card ao vivo (id `budget-continue-<offerId>`) e o persistido (id do banco) da mesma oferta viram um só:
 * fica o persistido, com o estado mais decidido dos dois.
 */
export function collapseBudgetContinueCards(messages: Message[]): Message[] {
	const groups = new Map<string, BudgetContinueMessage[]>();
	for (const message of messages) {
		if (message.kind !== "budget-continue") continue;
		groups.set(message.offer.offerId, [...(groups.get(message.offer.offerId) ?? []), message]);
	}
	if ([...groups.values()].every((cards) => cards.length === 1)) return messages;
	return messages.flatMap((message): Message[] => {
		if (message.kind !== "budget-continue") return [message];
		const cards = groups.get(message.offer.offerId) ?? [message];
		if (cards.length === 1) return [message];
		const keeper = cards.find((card) => card.id !== `budget-continue-${card.offer.offerId}`) ?? cards[0];
		if (message !== keeper || !keeper) return [];
		const decided = cards.find((card) => card.offer.status !== "pending");
		return [decided && keeper.offer.status === "pending" ? { ...keeper, offer: { ...keeper.offer, status: decided.offer.status, ...(decided.offer.continuationRunId ? { continuationRunId: decided.offer.continuationRunId } : {}) } } : keeper];
	});
}
