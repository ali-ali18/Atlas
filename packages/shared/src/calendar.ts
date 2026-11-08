// Calendário do dono (F7.1): validação PURA do que o bot grava, detecção de conflito por horário e o cartão `calendar`.
// Sem I/O: o relógio entra por `now` e o fuso por argumento. Nada aqui lê texto livre para decidir comportamento; o
// conflito compara intervalos de tempo e a validação compara formatos declarados (data ISO, e-mail, tamanho).
import { localParts, isValidTimeZone } from "./proactive.js";
import { zonedWallTimeToUtc } from "./routine-once.js";

export const CALENDAR_TITLE_MAX = 200;
export const CALENDAR_TEXT_MAX = 2000;
export const CALENDAR_LOCATION_MAX = 200;
export const CALENDAR_ATTENDEES_MAX = 20;
export const CALENDAR_LIST_MAX = 50;
export const CALENDAR_LIST_DEFAULT = 25;
export const CALENDAR_RANGE_MAX_DAYS = 31;
export const CALENDAR_DEFAULT_DURATION_MINUTES = 60;
export const CALENDAR_MAX_DURATION_MINUTES = 7 * 24 * 60;
/** Eventos que o cartão mostra (o resto vira "+n"). */
export const CALENDAR_CARD_EVENTS_MAX = 20;

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

/** Resposta do dono ao próprio convite (Google: `self` em `attendees`). */
export type CalendarSelfResponse = "accepted" | "declined" | "tentative" | "needsAction";

/**
 * O evento como o modelo e a UI o veem. `start`/`end`: evento com hora = instante ISO 8601 em UTC ("...Z"); dia inteiro =
 * "AAAA-MM-DD" com `end` EXCLUSIVO (como o Google). O fuso do dono só entra na hora de mostrar.
 */
export type CalendarEventView = {
	id: string;
	title: string;
	start: string;
	end: string;
	allDay: boolean;
	location?: string;
	description?: string;
	attendees?: string[];
	/** Link do evento no Google Agenda. */
	link?: string;
	/** Marcado como "livre" no Google (não bloqueia o horário). */
	free?: boolean;
	cancelled?: boolean;
	selfResponse?: CalendarSelfResponse;
};

/** O que o bot grava ao criar: já normalizado. */
export type CalendarEventDraft = {
	title: string;
	start: string;
	end: string;
	allDay: boolean;
	location?: string;
	description?: string;
	attendees: string[];
};

const clean = (v: unknown, max: number): string | undefined => (typeof v === "string" && v.trim() ? v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ").trim().slice(0, max) : undefined);

export function localDateString(date: Date, timeZone: string): string {
	const p = localParts(date, timeZone);
	return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const NAIVE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/;
const WITH_OFFSET = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/i;

export type CalendarMoment = { ok: true; kind: "date"; date: string } | { ok: true; kind: "instant"; iso: string } | { ok: false; error: string };

/** Lê um momento: "AAAA-MM-DD" (dia inteiro), ISO com fuso ("...Z", "-03:00") ou ISO sem fuso (vale o fuso do dono). */
export function parseCalendarMoment(raw: unknown, field: string, timeZone: string): CalendarMoment {
	const accepted = `${field} must be ISO 8601: YYYY-MM-DD for an all-day event, or YYYY-MM-DDTHH:MM (the owner's time zone) / with an offset like 2026-11-10T14:00-03:00.`;
	if (typeof raw !== "string" || !raw.trim()) return { ok: false, error: accepted };
	const text = raw.trim();
	const dateOnly = DATE_ONLY.exec(text);
	if (dateOnly) {
		const d = new Date(Date.UTC(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3])));
		if (d.getUTCFullYear() !== Number(dateOnly[1]) || d.getUTCMonth() !== Number(dateOnly[2]) - 1 || d.getUTCDate() !== Number(dateOnly[3])) return { ok: false, error: `${field} is not a real date. ${accepted}` };
		return { ok: true, kind: "date", date: text };
	}
	if (WITH_OFFSET.test(text)) {
		const parsed = new Date(text.replace(" ", "T"));
		return Number.isNaN(parsed.getTime()) ? { ok: false, error: accepted } : { ok: true, kind: "instant", iso: parsed.toISOString() };
	}
	const naive = NAIVE.exec(text);
	if (naive) {
		if (!isValidTimeZone(timeZone)) return { ok: false, error: `${field}: the owner's time zone is unknown.` };
		const [, y, mo, d, h, mi, s] = naive;
		if (Number(h) > 23 || Number(mi) > 59 || Number(s ?? 0) > 59) return { ok: false, error: accepted };
		const at = zonedWallTimeToUtc({ year: Number(y), month: Number(mo), day: Number(d), hour: Number(h), minute: Number(mi), second: Number(s ?? 0) }, timeZone);
		return Number.isNaN(at.getTime()) ? { ok: false, error: accepted } : { ok: true, kind: "instant", iso: at.toISOString() };
	}
	return { ok: false, error: accepted };
}

function addDays(date: string, days: number): string {
	const m = DATE_ONLY.exec(date)!;
	return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + days)).toISOString().slice(0, 10);
}

export function normalizeAttendees(raw: unknown): { ok: true; value: string[] } | { ok: false; error: string } {
	if (raw === undefined) return { ok: true, value: [] };
	if (!Array.isArray(raw)) return { ok: false, error: "attendees must be a list of email addresses." };
	if (raw.length > CALENDAR_ATTENDEES_MAX) return { ok: false, error: `attendees has ${raw.length} entries; the limit is ${CALENDAR_ATTENDEES_MAX}.` };
	const out: string[] = [];
	for (const item of raw) {
		const email = typeof item === "string" ? item.trim().toLowerCase() : "";
		if (!email || email.length > 254 || !/^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/.test(email)) return { ok: false, error: `attendees: "${String(item).slice(0, 60)}" is not an email address.` };
		if (!out.includes(email)) out.push(email);
	}
	return { ok: true, value: out };
}

export type CalendarDraftParse = { ok: true; value: CalendarEventDraft } | { ok: false; error: string };

type RawDraft = { title?: unknown; start?: unknown; end?: unknown; durationMinutes?: unknown; location?: unknown; description?: unknown; attendees?: unknown };

/** Valida um evento novo. Recusa com o campo errado (tool honesta); nunca descarta campo em silêncio. */
export function normalizeCalendarEventInput(raw: RawDraft, timeZone: string): CalendarDraftParse {
	const title = clean(raw.title, CALENDAR_TITLE_MAX);
	if (!title) return { ok: false, error: "title is required." };
	if (typeof raw.title === "string" && raw.title.trim().length > CALENDAR_TITLE_MAX) return { ok: false, error: `title is longer than ${CALENDAR_TITLE_MAX} characters.` };
	const start = parseCalendarMoment(raw.start, "start", timeZone);
	if (!start.ok) return start;
	let duration: number | undefined;
	if (raw.durationMinutes !== undefined) {
		if (typeof raw.durationMinutes !== "number" || !Number.isInteger(raw.durationMinutes) || raw.durationMinutes < 1 || raw.durationMinutes > CALENDAR_MAX_DURATION_MINUTES) return { ok: false, error: `durationMinutes must be a whole number from 1 to ${CALENDAR_MAX_DURATION_MINUTES}.` };
		duration = raw.durationMinutes;
	}
	if (raw.end !== undefined && duration !== undefined) return { ok: false, error: "give end or durationMinutes, not both." };
	let end: CalendarMoment;
	if (raw.end !== undefined) {
		end = parseCalendarMoment(raw.end, "end", timeZone);
		if (!end.ok) return end;
		if (end.kind !== start.kind) return { ok: false, error: "start and end must both be dates (all-day) or both be times." };
	} else if (start.kind === "date") {
		end = { ok: true, kind: "date", date: addDays(start.date, duration === undefined ? 1 : Math.max(1, Math.ceil(duration / (24 * 60)))) };
	} else {
		end = { ok: true, kind: "instant", iso: new Date(Date.parse(start.iso) + (duration ?? CALENDAR_DEFAULT_DURATION_MINUTES) * MINUTE_MS).toISOString() };
	}
	const startValue = start.kind === "date" ? start.date : start.iso;
	const endValue = end.kind === "date" ? end.date : (end as { iso: string }).iso;
	if (endValue <= startValue) return { ok: false, error: "end must be after start." };
	if (start.kind === "instant" && Date.parse(endValue) - Date.parse(startValue) > CALENDAR_MAX_DURATION_MINUTES * MINUTE_MS) return { ok: false, error: "the event is longer than 7 days; split it or use all-day dates." };
	const attendees = normalizeAttendees(raw.attendees);
	if (!attendees.ok) return attendees;
	const location = clean(raw.location, CALENDAR_LOCATION_MAX);
	const description = clean(raw.description, CALENDAR_TEXT_MAX);
	return { ok: true, value: { title, start: startValue, end: endValue, allDay: start.kind === "date", ...(location && { location }), ...(description && { description }), attendees: attendees.value } };
}

export type CalendarPatchInput = { title?: unknown; start?: unknown; end?: unknown; durationMinutes?: unknown; location?: unknown; description?: unknown; attendees?: unknown };

/** Os campos que mudaram (para o Google receber só o que mudou e o cartão dizer o quê). */
export type CalendarPatchField = "title" | "time" | "location" | "description" | "attendees";

export type CalendarPatchParse = { ok: true; value: CalendarEventDraft; changed: CalendarPatchField[] } | { ok: false; error: string };

/**
 * Junta o pedido de alteração ao evento atual e revalida o resultado. `location`/`description` vazios ("") apagam o campo.
 * Mudou só `start` sem `end`: a duração se mantém. `attendees` SUBSTITUI a lista inteira.
 */
export function mergeCalendarEventPatch(existing: CalendarEventView, patch: CalendarPatchInput, timeZone: string): CalendarPatchParse {
	const changed: CalendarPatchField[] = [];
	const merged: RawDraft = { title: existing.title, start: existing.start, end: existing.end, location: existing.location, description: existing.description, attendees: existing.attendees ?? [] };
	if (patch.title !== undefined) { merged.title = patch.title; changed.push("title"); }
	const touchesTime = patch.start !== undefined || patch.end !== undefined || patch.durationMinutes !== undefined;
	if (touchesTime) {
		if (patch.start !== undefined) merged.start = patch.start;
		if (patch.end !== undefined) merged.end = patch.end;
		else if (patch.durationMinutes !== undefined) { delete merged.end; merged.durationMinutes = patch.durationMinutes; }
		else if (patch.start !== undefined) {
			// Só o início mudou: mantém a duração do evento.
			const before = parseCalendarMoment(patch.start, "start", timeZone);
			if (!before.ok) return before;
			if (existing.allDay && before.kind === "date") merged.end = addDays(before.date, Math.max(1, Math.round((Date.parse(`${existing.end}T00:00:00Z`) - Date.parse(`${existing.start}T00:00:00Z`)) / DAY_MS)));
			else if (!existing.allDay && before.kind === "instant") merged.end = new Date(Date.parse(before.iso) + (Date.parse(existing.end) - Date.parse(existing.start))).toISOString();
			else return { ok: false, error: "start changes the kind of event (all-day vs. with a time); give end as well." };
		}
		changed.push("time");
	}
	if (patch.location !== undefined) { merged.location = patch.location; changed.push("location"); }
	if (patch.description !== undefined) { merged.description = patch.description; changed.push("description"); }
	if (patch.attendees !== undefined) { merged.attendees = patch.attendees; changed.push("attendees"); }
	if (changed.length === 0) return { ok: false, error: "Nothing to change: give at least one of title, start, end, durationMinutes, location, description or attendees." };
	const parsed = normalizeCalendarEventInput(merged, timeZone);
	return parsed.ok ? { ok: true, value: parsed.value, changed } : parsed;
}

/**
 * Eventos que se sobrepõem ao horário candidato. Só conta o que BLOQUEIA o horário: com hora, não cancelado, não marcado
 * "livre" e não recusado pelo dono. Dia inteiro não bloqueia (feriado, aniversário). Intervalos de tempo, sem texto.
 */
export function findCalendarConflicts(events: readonly CalendarEventView[], candidate: { start: string; end: string; allDay: boolean; ignoreId?: string }): CalendarEventView[] {
	if (candidate.allDay) return [];
	const from = Date.parse(candidate.start);
	const to = Date.parse(candidate.end);
	return events.filter((event) => {
		if (event.allDay || event.cancelled || event.free || event.selfResponse === "declined") return false;
		if (candidate.ignoreId && event.id === candidate.ignoreId) return false;
		return Date.parse(event.start) < to && from < Date.parse(event.end);
	});
}

export type CalendarRange = { ok: true; from: string; to: string } | { ok: false; error: string };

/** Período a listar: um dia ("AAAA-MM-DD", padrão hoje) ou `from`..`to` (até 31 dias). Limites em instantes UTC. */
export function resolveCalendarRange(input: { date?: string; from?: string; to?: string; now: Date; timeZone: string }): CalendarRange {
	const { timeZone } = input;
	if (input.date !== undefined && (input.from !== undefined || input.to !== undefined)) return { ok: false, error: "give date, or from and to, not both." };
	const dayStart = (date: string): Date => {
		const m = DATE_ONLY.exec(date)!;
		return zonedWallTimeToUtc({ year: Number(m[1]), month: Number(m[2]), day: Number(m[3]), hour: 0, minute: 0, second: 0 }, timeZone);
	};
	const asDate = (value: string | undefined, field: string): { ok: true; date: string } | { ok: false; error: string } => {
		if (value === undefined) return { ok: true, date: localDateString(input.now, timeZone) };
		const parsed = parseCalendarMoment(value, field, timeZone);
		if (!parsed.ok) return parsed;
		return { ok: true, date: parsed.kind === "date" ? parsed.date : localDateString(new Date(parsed.iso), timeZone) };
	};
	if (input.from === undefined && input.to === undefined) {
		const day = asDate(input.date, "date");
		if (!day.ok) return day;
		return { ok: true, from: dayStart(day.date).toISOString(), to: dayStart(addDays(day.date, 1)).toISOString() };
	}
	const from = asDate(input.from, "from");
	if (!from.ok) return from;
	const to = asDate(input.to ?? from.date, "to");
	if (!to.ok) return to;
	if (to.date < from.date) return { ok: false, error: "to is before from." };
	// `to` é o último DIA incluído.
	const days = Math.round((Date.parse(`${to.date}T00:00:00Z`) - Date.parse(`${from.date}T00:00:00Z`)) / DAY_MS) + 1;
	if (days > CALENDAR_RANGE_MAX_DAYS) return { ok: false, error: `the period is ${days} days; the limit is ${CALENDAR_RANGE_MAX_DAYS}.` };
	return { ok: true, from: dayStart(from.date).toISOString(), to: dayStart(addDays(to.date, 1)).toISOString() };
}

/** "2026-11-10 14:00–15:00" no fuso do dono, ou "2026-11-10 (all day)". Formato estável para o modelo. */
export function formatCalendarWhen(event: Pick<CalendarEventView, "start" | "end" | "allDay">, timeZone: string): string {
	if (event.allDay) {
		const lastDay = addDays(event.end, -1);
		return lastDay > event.start ? `${event.start} to ${lastDay} (all day)` : `${event.start} (all day)`;
	}
	const fmt = (iso: string) => new Intl.DateTimeFormat("sv-SE", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso));
	const a = fmt(event.start);
	const b = fmt(event.end);
	return a.slice(0, 10) === b.slice(0, 10) ? `${a}–${b.slice(11)}` : `${a} to ${b}`;
}

// ---------------------------------------------------------------------------
// Cartão `calendar`
// ---------------------------------------------------------------------------

export const CALENDAR_CARD_ACTIONS = ["created", "updated", "listed"] as const;
export type CalendarCardAction = (typeof CALENDAR_CARD_ACTIONS)[number];

export type CalendarCardEvent = { id: string; title: string; start: string; end: string; allDay: boolean; location?: string; attendeeCount?: number; link?: string; conflict?: boolean };

/** Cartão persistido de evento criado/alterado ou lista de um período. A identidade é o `cardId`. */
export type PersistedCalendarCard = {
	v: 1;
	kind: "calendar";
	cardId: string;
	runId?: string;
	action: CalendarCardAction;
	timeZone: string;
	events: CalendarCardEvent[];
	/** Lista: quantos eventos além dos mostrados. */
	more?: number;
	/** Convite enviado aos convidados (o Google mandou e-mail). */
	notified?: boolean;
};

/** Evento do cartão, a partir do evento completo (corta descrição e lista de convidados: o cartão não mostra o corpo). */
export function toCalendarCardEvent(event: CalendarEventView, conflict = false): CalendarCardEvent {
	return {
		id: event.id,
		title: event.title.slice(0, CALENDAR_TITLE_MAX),
		start: event.start,
		end: event.end,
		allDay: event.allDay,
		...(event.location && { location: event.location.slice(0, CALENDAR_LOCATION_MAX) }),
		...(event.attendees && event.attendees.length > 0 && { attendeeCount: event.attendees.length }),
		...(event.link && { link: event.link }),
		...(conflict && { conflict: true }),
	};
}

function parseCardEvent(raw: unknown): CalendarCardEvent | null {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
	const r = raw as Record<string, unknown>;
	const id = clean(r.id, 300);
	const title = clean(r.title, CALENDAR_TITLE_MAX) ?? "";
	const start = typeof r.start === "string" ? r.start : "";
	const end = typeof r.end === "string" ? r.end : "";
	const allDay = r.allDay === true;
	const validMoment = (v: string) => (allDay ? DATE_ONLY.test(v) : !Number.isNaN(Date.parse(v)) && WITH_OFFSET.test(v));
	if (!id || !validMoment(start) || !validMoment(end)) return null;
	const link = typeof r.link === "string" && /^https:\/\//.test(r.link) && r.link.length <= 2000 ? r.link : undefined;
	const location = clean(r.location, CALENDAR_LOCATION_MAX);
	const attendeeCount = typeof r.attendeeCount === "number" && Number.isInteger(r.attendeeCount) && r.attendeeCount > 0 && r.attendeeCount <= 1000 ? r.attendeeCount : undefined;
	return { id, title, start, end, allDay, ...(location && { location }), ...(attendeeCount && { attendeeCount }), ...(link && { link }), ...(r.conflict === true && { conflict: true }) };
}

export function parseCalendarCard(row: Record<string, unknown>): PersistedCalendarCard | null {
	const cardId = clean(row.cardId, 200);
	const action = (CALENDAR_CARD_ACTIONS as readonly unknown[]).includes(row.action) ? (row.action as CalendarCardAction) : null;
	const timeZone = typeof row.timeZone === "string" && isValidTimeZone(row.timeZone) ? row.timeZone : null;
	if (!cardId || !action || !timeZone || !Array.isArray(row.events)) return null;
	const events = row.events.slice(0, CALENDAR_CARD_EVENTS_MAX).map(parseCardEvent);
	if (events.some((e) => e === null)) return null;
	if (events.length === 0 && action !== "listed") return null;
	const runId = clean(row.runId, 160);
	const more = typeof row.more === "number" && Number.isInteger(row.more) && row.more > 0 && row.more <= 1000 ? row.more : undefined;
	return { v: 1, kind: "calendar", cardId, ...(runId && { runId }), action, timeZone, events: events as CalendarCardEvent[], ...(more && { more }), ...(row.notified === true && { notified: true }) };
}
