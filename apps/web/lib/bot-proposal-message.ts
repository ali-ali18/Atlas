import type { BotProposalData, BotProposalEvent, BotProposalStatus } from "@workspace/shared";
import type { Message } from "@/components/ui/templates/template-4/data";

export type BotProposalMessage = Extract<Message, { kind: "bot-proposal" }>;

/** Evento SSE `bot-proposal` -> dados do card (status ausente = pendente). */
export function botProposalFromEvent(event: BotProposalEvent): BotProposalData {
	const { type: _type, status, ...rest } = event;
	return { ...rest, status: status ?? "pending" };
}

/** Card ao vivo: id estável por proposta, para o evento recebido de novo não duplicar. */
export function botProposalMessageFromEvent(event: BotProposalEvent): BotProposalMessage {
	return { id: `bot-proposal-${event.proposalId}`, kind: "bot-proposal", proposal: botProposalFromEvent(event) };
}

export type BotProposalChange =
	| "applying"
	| { status: BotProposalStatus; botId?: string | null; name?: string; description?: string }
	| { error: string };

/** Troca o estado de uma proposta (por `proposalId`); o resto da thread fica igual. */
export function setBotProposalState(messages: Message[], proposalId: string, change: BotProposalChange): Message[] {
	return messages.map((item) => {
		if (item.kind !== "bot-proposal" || item.proposal.proposalId !== proposalId) return item;
		if (change === "applying") return { ...item, isApplying: true, error: null };
		if ("error" in change) return { ...item, isApplying: false, error: change.error };
		return {
			...item,
			isApplying: false,
			error: null,
			proposal: {
				...item.proposal,
				status: change.status,
				...(change.name ? { name: change.name } : {}),
				...(change.description ? { description: change.description } : {}),
				...(change.botId ? { botId: change.botId } : {}),
			},
		};
	});
}

/**
 * O card ao vivo (id `bot-proposal-<proposalId>`) e o persistido (id do banco) da
 * mesma proposta viram um só: fica o persistido, com o estado mais decidido dos dois.
 */
export function collapseBotProposalCards(messages: Message[]): Message[] {
	const groups = new Map<string, BotProposalMessage[]>();
	for (const message of messages) {
		if (message.kind !== "bot-proposal") continue;
		groups.set(message.proposal.proposalId, [...(groups.get(message.proposal.proposalId) ?? []), message]);
	}
	if ([...groups.values()].every((cards) => cards.length === 1)) return messages;
	return messages.flatMap((message): Message[] => {
		if (message.kind !== "bot-proposal") return [message];
		const cards = groups.get(message.proposal.proposalId) ?? [message];
		if (cards.length === 1) return [message];
		const keeper = cards.find((card) => card.id !== `bot-proposal-${card.proposal.proposalId}`) ?? cards[0];
		if (message !== keeper || !keeper) return [];
		const decided = cards.find((card) => card.proposal.status !== "pending");
		return [decided && keeper.proposal.status === "pending" ? { ...keeper, proposal: { ...keeper.proposal, status: decided.proposal.status, botId: decided.proposal.botId ?? keeper.proposal.botId } } : keeper];
	});
}
