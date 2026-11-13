/**
 * Agenda do agente como a tela a vê (Motor v4, F4.4): a mesma linha de `BotFollowup`, sem o que é interno (permissão
 * decidida na criação, ids de run e de conversa, memo do bot, contadores de freio). Funções puras, sem I/O: a rota
 * monta a visão e a tela escreve as frases no idioma dela (texto de produto não mora aqui).
 */
import type { AgendaEventFilter, AgendaKind, AgendaOutcome, AgendaStatus } from "./agenda.js";

export const AGENDA_ACTIONS = ["pause", "resume", "cancel"] as const;
export type AgendaAction = (typeof AGENDA_ACTIONS)[number];

/** Por que um item acabou, em termos que a tela sabe explicar. `other` = motivo que a tela não conhece. */
export const AGENDA_END_REASONS = ["owner", "completed", "done", "expired", "max_runs", "ignored_notices", "no_result", "unavailable", "reminder_note", "other"] as const;
export type AgendaEndReasonView = (typeof AGENDA_END_REASONS)[number];

/** Tamanho máximo da última novidade que sobe para a tela (o texto completo já está na conversa). */
export const AGENDA_VIEW_MESSAGE_MAX_CHARS = 280;

/** O que a visão precisa de um item (estrutural: o `AgendaItemRecord` do db cabe aqui sem `shared` conhecer o db). */
export type AgendaViewSource = {
	id: string;
	botId: string;
	kind: AgendaKind;
	status: AgendaStatus;
	note: string;
	dueAt: Date;
	intervalMinutes: number | null;
	untilAt: Date | null;
	maxRuns: number | null;
	runCount: number;
	eventFilter: AgendaEventFilter | null;
	lastResult: { outcome: AgendaOutcome | "missing"; at: string; message?: string } | null;
	endReason: string | null;
	createdAt: Date;
};

export type AgendaLastUpdateView = {
	/** `update` e `done` trouxeram algo; `no_change` = o bot conferiu e nada mudou. */
	outcome: "update" | "done" | "no_change";
	at: string;
	message: string | null;
};

export type AgendaItemView = {
	id: string;
	botId: string;
	/** `remind` lembrete · `watch` vigia · `intent` espera um evento · `brief` resumo. A tela traduz em palavras. */
	kind: AgendaKind;
	status: AgendaStatus;
	/** O que o dono pediu, com as palavras da conversa. */
	note: string;
	/** Próxima vez (ISO). `null` quando encerrado ou quando o item espera um evento em vez de um horário. */
	nextAt: string | null;
	intervalMinutes: number | null;
	/** Até quando vale (ISO). */
	untilAt: string | null;
	/** Só para quem espera e-mail: remetente, trecho do assunto, exige anexo. */
	event: { from?: string; subjectContains?: string; hasAttachment?: boolean } | null;
	endReason: AgendaEndReasonView | null;
	runCount: number;
	maxRuns: number | null;
	lastUpdate: AgendaLastUpdateView | null;
	createdAt: string;
};

export type AgendaListResponse = {
	/** O motor v4 está ligado para esta conta? Sem isso a seção nem aparece. */
	enabled: boolean;
	/** Fuso do dono (IANA), para escrever "amanhã às 10:00" como ele vive o dia. */
	timezone: string;
	items: AgendaItemView[];
	/** Itens que já acabaram (mais recentes primeiro, poucos). */
	ended: AgendaItemView[];
};

export type AgendaChangeResponse = { item: AgendaItemView };

function endReasonView(reason: string | null): AgendaEndReasonView | null {
	if (reason === null) return null;
	return (AGENDA_END_REASONS as readonly string[]).includes(reason) ? (reason as AgendaEndReasonView) : "other";
}

function lastUpdateView(result: AgendaViewSource["lastResult"]): AgendaLastUpdateView | null {
	if (!result || result.outcome === "missing") return null;
	const text = result.message?.trim() ?? "";
	const message = text.length === 0 ? null : text.length > AGENDA_VIEW_MESSAGE_MAX_CHARS ? `${text.slice(0, AGENDA_VIEW_MESSAGE_MAX_CHARS - 1).trimEnd()}…` : text;
	return { outcome: result.outcome, at: result.at, message };
}

/** Visão de um item para a tela. Item encerrado não tem próxima vez; item por evento tem vigência, não horário. */
export function toAgendaItemView(item: AgendaViewSource): AgendaItemView {
	const active = item.status === "pending" || item.status === "paused";
	const filter = item.eventFilter;
	return {
		id: item.id,
		botId: item.botId,
		kind: item.kind,
		status: item.status,
		note: item.note,
		nextAt: active && item.kind !== "intent" ? item.dueAt.toISOString() : null,
		intervalMinutes: item.intervalMinutes,
		untilAt: item.untilAt ? item.untilAt.toISOString() : null,
		event: filter
			? {
					...(filter.from !== undefined && { from: filter.from }),
					...(filter.subjectContains !== undefined && { subjectContains: filter.subjectContains }),
					...(filter.hasAttachment !== undefined && { hasAttachment: filter.hasAttachment }),
				}
			: null,
		endReason: active ? null : endReasonView(item.endReason),
		runCount: item.runCount,
		maxRuns: item.maxRuns,
		lastUpdate: lastUpdateView(item.lastResult),
		createdAt: item.createdAt.toISOString(),
	};
}

/** Corpo de `POST /v1/agenda/:id` (estrito: campo desconhecido é erro). */
export function parseAgendaChangeBody(raw: unknown): { ok: true; action: AgendaAction } | { ok: false; error: string } {
	const accepted = `Expected { "action": ${AGENDA_ACTIONS.map((a) => `"${a}"`).join(" | ")} }.`;
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ok: false, error: `Body must be an object. ${accepted}` };
	const record = raw as Record<string, unknown>;
	const extra = Object.keys(record).filter((key) => key !== "action");
	if (extra.length > 0) return { ok: false, error: `Unknown field(s): ${extra.join(", ")}. ${accepted}` };
	const action = record.action;
	if (!(AGENDA_ACTIONS as readonly unknown[]).includes(action)) return { ok: false, error: accepted };
	return { ok: true, action: action as AgendaAction };
}
