// Ciclo de vida da oferta (F1.9, 03 §2.1). Uma tarefa vive dentro de um turno: o kernel nunca injeta
// estado de tarefa de outro run. Atravessar turnos é explícito, e uma oferta de continuar só existe
// como cartão `ask_owner`, com estado: answered | dismissed | ignored (| open enquanto espera).
//  - `ignored` é ESTRUTURAL: o dono mandou outra mensagem sem tocar no cartão.
//  - dispensada ou ignorada vai para `declinedOffers` e o modelo recebe um aviso como dado.
import { escapeReserved } from "../channels/index.js";
import type { ConversationState, OfferRecord } from "../ports/store.js";

export type CardResponse = { cardId: string; response: "answered" | "dismissed" };

export const emptyConversation = (): ConversationState => ({ offers: [], declinedOffers: [] });

const MAX_OFFERS = 50;

/** Fecha as ofertas abertas conforme o que aconteceu antes deste run. Puro. */
export function settleOffers(state: ConversationState, event: { responses: readonly CardResponse[]; ownerSpoke: boolean }): ConversationState {
	const declined = new Set(state.declinedOffers);
	const offers = state.offers.map((offer): OfferRecord => {
		if (offer.state !== "open") return offer;
		const touched = event.responses.find((r) => r.cardId === offer.cardId);
		const next = touched ? touched.response : event.ownerSpoke ? "ignored" : "open";
		if (next === "dismissed" || next === "ignored") declined.add(offer.label);
		return { ...offer, state: next };
	});
	return { offers: offers.slice(-MAX_OFFERS), declinedOffers: [...declined] };
}

export const openOffer = (state: ConversationState, offer: { cardId: string; label: string }): ConversationState => ({
	...state,
	offers: [...state.offers, { ...offer, state: "open" as const }].slice(-MAX_OFFERS),
});

/** Aviso ao modelo (bloco de runtime, em inglês). `undefined` quando não há nada declinado. */
export function declinedOffersNote(declined: readonly string[]): string | undefined {
	if (declined.length === 0) return undefined;
	return declined.map((label) => `You already offered "${escapeReserved(label)}" and the owner declined it. Do not offer it again.`).join("\n");
}
