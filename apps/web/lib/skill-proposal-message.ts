import {
	parseSkillProposalCard,
	type SkillProposalData,
	type SkillProposalEvent,
	type SkillProposalStatus,
} from "@workspace/shared";
import type { Message } from "@/components/ui/templates/template-4/data";

export type SkillProposalMessage = Extract<Message, { kind: "skill-proposal" }>;

/** Evento SSE `skill-proposal` → dados do card (status ausente = pendente). */
export function skillProposalFromEvent(event: SkillProposalEvent): SkillProposalData {
	const { type: _type, status, ...rest } = event;
	return { ...rest, status: status ?? "pending" };
}

/** Card ao vivo: id estável por proposta, para o recebido de novo não duplicar. */
export function skillProposalMessageFromEvent(event: SkillProposalEvent): SkillProposalMessage {
	return {
		id: `skill-proposal-${event.proposalId}`,
		kind: "skill-proposal",
		proposal: skillProposalFromEvent(event),
	};
}

/** Role persistido `skill-proposal` (JSON do card) → mensagem da thread; `null` se inválido. */
export function skillProposalMessageFromCard(id: string, content: string): SkillProposalMessage | null {
	const card = parseSkillProposalCard(content);
	if (!card) return null;
	const { v: _v, kind: _kind, ...proposal } = card;
	return { id, kind: "skill-proposal", proposal };
}

/** Troca o estado de uma proposta (por `proposalId`) e limpa o erro; o resto da thread fica igual. */
export function setSkillProposalStatus(
	messages: Message[],
	proposalId: string,
	status: SkillProposalStatus,
	opts: { isApplying?: boolean; error?: string | null } = {},
): Message[] {
	return messages.map((item) =>
		item.kind === "skill-proposal" && item.proposal.proposalId === proposalId
			? {
					...item,
					proposal: { ...item.proposal, status },
					isApplying: opts.isApplying ?? false,
					error: opts.error ?? null,
				}
			: item,
	);
}

/** Marca a proposta como "aplicando" (botões travados) sem mudar o estado nem o erro anterior. */
export function setSkillProposalApplying(messages: Message[], proposalId: string, isApplying: boolean): Message[] {
	return messages.map((item) =>
		item.kind === "skill-proposal" && item.proposal.proposalId === proposalId
			? { ...item, isApplying, ...(isApplying ? { error: null } : {}) }
			: item,
	);
}

export function setSkillProposalError(messages: Message[], proposalId: string, error: string): Message[] {
	return messages.map((item) =>
		item.kind === "skill-proposal" && item.proposal.proposalId === proposalId
			? { ...item, isApplying: false, error }
			: item,
	);
}

/**
 * O card ao vivo (id `skill-proposal-<proposalId>`) e o persistido (id do banco)
 * da mesma proposta viram um só: fica o persistido, na posição dele, com o estado
 * mais decidido dos dois (aprovada/recusada vence pendente).
 */
export function collapseSkillProposalCards(messages: Message[]): Message[] {
	const groups = new Map<string, SkillProposalMessage[]>();
	for (const message of messages) {
		if (message.kind !== "skill-proposal") continue;
		const key = message.proposal.proposalId;
		groups.set(key, [...(groups.get(key) ?? []), message]);
	}
	if ([...groups.values()].every((cards) => cards.length === 1)) return messages;
	return messages.flatMap((message): Message[] => {
		if (message.kind !== "skill-proposal") return [message];
		const cards = groups.get(message.proposal.proposalId) ?? [message];
		if (cards.length === 1) return [message];
		const keeper = cards.find((card) => card.id !== `skill-proposal-${card.proposal.proposalId}`) ?? cards[0];
		if (message !== keeper || !keeper) return [];
		const decided = cards.find((card) => card.proposal.status !== "pending");
		return [decided && keeper.proposal.status === "pending" ? { ...keeper, proposal: { ...keeper.proposal, status: decided.proposal.status } } : keeper];
	});
}
