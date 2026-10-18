import {
	parseConversationCard,
	type PersistedRoutineProposalCard,
	type RoutineProposalMode,
	type RoutineProposalSpec,
	type RoutineProposalStatus,
} from "@workspace/shared";
import type { Message } from "@/components/ui/templates/template-4/data";

export type RoutineProposalMessage = Extract<Message, { kind: "routine-proposal" }>;

/** Card persistido `routine-proposal` → mensagem da thread. O id da mensagem é o que a API usa no clique. */
export function routineProposalMessageFromCard(id: string, card: PersistedRoutineProposalCard): RoutineProposalMessage {
	return {
		id,
		kind: "routine-proposal",
		proposalId: card.proposalId,
		mode: card.mode,
		status: card.status,
		spec: card.spec,
		...(card.routineId ? { routineId: card.routineId } : {}),
	};
}

export function routineProposalMessageFromContent(id: string, content: string): RoutineProposalMessage | null {
	const card = parseConversationCard(content);
	return card?.kind === "routine-proposal" ? routineProposalMessageFromCard(id, card) : null;
}

export type RoutineProposalChange = "applying" | { status: RoutineProposalStatus } | { error: string };

/** Troca o estado do card (por id da mensagem): aplicando, decidido ou erro. O resto da thread fica igual. */
export function setRoutineProposalState(messages: Message[], id: string, change: RoutineProposalChange): Message[] {
	return messages.map((item) => {
		if (item.kind !== "routine-proposal" || item.id !== id) return item;
		if (change === "applying") return { ...item, isApplying: true, error: null };
		if ("error" in change) return { ...item, isApplying: false, error: change.error };
		return { ...item, status: change.status, isApplying: false, error: null };
	});
}

export type ProposalView = {
	title: string;
	description: string;
	badge: { tone: "pending" | "success" | "danger" | "muted"; label: string };
	confirmLabel: string;
	cancelLabel: string;
	resolved: boolean;
	note?: string;
};

function clip(text: string, max: number): string {
	const clean = text.replace(/\s+/g, " ").trim();
	return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/** Textos do card por modo e estado (Sugerir: Criar / Agora não; Automático: Manter / Desfazer). */
export function proposalView(input: {
	mode: RoutineProposalMode;
	status: RoutineProposalStatus;
	spec: Pick<RoutineProposalSpec, "name" | "prompt">;
	schedule: string;
}): ProposalView {
	const name = `“${input.spec.name}”`;
	const description = clip(input.spec.prompt, 160);
	if (input.mode === "suggest") {
		if (input.status === "pending") {
			return {
				title: `Quer que eu faça ${name} ${input.schedule}?`,
				description,
				badge: { tone: "pending", label: "Sugestão" },
				confirmLabel: "Criar",
				cancelLabel: "Agora não",
				resolved: false,
			};
		}
		return input.status === "accepted"
			? {
					title: `Rotina criada: ${name}`,
					description,
					badge: { tone: "success", label: "Criada" },
					confirmLabel: "Criar",
					cancelLabel: "Agora não",
					resolved: true,
					note: `Roda ${input.schedule}.`,
				}
			: {
					title: `Sugestão dispensada: ${name}`,
					description,
					badge: { tone: "muted", label: "Agora não" },
					confirmLabel: "Criar",
					cancelLabel: "Agora não",
					resolved: true,
				};
	}
	if (input.status === "pending") {
		return {
			title: `Criei a rotina ${name} — manter?`,
			description: `Roda ${input.schedule}. ${description}`,
			badge: { tone: "pending", label: "Nova rotina" },
			confirmLabel: "Manter",
			cancelLabel: "Desfazer",
			resolved: false,
		};
	}
	return input.status === "accepted"
		? {
				title: `Rotina mantida: ${name}`,
				description,
				badge: { tone: "success", label: "Mantida" },
				confirmLabel: "Manter",
				cancelLabel: "Desfazer",
				resolved: true,
				note: `Roda ${input.schedule}.`,
			}
		: {
				title: `Rotina desfeita: ${name}`,
				description,
				badge: { tone: "muted", label: "Desfeita" },
				confirmLabel: "Manter",
				cancelLabel: "Desfazer",
				resolved: true,
				note: "A rotina foi removida.",
			};
}

/** Mensagens persistidas novas (outro processo escreveu: reflexão, lembrete) entram na thread sem mexer no resto. */
export function mergeExternalMessages(previous: Message[], refreshed: readonly Message[]): Message[] {
	const known = new Set(previous.map((message) => message.id));
	let next = previous;
	for (const item of refreshed) {
		if (known.has(item.id)) continue;
		if (item.kind !== "assistant" && item.kind !== "routine-proposal") continue;
		known.add(item.id);
		const at = item.createdAt ? next.findIndex((message) => message.createdAt !== undefined && message.createdAt > item.createdAt!) : -1;
		next = at >= 0 ? [...next.slice(0, at), item, ...next.slice(at)] : [...next, item];
	}
	return next;
}

/** Estado novo de um card já na thread vindo do servidor (ex.: decidido em outra aba). */
export function mergeProposalStatuses(previous: Message[], refreshed: readonly Message[]): Message[] {
	let next = previous;
	for (const item of refreshed) {
		if (item.kind !== "routine-proposal") continue;
		const index = next.findIndex((message) => message.id === item.id);
		const current = index >= 0 ? next[index] : undefined;
		if (!current || current.kind !== "routine-proposal" || current.status === item.status || current.isApplying) continue;
		next = next.map((message, position) => (position === index ? { ...current, status: item.status, routineId: item.routineId ?? current.routineId } : message));
	}
	return next;
}
