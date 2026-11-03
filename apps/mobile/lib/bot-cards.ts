// Cartões de proposta com gate humano no fio: "Criar agente" (`bot-proposal`) e "Atualizar perfil" (`bot-profile`).
// Funções puras (testadas em bot-cards.test.ts): do que o servidor grava ou emite ao que a tela desenha, a regra
// "o decidido vence" entre ao vivo e gravado (a do `collapseBotProposalCards` do web), as frases de erro e os textos.
import { modelDisplayName, type BotProfileCardField, type BotProposalEvent, parseBotProposal, type PersistedBotProposalCard, type PersistedConversationCard } from "@workspace/shared";
import type { ChatItem, ProposalStatus } from "./chat-types";
import type { HomeBot } from "./home-types";

export type BotProposalItem = Extract<ChatItem, { kind: "bot-proposal" }>;
export type BotProfileItem = Extract<ChatItem, { kind: "bot-profile" }>;
type PersistedProfile = Extract<PersistedConversationCard, { kind: "bot-profile" }>;

export function botProposalToItem(id: string, card: PersistedBotProposalCard, createdAt?: string): BotProposalItem {
	return {
		id,
		...(createdAt ? { createdAt } : {}),
		kind: "bot-proposal",
		proposalId: card.proposalId,
		status: card.status,
		name: card.name,
		description: card.description,
		color: card.color,
		shape: card.shape,
		model: card.model,
		skills: card.skills,
		firstTask: card.firstTask,
		...(card.botId ? { botId: card.botId } : {}),
	};
}

/** Evento SSE `bot-proposal`: o mesmo formato do gravado, com id estável por proposta (o evento repetido não duplica). */
export function botProposalFromEvent(event: BotProposalEvent): BotProposalItem | null {
	const { type: _type, ...data } = event;
	const parsed = parseBotProposal(data);
	return parsed ? botProposalToItem(`bot-proposal-${parsed.proposalId}`, { v: 1, kind: "bot-proposal", ...parsed }) : null;
}

export function botProfileToItem(id: string, card: PersistedProfile, createdAt?: string): BotProfileItem {
	return { id, ...(createdAt ? { createdAt } : {}), kind: "bot-profile", proposalId: card.proposalId, botId: card.botId, status: card.status, fields: card.fields, before: card.before, after: card.after };
}

/** Identidade da proposta entre ao vivo e gravado (`bot-proposal|<proposalId>` do `cardDedupeKey` do web). */
export const proposalKey = (item: { kind: "bot-proposal" | "bot-profile"; proposalId: string }): string => `${item.kind}|${item.proposalId}`;

/**
 * "O decidido vence": se alguma cópia da proposta (gravada ou ao vivo) já foi decidida e outra ainda está pendente,
 * a pendente passa a mostrar o estado decidido (e o `botId` do bot criado). Quem fica na lista é a primeira cópia (a
 * gravada); o resto some pelo `dedupeKeys`.
 */
export function applyDecidedProposals(items: readonly ChatItem[]): ChatItem[] {
	const decided = new Map<string, { status: ProposalStatus; botId?: string }>();
	for (const item of items) {
		if ((item.kind !== "bot-proposal" && item.kind !== "bot-profile") || item.status === "pending") continue;
		const key = proposalKey(item);
		const known = decided.get(key);
		const botId = item.kind === "bot-proposal" ? item.botId : undefined;
		// Aprovado vale mais que recusado; entre dois iguais, o que traz o `botId`.
		if (!known || (known.status === "rejected" && item.status === "approved") || (!known.botId && botId)) {
			const keep = botId ?? known?.botId;
			decided.set(key, { status: item.status, ...(keep ? { botId: keep } : {}) });
		}
	}
	if (decided.size === 0) return [...items];
	return items.map((item) => {
		if ((item.kind !== "bot-proposal" && item.kind !== "bot-profile") || item.status !== "pending") return item;
		const found = decided.get(proposalKey(item));
		if (!found) return item;
		return item.kind === "bot-proposal" ? { ...item, status: found.status, ...(found.botId ? { botId: found.botId } : {}) } : { ...item, status: found.status };
	});
}

// ---- resolução local (o toque vale antes de o servidor gravar) ------------------------------------------------------

export type CardResolution = { phase: "applying" } | { phase: "error"; text: string; /** A proposta não aceita mais decisão (404/409): os botões ficam desligados. */ locked?: boolean } | { phase: "done"; status: Exclude<ProposalStatus, "pending">; botId?: string; name?: string };

/** Aplica o que o toque já fez ao cartão ainda pendente: carregando, erro ou o resultado (antes do gravado chegar). */
export function withProposalResolution(item: ChatItem, resolutions: Readonly<Record<string, CardResolution>>): ChatItem {
	if (item.kind !== "bot-proposal" && item.kind !== "bot-profile") return item;
	const resolution = resolutions[proposalKey(item)];
	if (!resolution || item.status !== "pending") return item;
	if (resolution.phase === "applying") return { ...item, applying: true };
	if (resolution.phase === "error") return { ...item, error: resolution.text, ...(resolution.locked ? { locked: true } : {}) };
	if (item.kind === "bot-proposal") return { ...item, status: resolution.status, ...(resolution.botId ? { botId: resolution.botId } : {}), ...(resolution.name ? { name: resolution.name } : {}) };
	return { ...item, status: resolution.status };
}

// ---- textos dos cartões ------------------------------------------------------------------------------------------

/**
 * Modelo para o usuário: só o nome de exibição (do catálogo, quando o app o tiver); o id interno nunca aparece. Sem
 * modelo (padrão da conta) ou sem nome conhecido, `null` e a linha some.
 */
export function proposalModelLabel(model: string | null, names: Readonly<Record<string, string>> = {}): string | null {
	if (!model) return null;
	const name = names[model]?.trim();
	return name ? modelDisplayName(name, model) : null;
}

/** Habilidade para o usuário: o slug sem hífens, com a primeira letra maiúscula ("daily-report" → "Daily report"). */
export function skillLabel(slug: string): string {
	const text = slug.replace(/-/g, " ").trim();
	return text ? text.charAt(0).toUpperCase() + text.slice(1) : slug;
}

/** Primeira tarefa resumida: uma linha de até `max` letras, com reticências. */
export function summarizeTask(text: string, max = 140): string {
	const line = text.replace(/\s+/g, " ").trim();
	return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

export function botProposalTitle(item: BotProposalItem): string {
	if (item.status === "approved") return `Agente criado: “${item.name}”`;
	if (item.status === "rejected") return `Proposta dispensada: “${item.name}”`;
	return `Criar o agente “${item.name}”?`;
}

const PROFILE_LABELS: Record<BotProfileCardField, string> = { description: "Briefing", snippet: "Resumo", openRouterModel: "Modelo", name: "Nome" };
const display = (value: string | null | undefined): string => (typeof value === "string" && value.trim() ? value.trim() : "—");

export type ProfileRow = { field: BotProfileCardField; label: string; before: string; after: string };

/** Linhas de antes/depois do perfil, na ordem dos campos da proposta. */
export function profileRows(item: BotProfileItem): ProfileRow[] {
	// Modelo: o id interno não aparece (o app não tem catálogo de nomes); só se diz que muda.
	return item.fields.map((field) =>
		field === "openRouterModel"
			? { field, label: PROFILE_LABELS[field], before: item.before.openRouterModel ? "Modelo atual" : "Modelo padrão", after: item.after.openRouterModel ? "Novo modelo" : "Modelo padrão" }
			: { field, label: PROFILE_LABELS[field], before: display(item.before[field]), after: display(item.after[field]) },
	);
}

export function botProfileTitle(item: BotProfileItem): string {
	if (item.status === "approved") return "Perfil atualizado";
	if (item.status === "rejected") return "Mudança dispensada";
	return item.fields.length === 1 ? `Atualizar ${PROFILE_LABELS[item.fields[0]!].toLowerCase()}?` : "Atualizar perfil?";
}

/** O bot recém-criado como a home desenha: nome devolvido pelo servidor, aparência da proposta, ainda sem conversa gravada. */
export function homeBotFromProposal(item: BotProposalItem, result: { botId: string; name: string }, now: Date = new Date()): HomeBot {
	return {
		id: result.botId,
		name: result.name,
		color: item.color,
		shape: item.shape,
		pinned: false,
		pinOrder: null,
		sectionId: null,
		memberIds: [],
		isPrimary: false,
		conversationId: null,
		language: null,
		unread: false,
		lastAt: now.toISOString(),
		preview: "",
		previewSent: false,
	};
}
