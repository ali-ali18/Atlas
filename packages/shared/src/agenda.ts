/**
 * Agenda do agente (Motor v4, F4): lembrete, vigia, intenção por evento e brief sobre `BotFollowup`.
 * Funções PURAS (sem I/O): o relógio entra por `now`, o fuso e o horário útil por `ProactiveSettings`.
 *
 * Reaproveita o modo proativo do v2: `resolveFollowupWhen` lê o "quando", `nextAllowedTime` empurra para fora do
 * silêncio e `findDuplicateFollowup`/`normalizeForDedupe` evitam item repetido. "Horário útil" = fora do horário de
 * silêncio do dono (padrão 08:00 a 22:00 no fuso da conta).
 *
 * Nenhuma decisão aqui lê texto livre do dono ou do modelo para decidir comportamento: o filtro de evento compara
 * CAMPOS declarados (remetente, assunto contém, anexo) e os freios usam contadores e datas.
 */
import { nextAllowedTime, normalizeForDedupe, resolveFollowupWhen, type ProactiveSettings } from "./proactive.js";

export const AGENDA_KINDS = ["remind", "watch", "intent", "brief"] as const;
export type AgendaKind = (typeof AGENDA_KINDS)[number];

export const AGENDA_OUTCOMES = ["no_change", "update", "done"] as const;
export type AgendaOutcome = (typeof AGENDA_OUTCOMES)[number];

/** Estado do item na linha (`status`). `paused` só existe na agenda; a varredura do v2 só olha `pending`. */
export type AgendaStatus = "pending" | "paused" | "done" | "cancelled";

export const AGENDA_NOTE_MAX_CHARS = 1000;
export const AGENDA_MEMO_MAX_CHARS = 2000;
export const AGENDA_MESSAGE_MAX_CHARS = 2000;
/** Intervalo mínimo entre execuções, salvo pedido explícito do dono (declarado pelo modelo num campo). */
export const AGENDA_MIN_INTERVAL_MINUTES = 120;
/** Piso absoluto: nem pedido explícito vai abaixo (custo de LLM sem ganho). */
export const AGENDA_FLOOR_INTERVAL_MINUTES = 15;
export const AGENDA_MAX_INTERVAL_MINUTES = 60 * 24 * 30;
/** Itens ativos (pendentes ou pausados) por dono. */
export const AGENDA_MAX_ACTIVE_PER_OWNER = 20;
export const AGENDA_MAX_RUNS_CAP = 500;
export const AGENDA_WATCH_DEFAULT_DAYS = 14;
export const AGENDA_INTENT_DEFAULT_DAYS = 30;
export const AGENDA_MAX_HORIZON_DAYS = 180;
/** A agenda para sozinha depois de tantos avisos seguidos ignorados (freio da Meta; contagem por item). */
export const AGENDA_IGNORED_NOTICE_LIMIT = 2;
/** Execuções seguidas sem `agenda_result` que encerram o item. */
export const AGENDA_MISSING_RESULT_LIMIT = 3;
/** Um item `intent` não acorda de novo antes disto (várias mensagens seguidas viram um run só; o run lê o que chegou). */
export const AGENDA_EVENT_MIN_GAP_MINUTES = 10;

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

// ---------------------------------------------------------------------------
// Filtro estrutural de evento
// ---------------------------------------------------------------------------

export const AGENDA_EVENT_SOURCES = ["email"] as const;
export type AgendaEventSource = (typeof AGENDA_EVENT_SOURCES)[number];

/**
 * Filtro declarado. `from`: endereço completo ("loja@x.com"), domínio ("x.com", vale subdomínio) ou "@x.com".
 * `subjectContains`: trecho LITERAL do assunto (sem padrão). Ao menos um critério; todos os presentes precisam casar.
 */
export type AgendaEventFilter = { source: AgendaEventSource; from?: string; subjectContains?: string; hasAttachment?: boolean };

/** O evento que acorda itens `intent`. Campos já extraídos pela fonte (nunca o corpo da mensagem). */
export type AgendaEvent = { source: AgendaEventSource; from: string; subject: string; hasAttachment: boolean };

const FILTER_FIELD_MAX = 200;

/** Endereço em minúsculas, sem o nome de exibição ("Loja <a@b.com>" vira "a@b.com"). */
function bareAddress(value: string): string {
	const open = value.indexOf("<");
	const close = value.lastIndexOf(">");
	const inner = open >= 0 && close > open ? value.slice(open + 1, close) : value;
	return inner.trim().toLowerCase();
}

function fromMatches(filterFrom: string, eventFrom: string): boolean {
	const wanted = bareAddress(filterFrom);
	const actual = bareAddress(eventFrom);
	if (!wanted || !actual) return false;
	const at = wanted.indexOf("@");
	if (at > 0) return actual === wanted;
	const domain = at === 0 ? wanted.slice(1) : wanted;
	const actualDomain = actual.slice(actual.lastIndexOf("@") + 1);
	return actualDomain === domain || actualDomain.endsWith(`.${domain}`);
}

/** Valida um filtro vindo do modelo ou do banco. Campo desconhecido, vazio ou grande demais = erro com a lista do aceito. */
export function parseAgendaEventFilter(raw: unknown): { ok: true; filter: AgendaEventFilter } | { ok: false; error: string } {
	const accepted = "Accepted fields: source (email), from, subjectContains, hasAttachment; at least one of from, subjectContains, hasAttachment.";
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ok: false, error: `eventFilter must be an object. ${accepted}` };
	const record = raw as Record<string, unknown>;
	const unknown = Object.keys(record).filter((key) => !["source", "from", "subjectContains", "hasAttachment"].includes(key));
	if (unknown.length > 0) return { ok: false, error: `Unknown eventFilter field(s): ${unknown.join(", ")}. ${accepted}` };
	if (!(AGENDA_EVENT_SOURCES as readonly unknown[]).includes(record.source)) return { ok: false, error: `eventFilter.source must be one of: ${AGENDA_EVENT_SOURCES.join(", ")}.` };
	const filter: AgendaEventFilter = { source: record.source as AgendaEventSource };
	for (const key of ["from", "subjectContains"] as const) {
		const value = record[key];
		if (value === undefined) continue;
		if (typeof value !== "string" || value.trim().length === 0 || value.length > FILTER_FIELD_MAX) return { ok: false, error: `eventFilter.${key} must be a non-empty string up to ${FILTER_FIELD_MAX} characters.` };
		filter[key] = value.trim();
	}
	if (record.hasAttachment !== undefined) {
		if (typeof record.hasAttachment !== "boolean") return { ok: false, error: "eventFilter.hasAttachment must be true or false." };
		filter.hasAttachment = record.hasAttachment;
	}
	if (filter.from === undefined && filter.subjectContains === undefined && filter.hasAttachment === undefined) return { ok: false, error: `eventFilter needs at least one criterion. ${accepted}` };
	return { ok: true, filter };
}

/** O evento casa com o filtro? Só compara campos declarados; sem padrão sobre texto livre. */
export function matchEventFilter(filter: AgendaEventFilter, event: AgendaEvent): boolean {
	if (filter.source !== event.source) return false;
	if (filter.from !== undefined && !fromMatches(filter.from, event.from)) return false;
	if (filter.subjectContains !== undefined && !event.subject.toLowerCase().includes(filter.subjectContains.toLowerCase())) return false;
	if (filter.hasAttachment !== undefined && filter.hasAttachment !== event.hasAttachment) return false;
	return true;
}

// ---------------------------------------------------------------------------
// Planejar a criação
// ---------------------------------------------------------------------------

/** O pedido de criação como o modelo o declara (nomes iguais aos das tools). */
export type AgendaRequest = {
	kind: AgendaKind;
	note: string;
	/** Primeira execução: ISO 8601 (sem fuso = fuso do dono) ou "amanhã 9h". */
	when?: string;
	everyMinutes?: number;
	/** O DONO pediu explicitamente um intervalo menor que o mínimo (declarado pelo modelo; nunca deduzido de texto). */
	ownerAskedShortInterval?: boolean;
	/** Quando para de vigiar (mesmo formato de `when`). */
	until?: string;
	maxRuns?: number;
	eventFilter?: unknown;
};

export type AgendaPlan = {
	kind: AgendaKind;
	note: string;
	/** Próxima execução, já fora do silêncio. Em `intent` é o fim da vigência (a varredura de tempo só a expira). */
	dueAt: Date;
	requestedFor: Date;
	intervalMinutes: number | null;
	untilAt: Date | null;
	maxRuns: number | null;
	eventFilter: AgendaEventFilter | null;
	movedForQuietHours: boolean;
	/** Ajustes que o motor fez (inglês curto, para o modelo contar ao dono em palavras simples). */
	adjustments: string[];
};

export type PlanAgendaResult = { ok: true; plan: AgendaPlan } | { ok: false; error: string };

function validateInterval(request: AgendaRequest): { ok: true; minutes: number | null } | { ok: false; error: string } {
	const minutes = request.everyMinutes;
	if (minutes === undefined) return { ok: true, minutes: null };
	if (!Number.isInteger(minutes) || minutes <= 0) return { ok: false, error: "everyMinutes must be a positive whole number of minutes." };
	if (minutes > AGENDA_MAX_INTERVAL_MINUTES) return { ok: false, error: `everyMinutes is at most ${AGENDA_MAX_INTERVAL_MINUTES} (30 days).` };
	if (minutes < AGENDA_FLOOR_INTERVAL_MINUTES) return { ok: false, error: `everyMinutes is at least ${AGENDA_FLOOR_INTERVAL_MINUTES}, even when the owner asks for less.` };
	if (minutes < AGENDA_MIN_INTERVAL_MINUTES && request.ownerAskedShortInterval !== true) {
		return { ok: false, error: `everyMinutes is at least ${AGENDA_MIN_INTERVAL_MINUTES} (2 hours) unless the owner explicitly asked for a shorter interval.`, };
	}
	return { ok: true, minutes };
}

/**
 * Valida e normaliza o pedido de criação de um item da agenda. Recusa com a lista do que é aceito (tool honesta);
 * nunca descarta campo em silêncio. O horário cai fora do silêncio do dono; `watch` sem fim ganha 14 dias.
 */
export function planAgendaItem(input: { request: AgendaRequest; now: Date; settings: ProactiveSettings }): PlanAgendaResult {
	const { request, now, settings } = input;
	const adjustments: string[] = [];
	if (!(AGENDA_KINDS as readonly string[]).includes(request.kind)) return { ok: false, error: `kind must be one of: ${AGENDA_KINDS.join(", ")}.` };
	if (request.kind === "brief") return { ok: false, error: "brief items are not created from a request yet. Use remind for a one-off or recurring reminder." };
	const note = request.note.trim();
	if (!note) return { ok: false, error: "note is empty. Write what to do when it wakes, in one or two sentences." };
	if (note.length > AGENDA_NOTE_MAX_CHARS) return { ok: false, error: `note is ${note.length} characters; the limit is ${AGENDA_NOTE_MAX_CHARS}. Shorten it.` };

	const interval = validateInterval(request);
	if (!interval.ok) return interval;
	const intervalMinutes = interval.minutes;

	if (request.maxRuns !== undefined && (!Number.isInteger(request.maxRuns) || request.maxRuns < 1 || request.maxRuns > AGENDA_MAX_RUNS_CAP)) {
		return { ok: false, error: `maxRuns must be a whole number from 1 to ${AGENDA_MAX_RUNS_CAP}.` };
	}

	const horizonEnd = new Date(now.getTime() + AGENDA_MAX_HORIZON_DAYS * DAY_MS);
	const resolveUntil = (): { ok: true; at: Date | null } | { ok: false; error: string } => {
		if (request.until === undefined) return { ok: true, at: null };
		const resolved = resolveFollowupWhen(request.until, now, settings.timezone);
		if (!resolved.ok) return { ok: false, error: `until: ${resolved.error}` };
		if (resolved.dueAt.getTime() > horizonEnd.getTime()) return { ok: false, error: `until is at most ${AGENDA_MAX_HORIZON_DAYS} days ahead.` };
		return { ok: true, at: resolved.dueAt };
	};

	if (request.kind === "intent") {
		if (request.when !== undefined || request.everyMinutes !== undefined) return { ok: false, error: "intent wakes on an event, not on a clock: leave when and everyMinutes out. Use until to say how long it lasts." };
		const parsed = parseAgendaEventFilter(request.eventFilter);
		if (!parsed.ok) return parsed;
		const until = resolveUntil();
		if (!until.ok) return until;
		const untilAt = until.at ?? new Date(now.getTime() + AGENDA_INTENT_DEFAULT_DAYS * DAY_MS);
		if (until.at === null) adjustments.push(`no end given: it lasts ${AGENDA_INTENT_DEFAULT_DAYS} days`);
		return { ok: true, plan: { kind: "intent", note, dueAt: untilAt, requestedFor: untilAt, intervalMinutes: null, untilAt, maxRuns: request.maxRuns ?? null, eventFilter: parsed.filter, movedForQuietHours: false, adjustments } };
	}

	if (request.eventFilter !== undefined) return { ok: false, error: "eventFilter belongs to kind intent only." };

	let requestedFor: Date;
	if (request.kind === "watch") {
		if (intervalMinutes === null) return { ok: false, error: `watch needs everyMinutes (at least ${AGENDA_MIN_INTERVAL_MINUTES}).` };
		if (request.when !== undefined) {
			const first = resolveFollowupWhen(request.when, now, settings.timezone);
			if (!first.ok) return { ok: false, error: `when: ${first.error}` };
			requestedFor = first.dueAt;
		} else requestedFor = new Date(now.getTime() + intervalMinutes * MINUTE_MS);
	} else {
		if (request.when === undefined) return { ok: false, error: 'remind needs when (ISO 8601 like 2026-11-07T10:00, or text like "tomorrow 10:00").' };
		const first = resolveFollowupWhen(request.when, now, settings.timezone);
		if (!first.ok) return { ok: false, error: `when: ${first.error}` };
		requestedFor = first.dueAt;
	}

	const until = resolveUntil();
	if (!until.ok) return until;
	let untilAt = until.at;
	if (request.kind === "remind" && intervalMinutes === null && (untilAt !== null || request.maxRuns !== undefined)) {
		return { ok: false, error: "until and maxRuns only apply to a recurring item: add everyMinutes, or leave them out for a one-off reminder." };
	}
	if (untilAt !== null && untilAt.getTime() <= requestedFor.getTime()) return { ok: false, error: "until must be after the first run." };
	if (request.kind === "watch" && untilAt === null && request.maxRuns === undefined) {
		untilAt = new Date(now.getTime() + AGENDA_WATCH_DEFAULT_DAYS * DAY_MS);
		adjustments.push(`no end given: it stops after ${AGENDA_WATCH_DEFAULT_DAYS} days`);
	}
	if (request.kind === "remind" && intervalMinutes !== null && untilAt === null && request.maxRuns === undefined) {
		untilAt = new Date(now.getTime() + AGENDA_WATCH_DEFAULT_DAYS * DAY_MS);
		adjustments.push(`no end given: it stops after ${AGENDA_WATCH_DEFAULT_DAYS} days`);
	}

	const dueAt = nextAllowedTime(requestedFor, settings);
	const movedForQuietHours = dueAt.getTime() !== requestedFor.getTime();
	if (movedForQuietHours) adjustments.push("moved out of the owner's quiet hours");
	if (untilAt !== null && dueAt.getTime() >= untilAt.getTime()) return { ok: false, error: "The first run would fall after the end (until). Move until later." };

	return {
		ok: true,
		plan: { kind: request.kind, note, dueAt, requestedFor, intervalMinutes, untilAt, maxRuns: request.kind === "remind" && intervalMinutes === null ? 1 : (request.maxRuns ?? null), eventFilter: null, movedForQuietHours, adjustments },
	};
}

/** Já existe um item ativo igual (mesmo tipo e mesma nota)? Evita o modelo recriar a cada turno. */
export function findDuplicateAgendaItem<T extends { kind: string; note: string }>(items: readonly T[], plan: Pick<AgendaPlan, "kind" | "note">): T | undefined {
	const wanted = normalizeForDedupe(plan.note);
	return items.find((item) => item.kind === plan.kind && normalizeForDedupe(item.note) === wanted);
}

// ---------------------------------------------------------------------------
// Espaçamento (vigia)
// ---------------------------------------------------------------------------

/** Multiplicador do intervalo conforme as execuções seguidas sem novidade. */
const BACKOFF_STEPS: ReadonlyArray<{ fromStreak: number; factor: number }> = [
	{ fromStreak: 10, factor: 8 },
	{ fromStreak: 6, factor: 4 },
	{ fromStreak: 3, factor: 2 },
	{ fromStreak: 0, factor: 1 },
];
const BACKOFF_CAP_MINUTES = 72 * 60;

export function watchBackoffFactor(noChangeStreak: number): number {
	const streak = Math.max(0, Math.floor(noChangeStreak));
	return BACKOFF_STEPS.find((step) => streak >= step.fromStreak)?.factor ?? 1;
}

export type WatchDelay = { ok: true; dueAt: Date; delayMinutes: number; movedForQuietHours: boolean } | { ok: false; reason: "past_until" };

/**
 * Quando é o próximo run de um item recorrente: intervalo × fator do espaçamento (teto de 72h, ou o próprio intervalo se
 * for maior), empurrado para fora do silêncio no fuso do dono. Passou de `untilAt` = encerra.
 */
export function nextWatchDelay(input: { now: Date; intervalMinutes: number; noChangeStreak: number; settings: ProactiveSettings; untilAt?: Date | null }): WatchDelay {
	const cap = Math.max(input.intervalMinutes, BACKOFF_CAP_MINUTES);
	const delayMinutes = Math.min(input.intervalMinutes * watchBackoffFactor(input.noChangeStreak), cap);
	const raw = new Date(input.now.getTime() + delayMinutes * MINUTE_MS);
	const dueAt = nextAllowedTime(raw, input.settings);
	if (input.untilAt && dueAt.getTime() >= input.untilAt.getTime()) return { ok: false, reason: "past_until" };
	return { ok: true, dueAt, delayMinutes, movedForQuietHours: dueAt.getTime() !== raw.getTime() };
}

// ---------------------------------------------------------------------------
// Acordar: freios antes do run
// ---------------------------------------------------------------------------

export type AgendaWakeItem = { status: string; kind: string; runCount: number; maxRuns: number | null; untilAt: Date | null; ignoredStreak: number };

export type AgendaStopReason = "expired" | "max_runs" | "ignored_notices";

export type AgendaWakePlan =
	| { action: "run"; ignoredStreak: number }
	| { action: "stop"; reason: AgendaStopReason; ignoredStreak: number }
	| { action: "defer"; dueAt: Date; reason: "quiet_hours"; ignoredStreak: number };

/**
 * O aviso anterior foi ignorado? Sinal ESTRUTURAL: o dono não abriu a conversa depois do aviso (`lastReadAt` anterior)
 * E não escreveu nela depois dele. Qualquer um dos dois conta como visto.
 */
export function wasNoticeIgnored(input: { noticeAt: Date; lastReadAt: Date | null; lastOwnerMessageAt: Date | null }): boolean {
	const seen = (at: Date | null) => at !== null && at.getTime() >= input.noticeAt.getTime();
	return !seen(input.lastReadAt) && !seen(input.lastOwnerMessageAt);
}

/** Contagem de avisos seguidos ignorados: ignorado soma, visto zera. */
export function nextIgnoredStreak(current: number, ignored: boolean): number {
	return ignored ? current + 1 : 0;
}

/**
 * Decide o que fazer com um item vencido ANTES de gastar um run: venceu a vigência, bateu `maxRuns`, o dono ignorou
 * `AGENDA_IGNORED_NOTICE_LIMIT` avisos seguidos, ou caiu no silêncio (adia). `noticeIgnored` = resultado de
 * `wasNoticeIgnored` do último aviso ainda não avaliado (`null` = não havia aviso a avaliar).
 */
export function planAgendaWake(input: { item: AgendaWakeItem; now: Date; settings: ProactiveSettings; noticeIgnored: boolean | null }): AgendaWakePlan {
	const { item, now } = input;
	const ignoredStreak = input.noticeIgnored === null ? item.ignoredStreak : nextIgnoredStreak(item.ignoredStreak, input.noticeIgnored);
	if (item.untilAt && item.untilAt.getTime() <= now.getTime()) return { action: "stop", reason: "expired", ignoredStreak };
	if (item.maxRuns !== null && item.runCount >= item.maxRuns) return { action: "stop", reason: "max_runs", ignoredStreak };
	if (ignoredStreak >= AGENDA_IGNORED_NOTICE_LIMIT) return { action: "stop", reason: "ignored_notices", ignoredStreak };
	const allowed = nextAllowedTime(now, input.settings);
	if (allowed.getTime() > now.getTime()) return { action: "defer", dueAt: allowed, reason: "quiet_hours", ignoredStreak };
	return { action: "run", ignoredStreak };
}

// ---------------------------------------------------------------------------
// Fechar: o que o resultado do run faz com o item
// ---------------------------------------------------------------------------

export type AgendaSettleItem = { kind: AgendaKind; intervalMinutes: number | null; untilAt: Date | null; maxRuns: number | null; runCount: number; noChangeStreak: number };

export type AgendaSettlement = {
	status: "pending" | "done";
	/** Próxima execução; `null` quando encerra. */
	dueAt: Date | null;
	noChangeStreak: number;
	endReason: string | null;
	/** O dono recebe uma mensagem? (`update` ou `done` com texto; `no_change` nunca.) */
	post: boolean;
};

/**
 * Efeito de `agenda_result` sobre o item. `item.runCount` já conta este run (incrementado ao acordar). Uma vez só
 * (sem intervalo) encerra sempre; recorrente espaça pelo `noChangeStreak` e encerra em `done`, `maxRuns` ou `untilAt`.
 */
export function settleAgendaRun(input: { item: AgendaSettleItem; outcome: AgendaOutcome; hasMessage: boolean; now: Date; settings: ProactiveSettings }): AgendaSettlement {
	const { item, outcome } = input;
	const post = outcome !== "no_change" && input.hasMessage;
	const noChangeStreak = outcome === "no_change" ? item.noChangeStreak + 1 : 0;
	const end = (endReason: string): AgendaSettlement => ({ status: "done", dueAt: null, noChangeStreak, endReason, post });
	if (outcome === "done") return end("done");
	// Intenção por evento: segue valendo depois de cada acordar, até `maxRuns` ou o fim da vigência (não há relógio).
	if (item.kind === "intent") {
		if (item.maxRuns !== null && item.runCount >= item.maxRuns) return end("max_runs");
		if (item.untilAt === null) return end("expired");
		return { status: "pending", dueAt: item.untilAt, noChangeStreak, endReason: null, post };
	}
	if (item.intervalMinutes === null) return end("completed");
	if (item.maxRuns !== null && item.runCount >= item.maxRuns) return end("max_runs");
	const next = nextWatchDelay({ now: input.now, intervalMinutes: item.intervalMinutes, noChangeStreak, settings: input.settings, untilAt: item.untilAt });
	if (!next.ok) return end("expired");
	return { status: "pending", dueAt: next.dueAt, noChangeStreak, endReason: null, post };
}

/**
 * Run de agenda que acabou SEM `agenda_result`. Sem o sinal explícito não se fala com o dono (contrato silencioso), com
 * uma exceção: o texto de um `remind` É o conteúdo do lembrete, então sai e o item segue como se fosse `update`. Nos outros
 * tipos o run conta como falha (`missingResults`, guardado em `attempts`): espaça como "sem novidade" e, na terceira
 * seguida, encerra com `no_result` para o dono ser avisado uma vez (nunca em silêncio total).
 */
export function settleAgendaRunWithoutResult(input: {
	item: AgendaSettleItem & { missingResults: number };
	hasText: boolean;
	now: Date;
	settings: ProactiveSettings;
}): AgendaSettlement & { missingResults: number } {
	if (input.item.kind === "remind") {
		return { ...settleAgendaRun({ item: input.item, outcome: input.hasText ? "update" : "no_change", hasMessage: input.hasText, now: input.now, settings: input.settings }), missingResults: 0 };
	}
	const missingResults = input.item.missingResults + 1;
	if (missingResults >= AGENDA_MISSING_RESULT_LIMIT) return { status: "done", dueAt: null, noChangeStreak: input.item.noChangeStreak, endReason: "no_result", post: true, missingResults };
	const settled = settleAgendaRun({ item: input.item, outcome: "no_change", hasMessage: false, now: input.now, settings: input.settings });
	return { ...settled, endReason: settled.endReason === "completed" ? "no_result" : settled.endReason, missingResults };
}
