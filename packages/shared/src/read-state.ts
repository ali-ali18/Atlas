/**
 * Estado de leitura por conversa (sincroniza entre dispositivos) e origem
 * automatizada das mensagens (rotina, lembrete, GitHub). Funções puras.
 */

export type ReadStateRow = { lastReadAt: Date; manualUnread: boolean; lastReadMessageId?: string | null };
export type UnreadCandidate = { id: string; role: string; createdAt: Date };

export type ConversationUnread = {
	unreadCount: number;
	firstUnreadMessageId: string | null;
	manualUnread: boolean;
};

export const EMPTY_UNREAD: ConversationUnread = { unreadCount: 0, firstUnreadMessageId: null, manualUnread: false };

/** Só fala do assistente (inclui rotina, run em background e membros de grupo) conta como não lida. */
export function isUnreadCandidate(message: { role: string }): boolean {
	return message.role === "assistant";
}

/**
 * Sem linha de leitura: conversa criada antes da migration (legado sem linha) conta como lida (agora);
 * conversa criada depois nasce com tudo não lido (lida só até a criação). `migratedAt` = quando a migration rodou.
 */
export function initialLastReadAt(conversationCreatedAt: Date, now: Date, migratedAt: Date | null): Date {
	return migratedAt && conversationCreatedAt.getTime() < migratedAt.getTime() ? now : conversationCreatedAt;
}

/** Contagem de não lidas depois de `lastReadAt`; `manualUnread` vale mesmo com zero mensagens novas. */
export function computeUnread(messages: UnreadCandidate[], read: ReadStateRow | null): ConversationUnread {
	if (!read) return EMPTY_UNREAD;
	const fresh = messages
		.filter((m) => isUnreadCandidate(m) && m.createdAt.getTime() > read.lastReadAt.getTime())
		.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : 1));
	return {
		unreadCount: fresh.length,
		firstUnreadMessageId: fresh[0]?.id ?? null,
		manualUnread: read.manualUnread,
	};
}

/** Há algo a mostrar na bolinha de notificação? */
export function hasUnread(state: Partial<ConversationUnread> | null | undefined): boolean {
	return (state?.unreadCount ?? 0) > 0 || state?.manualUnread === true;
}

/** Ler nunca anda para trás: o novo ponto é o maior entre o atual e o pedido. */
export function advanceLastReadAt(current: Date, requested: Date): Date {
	return requested.getTime() > current.getTime() ? requested : current;
}

export type MessageSourceKind = "routine" | "reminder" | "github" | "webhook" | "reflection";
export type MessageSource = { kind: MessageSourceKind; label: string; at: string };

export function isMessageSourceKind(value: unknown): value is MessageSourceKind {
	return value === "routine" || value === "reminder" || value === "github" || value === "webhook" || value === "reflection";
}

const SOURCE_LABEL_MAX = 80;
const oneLine = (value: string, max = SOURCE_LABEL_MAX): string => {
	const text = value.split("\n").join(" ").split("\t").join(" ").split(" ").filter(Boolean).join(" ");
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

/** Resumo curto do evento GitHub/webhook para o marcador ("PR #12 em org/repo"). */
export function eventSourceLabel(event: unknown): { kind: "github" | "webhook"; label: string } | null {
	if (typeof event !== "object" || event === null) return null;
	const env = event as { provider?: unknown; type?: unknown; refs?: Record<string, unknown>; payload?: unknown };
	if (env.provider === "github") {
		const payload = (typeof env.payload === "object" && env.payload !== null ? env.payload : {}) as {
			type?: unknown;
			repo?: unknown;
			pr?: { number?: unknown };
			ci?: unknown;
		};
		const repo = typeof payload.repo === "string" ? payload.repo : typeof env.refs?.repo === "string" ? env.refs.repo : "";
		const type = typeof payload.type === "string" ? payload.type : typeof env.type === "string" ? env.type : "evento";
		const where = repo ? ` em ${repo}` : "";
		if (typeof payload.pr?.number === "number") return { kind: "github", label: oneLine(`PR #${payload.pr.number}${where}`) };
		if (payload.ci) return { kind: "github", label: oneLine(`CI${where}`) };
		return { kind: "github", label: oneLine(`${type.split("_").join(" ")}${where}`) };
	}
	return { kind: "webhook", label: oneLine(typeof env.type === "string" ? env.type : "evento recebido") };
}

export type SourceInputs = {
	runOrigin: string | null | undefined;
	runCreatedAt: Date;
	routine?: { name: string; triggerType: string } | null;
	routineRun?: { triggeredBy: string; scheduledFor?: Date | null; startedAt?: Date | null; createdAt?: Date | null; eventJson?: unknown } | null;
	followup?: { note: string } | null;
};

/** Origem de uma saída automatizada, ou null para conversa normal. */
export function buildMessageSource(input: SourceInputs): { kind: MessageSourceKind; label: string; at: Date } | null {
	if (input.runOrigin === "proactive") {
		const note = input.followup?.note ? oneLine(input.followup.note) : "";
		return note ? { kind: "reminder", label: note, at: input.runCreatedAt } : null;
	}
	if (input.runOrigin !== "routine" && input.runOrigin !== "webhook") return null;
	const { routine, routineRun } = input;
	if (!routine) return null;
	const at = routineRun?.scheduledFor ?? routineRun?.startedAt ?? routineRun?.createdAt ?? input.runCreatedAt;
	if (routineRun?.triggeredBy === "event") {
		const event = eventSourceLabel(routineRun.eventJson);
		if (event) return { ...event, at };
	}
	if (routine.triggerType === "once") return { kind: "reminder", label: oneLine(routine.name), at };
	return { kind: "routine", label: oneLine(routine.name), at };
}

const SOURCE_TITLE: Record<MessageSourceKind, string> = {
	routine: "Rotina",
	reminder: "Lembrete",
	github: "GitHub",
	webhook: "Webhook",
	reflection: "Reflexão",
};

export function sourceKindTitle(kind: MessageSourceKind): string {
	return SOURCE_TITLE[kind];
}

/** HH:MM no fuso informado (ou o do ambiente). */
export function formatSourceTime(iso: string, timeZone?: string): string {
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return "";
	return new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit", hour12: false, ...(timeZone ? { timeZone } : {}) }).format(date);
}

/** "Rotina · Resumo da agenda · 20:00" */
export function formatSourceMarker(source: MessageSource, timeZone?: string): string {
	const time = formatSourceTime(source.at, timeZone);
	return [sourceKindTitle(source.kind), source.label, time].filter(Boolean).join(" · ");
}

/** Prévia da lista: "Rotina: Resumo da agenda". */
export function sourcePreviewPrefix(source: Pick<MessageSource, "kind" | "label"> | null | undefined): string {
	return source ? `${sourceKindTitle(source.kind)}: ${source.label}` : "";
}
