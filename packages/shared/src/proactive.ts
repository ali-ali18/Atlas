/**
 * Modo proativo do bot principal: configuração, horário de silêncio, limite diário,
 * resolução de horários ("amanhã 9h") e dedupe. Funções puras (sem I/O): o relógio
 * entra por `now`, o fuso por `timeZone`.
 */
import { parseOnceRunAt, zonedWallTimeToUtc } from "./routine-once.js";

export const DEFAULT_PROACTIVE_TIMEZONE = "America/Sao_Paulo";

export type ProactiveRoutineMode = "suggest" | "auto";

export type ProactiveSettings = {
	enabled: boolean;
	/** "suggest" mostra um card (Criar / Agora não); "auto" cria e avisa (Manter / Desfazer). */
	routineMode: ProactiveRoutineMode;
	/** Teto de mensagens proativas por dia (só as que o bot começa sozinho). */
	maxPerDay: number;
	/** Início do silêncio, "HH:MM" no fuso do usuário. */
	quietStart: string;
	/** Fim do silêncio, "HH:MM". */
	quietEnd: string;
	timezone: string;
};

export const PROACTIVE_MAX_PER_DAY_MIN = 1;
export const PROACTIVE_MAX_PER_DAY_MAX = 10;

export const DEFAULT_PROACTIVE_SETTINGS: ProactiveSettings = {
	enabled: false,
	routineMode: "suggest",
	maxPerDay: 3,
	quietStart: "22:00",
	quietEnd: "08:00",
	timezone: DEFAULT_PROACTIVE_TIMEZONE,
};

export function isValidTimeZone(value: unknown): value is string {
	if (typeof value !== "string" || value.trim().length === 0 || value.length > 64) return false;
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: value });
		return true;
	} catch {
		return false;
	}
}

/** "HH:MM" -> minutos desde 00:00, ou null se inválido. */
export function parseClockMinutes(value: unknown): number | null {
	if (typeof value !== "string") return null;
	const match = value.trim().match(/^(\d{1,2}):(\d{2})$/);
	if (!match) return null;
	const hour = Number(match[1]);
	const minute = Number(match[2]);
	if (hour > 23 || minute > 59) return null;
	return hour * 60 + minute;
}

export function formatClockMinutes(total: number): string {
	const hour = Math.floor(total / 60) % 24;
	const minute = total % 60;
	return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/**
 * Lê `policyJson.proactive` com valores válidos (qualquer campo inválido volta ao padrão).
 * `accountTimezone` é o fuso das configurações da conta: quando existe e é válido, vale no
 * lugar do que o bot guardou ao ligar o modo (o padrão da conta manda).
 */
export function readProactiveSettings(policyJson: unknown, accountTimezone?: string | null): ProactiveSettings {
	const raw = asRecord(asRecord(policyJson)?.proactive);
	const accountZone = isValidTimeZone(accountTimezone) ? accountTimezone : undefined;
	const base = accountZone ? { ...DEFAULT_PROACTIVE_SETTINGS, timezone: accountZone } : DEFAULT_PROACTIVE_SETTINGS;
	if (!raw) return { ...base };
	const maxRaw = typeof raw.maxPerDay === "number" ? Math.floor(raw.maxPerDay) : base.maxPerDay;
	return {
		enabled: raw.enabled === true,
		routineMode: raw.routineMode === "auto" ? "auto" : "suggest",
		maxPerDay: Number.isFinite(maxRaw)
			? Math.min(PROACTIVE_MAX_PER_DAY_MAX, Math.max(PROACTIVE_MAX_PER_DAY_MIN, maxRaw))
			: base.maxPerDay,
		quietStart: parseClockMinutes(raw.quietStart) !== null ? String(raw.quietStart).trim() : base.quietStart,
		quietEnd: parseClockMinutes(raw.quietEnd) !== null ? String(raw.quietEnd).trim() : base.quietEnd,
		timezone: accountZone ?? (isValidTimeZone(raw.timezone) ? raw.timezone : base.timezone),
	};
}

/** Devolve um policyJson novo com `proactive` mesclado (o resto da política fica intacto). */
export function withProactiveSettings(
	policyJson: unknown,
	patch: Partial<ProactiveSettings>,
): Record<string, unknown> {
	const current = readProactiveSettings(policyJson);
	const next: ProactiveSettings = { ...current, ...patch };
	return { ...(asRecord(policyJson) ?? {}), proactive: readProactiveSettings({ proactive: next }) };
}

/** Só o bot principal pode usar o modo proativo. */
export function isProactiveActive(input: { isPrimary: boolean; policyJson: unknown }): boolean {
	return input.isPrimary && readProactiveSettings(input.policyJson).enabled;
}

export type LocalParts = { year: number; month: number; day: number; hour: number; minute: number; weekday: number };

const WEEKDAY_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Partes de calendário do instante no fuso (weekday: 0 = domingo). */
export function localParts(date: Date, timeZone: string): LocalParts {
	const map: Record<string, string> = {};
	for (const part of new Intl.DateTimeFormat("en-US", {
		timeZone,
		hourCycle: "h23",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		weekday: "short",
	}).formatToParts(date)) {
		if (part.type !== "literal") map[part.type] = part.value;
	}
	return {
		year: Number(map.year),
		month: Number(map.month),
		day: Number(map.day),
		hour: Number(map.hour) === 24 ? 0 : Number(map.hour),
		minute: Number(map.minute),
		weekday: WEEKDAY_INDEX[map.weekday ?? "Sun"] ?? 0,
	};
}

/** Soma dias a uma data de calendário (sem fuso) e devolve ano/mês/dia/dia-da-semana. */
function addCalendarDays(year: number, month: number, day: number, days: number) {
	const d = new Date(Date.UTC(year, month - 1, day + days));
	return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), weekday: d.getUTCDay() };
}

function wallToUtc(year: number, month: number, day: number, minutesOfDay: number, timeZone: string): Date {
	return zonedWallTimeToUtc(
		{ year, month, day, hour: Math.floor(minutesOfDay / 60), minute: minutesOfDay % 60, second: 0 },
		timeZone,
	);
}

function quietBounds(settings: ProactiveSettings): { start: number; end: number } | null {
	const start = parseClockMinutes(settings.quietStart);
	const end = parseClockMinutes(settings.quietEnd);
	if (start === null || end === null || start === end) return null;
	return { start, end };
}

export function isInQuietHours(date: Date, settings: ProactiveSettings): boolean {
	const bounds = quietBounds(settings);
	if (!bounds) return false;
	const parts = localParts(date, settings.timezone);
	const minutes = parts.hour * 60 + parts.minute;
	return bounds.start < bounds.end
		? minutes >= bounds.start && minutes < bounds.end
		: minutes >= bounds.start || minutes < bounds.end;
}

/** Primeiro instante >= `date` fora do silêncio (o próprio `date` se já estiver fora). */
export function nextAllowedTime(date: Date, settings: ProactiveSettings): Date {
	const bounds = quietBounds(settings);
	if (!bounds || !isInQuietHours(date, settings)) return date;
	const parts = localParts(date, settings.timezone);
	const minutes = parts.hour * 60 + parts.minute;
	// Janela que cruza a meia-noite e já passou do início: o fim é amanhã.
	const dayOffset = bounds.start > bounds.end && minutes >= bounds.start ? 1 : 0;
	const target = addCalendarDays(parts.year, parts.month, parts.day, dayOffset);
	return wallToUtc(target.year, target.month, target.day, bounds.end, settings.timezone);
}

/** [início, fim) do dia local que contém `date`. */
export function localDayWindow(date: Date, timeZone: string): { start: Date; end: Date } {
	const parts = localParts(date, timeZone);
	const next = addCalendarDays(parts.year, parts.month, parts.day, 1);
	return {
		start: wallToUtc(parts.year, parts.month, parts.day, 0, timeZone),
		end: wallToUtc(next.year, next.month, next.day, 0, timeZone),
	};
}

/** Chave estável do dia local ("2026-10-13"), para "uma reflexão por dia". */
export function localDayKey(date: Date, timeZone: string): string {
	const p = localParts(date, timeZone);
	return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

export type ProactiveGate =
	| { allowed: true }
	| { allowed: false; reason: "quiet_hours" | "daily_cap"; retryAt?: Date };

/**
 * Pode mandar uma mensagem que o bot começou sozinho agora? `sentToday` = quantas
 * mensagens proativas já saíram no dia local. Silêncio e teto valem para o servidor,
 * independente do que o modelo decidir.
 */
export function checkProactiveGate(input: {
	now: Date;
	settings: ProactiveSettings;
	sentToday: number;
}): ProactiveGate {
	if (isInQuietHours(input.now, input.settings)) {
		return { allowed: false, reason: "quiet_hours", retryAt: nextAllowedTime(input.now, input.settings) };
	}
	if (input.sentToday >= input.settings.maxPerDay) {
		return { allowed: false, reason: "daily_cap", retryAt: localDayWindow(input.now, input.settings.timezone).end };
	}
	return { allowed: true };
}

/** Minuto do dia (no fuso do usuário) do slot diário da reflexão: fim do silêncio + jitter estável por bot. */
export function reflectionSlotMinutes(settings: ProactiveSettings, botId: string): number {
	const end = parseClockMinutes(settings.quietEnd) ?? 8 * 60;
	let hash = 0;
	for (const char of botId) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
	return (end + 5 + (hash % 26)) % (24 * 60);
}

/** A reflexão do dia já pode rodar? (depois do slot, fora do silêncio e ainda sem reflexão hoje.) */
export function isReflectionDue(input: {
	now: Date;
	settings: ProactiveSettings;
	botId: string;
	lastReflectionAt: Date | null;
}): boolean {
	const { now, settings } = input;
	if (!settings.enabled || isInQuietHours(now, settings)) return false;
	const parts = localParts(now, settings.timezone);
	if (parts.hour * 60 + parts.minute < reflectionSlotMinutes(settings, input.botId)) return false;
	if (!input.lastReflectionAt) return true;
	return localDayKey(input.lastReflectionAt, settings.timezone) !== localDayKey(now, settings.timezone);
}

// ---------------------------------------------------------------------------
// Horários de lembrete
// ---------------------------------------------------------------------------

export type ResolveWhenResult = { ok: true; dueAt: Date; explicitTime: boolean } | { ok: false; error: string };

const MAX_AHEAD_MS = 365 * 24 * 60 * 60 * 1000;
const PAST_GRACE_MS = 60_000;
const DEFAULT_HOUR_MINUTES = 9 * 60;

const WEEKDAY_WORDS: Array<[RegExp, number]> = [
	[/\bdomingo\b/, 0],
	[/\bsegunda(?:\s*-?\s*feira)?\b/, 1],
	[/\bterca(?:\s*-?\s*feira)?\b/, 2],
	[/\bquarta(?:\s*-?\s*feira)?\b/, 3],
	[/\bquinta(?:\s*-?\s*feira)?\b/, 4],
	[/\bsexta(?:\s*-?\s*feira)?\b/, 5],
	[/\bsabado\b/, 6],
];

function normalizeWhen(text: string): string {
	return text
		.normalize("NFD")
		.replace(/[̀-ͯ]/g, "")
		.toLowerCase()
		.replace(/\s+/g, " ")
		.trim();
}

const NUMBER_WORDS: Record<string, number> = {
	um: 1, uma: 1, dois: 2, duas: 2, tres: 3, quatro: 4, cinco: 5, seis: 6, sete: 7, oito: 8, nove: 9, dez: 10,
};

function parseCount(token: string): number | null {
	if (/^\d+$/.test(token)) return Number(token);
	return NUMBER_WORDS[token] ?? null;
}

/** Hora do dia dita no texto ("9h", "9h30", "às 18:15", "meio-dia", "3 da tarde"). */
function extractTimeOfDay(text: string): number | null {
	if (/\bmeio[- ]?dia\b/.test(text)) return 12 * 60;
	if (/\bmeia[- ]?noite\b/.test(text)) return 0;
	const match =
		text.match(/\b(\d{1,2})\s*(?:h|:|horas?)\s*(\d{2})?\b/) ??
		text.match(/\bas\s+(\d{1,2})\b(?!\s*(?:dias?|semanas?|meses|mes))/);
	if (match) {
		let hour = Number(match[1]);
		const minute = match[2] ? Number(match[2]) : 0;
		if (hour > 23 || minute > 59) return null;
		if (hour < 12 && /\bda (?:tarde|noite)\b/.test(text)) hour += 12;
		return hour * 60 + minute;
	}
	if (/\bde manha\b|\bpela manha\b/.test(text)) return 9 * 60;
	if (/\bde tarde\b|\bda tarde\b|\bpela tarde\b/.test(text)) return 15 * 60;
	if (/\bde noite\b|\bda noite\b|\bpela noite\b/.test(text)) return 20 * 60;
	return null;
}

/**
 * Resolve "quando" de um lembrete no fuso do usuário. Aceita ISO 8601 (com ou sem
 * fuso; sem fuso vale o do usuário) e português informal: "amanhã 9h", "daqui a 2
 * horas", "segunda às 8h", "dia 13", "semana que vem". O horário padrão de uma
 * data sem hora é 09:00. Sempre no futuro e até 1 ano à frente.
 */
export function resolveFollowupWhen(input: string, now: Date, timeZone: string): ResolveWhenResult {
	const original = typeof input === "string" ? input.trim() : "";
	if (!original) return { ok: false, error: 'informe quando (ex.: "amanhã 9h" ou 2026-10-14T09:00)' };

	if (/^\d{4}-\d{2}-\d{2}(?:[T ]|$)/.test(original)) {
		const withTime = /^\d{4}-\d{2}-\d{2}$/.test(original) ? `${original}T09:00` : original;
		const parsed = parseOnceRunAt({ runAt: withTime, timezone: timeZone }, now);
		if (!parsed.ok) return { ok: false, error: parsed.error };
		return { ok: true, dueAt: new Date(parsed.runAtIso), explicitTime: !/^\d{4}-\d{2}-\d{2}$/.test(original) };
	}

	const text = normalizeWhen(original);
	const fail = (error: string): ResolveWhenResult => ({ ok: false, error });
	const finish = (dueAt: Date, explicitTime: boolean): ResolveWhenResult => {
		if (dueAt.getTime() < now.getTime() - PAST_GRACE_MS) {
			return fail("esse horário já passou; informe um momento futuro");
		}
		if (dueAt.getTime() > now.getTime() + MAX_AHEAD_MS) return fail("o lembrete não pode passar de 1 ano à frente");
		return { ok: true, dueAt, explicitTime };
	};

	if (/^(agora|ja|agorinha)$/.test(text)) return finish(new Date(now.getTime() + 60_000), false);

	// Relativo: "daqui a 2 horas", "em 30 minutos", "dentro de 3 dias".
	const relative = text.match(
		/\b(?:daqui a|daqui|em|dentro de|depois de)\s+(\d+|um|uma|dois|duas|tres|quatro|cinco|seis|sete|oito|nove|dez|meia)\s*(minutos?|min|horas?|h|dias?|semanas?)\b/,
	);
	if (relative) {
		const unit = relative[2] ?? "";
		const half = relative[1] === "meia";
		const count = half ? 0.5 : parseCount(relative[1] ?? "");
		if (count === null || count <= 0) return fail("quantidade inválida no horário relativo");
		const minutes = /^min/.test(unit)
			? count
			: /^h/.test(unit)
				? count * 60
				: /^dia/.test(unit)
					? count * 24 * 60
					: count * 7 * 24 * 60;
		// "daqui a 2 dias às 9h": a hora explícita vale.
		const clock = /^(dia|semana)/.test(unit) ? extractTimeOfDay(text.replace(relative[0], " ")) : null;
		const target = new Date(now.getTime() + minutes * 60_000);
		if (clock === null) return finish(target, false);
		const parts = localParts(target, timeZone);
		return finish(wallToUtc(parts.year, parts.month, parts.day, clock, timeZone), true);
	}

	const today = localParts(now, timeZone);
	const nowMinutes = today.hour * 60 + today.minute;
	const clock = extractTimeOfDay(text);
	const minutesOfDay = clock ?? DEFAULT_HOUR_MINUTES;
	const at = (date: { year: number; month: number; day: number }) =>
		finish(wallToUtc(date.year, date.month, date.day, minutesOfDay, timeZone), clock !== null);

	if (/\bdepois de amanha\b/.test(text)) return at(addCalendarDays(today.year, today.month, today.day, 2));
	if (/\bamanha\b/.test(text)) return at(addCalendarDays(today.year, today.month, today.day, 1));
	if (/\bhoje\b/.test(text)) {
		if (clock === null) return fail('informe a hora de hoje (ex.: "hoje 18h")');
		return at(today);
	}
	if (/\b(?:semana que vem|proxima semana)\b/.test(text) && !WEEKDAY_WORDS.some(([re]) => re.test(text))) {
		return at(addCalendarDays(today.year, today.month, today.day, 7));
	}

	// "dd/mm" ou "dd/mm/aaaa".
	const slash = text.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);
	if (slash) {
		const day = Number(slash[1]);
		const month = Number(slash[2]);
		if (month < 1 || month > 12 || day < 1 || day > 31) return fail("data inválida");
		let year = slash[3] ? Number(slash[3]) : today.year;
		if (year < 100) year += 2000;
		let candidate = { year, month, day };
		if (!slash[3] && wallToUtc(year, month, day, minutesOfDay, timeZone).getTime() < now.getTime() - PAST_GRACE_MS) {
			candidate = { year: year + 1, month, day };
		}
		return at(candidate);
	}

	// Dia da semana: próxima ocorrência (hoje só se a hora ainda não passou).
	for (const [re, weekday] of WEEKDAY_WORDS) {
		if (!re.test(text)) continue;
		let delta = (weekday - today.weekday + 7) % 7;
		if (delta === 0 && minutesOfDay <= nowMinutes) delta = 7;
		if (/\b(?:que vem|proxim[ao])\b/.test(text) && delta < 1) delta = 7;
		return at(addCalendarDays(today.year, today.month, today.day, delta));
	}

	// "dia 13": próxima ocorrência desse dia do mês.
	const dayOfMonth = text.match(/\bdia (\d{1,2})\b/);
	if (dayOfMonth) {
		const day = Number(dayOfMonth[1]);
		if (day < 1 || day > 31) return fail("dia do mês inválido");
		let { year, month } = today;
		const passed = day < today.day || (day === today.day && minutesOfDay <= nowMinutes);
		if (passed) {
			month += 1;
			if (month > 12) {
				month = 1;
				year += 1;
			}
		}
		// Meses curtos: avança até um mês que tenha esse dia.
		for (let guard = 0; guard < 12; guard += 1) {
			if (new Date(Date.UTC(year, month - 1, day)).getUTCMonth() === month - 1) return at({ year, month, day });
			month += 1;
			if (month > 12) {
				month = 1;
				year += 1;
			}
		}
		return fail("dia do mês inválido");
	}

	// Só uma hora ("18h"): hoje se ainda não passou, senão amanhã.
	if (clock !== null) {
		return at(addCalendarDays(today.year, today.month, today.day, clock <= nowMinutes ? 1 : 0));
	}

	return fail(`não entendi o horário "${original.slice(0, 80)}"; use ISO (2026-10-14T09:00) ou algo como "amanhã 9h"`);
}

/** "qua, 14/10 às 09:00" no fuso do usuário. */
export function formatFollowupDue(dueAt: Date, timeZone: string): string {
	const weekday = new Intl.DateTimeFormat("pt-BR", { timeZone, weekday: "short" })
		.format(dueAt)
		.replace(".", "");
	const date = new Intl.DateTimeFormat("pt-BR", { timeZone, day: "2-digit", month: "2-digit" }).format(dueAt);
	const time = new Intl.DateTimeFormat("pt-BR", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(dueAt);
	return `${weekday}, ${date} às ${time}`;
}

// ---------------------------------------------------------------------------
// Dedupe
// ---------------------------------------------------------------------------

export function normalizeForDedupe(text: string): string {
	return normalizeWhen(text).replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
}

function wordSet(text: string): Set<string> {
	return new Set(normalizeForDedupe(text).split(" ").filter((word) => word.length > 2));
}

export function wordOverlap(a: string, b: string): number {
	const left = wordSet(a);
	const right = wordSet(b);
	if (left.size === 0 || right.size === 0) return 0;
	let shared = 0;
	for (const word of left) if (right.has(word)) shared += 1;
	return shared / Math.min(left.size, right.size);
}

export type RoutineDedupeCandidate = { name: string; prompt?: string | null; schedule?: string | null };

/** A rotina proposta repete uma existente (mesmo nome, ou mesma agenda com tema parecido)? */
export function findDuplicateRoutine<T extends RoutineDedupeCandidate>(
	existing: readonly T[],
	proposal: RoutineDedupeCandidate,
): T | null {
	const proposalName = normalizeForDedupe(proposal.name);
	for (const routine of existing) {
		if (normalizeForDedupe(routine.name) === proposalName) return routine;
		const sameSchedule = !!proposal.schedule && !!routine.schedule && proposal.schedule.trim() === routine.schedule.trim();
		const similar =
			wordOverlap(`${routine.name} ${routine.prompt ?? ""}`, `${proposal.name} ${proposal.prompt ?? ""}`) >= 0.6;
		if (sameSchedule && similar) return routine;
		if (!proposal.schedule && similar && wordOverlap(routine.name, proposal.name) >= 0.8) return routine;
	}
	return null;
}

/** Lembrete igual (mesmo texto) em até 2 h do horário já agendado? */
export function findDuplicateFollowup<T extends { note: string; dueAt: Date }>(
	pending: readonly T[],
	proposal: { note: string; dueAt: Date },
): T | null {
	const note = normalizeForDedupe(proposal.note);
	for (const item of pending) {
		const near = Math.abs(item.dueAt.getTime() - proposal.dueAt.getTime()) <= 2 * 60 * 60 * 1000;
		if (near && (normalizeForDedupe(item.note) === note || wordOverlap(item.note, proposal.note) >= 0.8)) return item;
	}
	return null;
}

// ---------------------------------------------------------------------------
// Lembretes escalonados e reagendamento
// ---------------------------------------------------------------------------

/** Máximo de lembretes por prazo (evita encher o usuário de avisos). */
export const REMINDER_STAGES_MAX = 4;
const STAGE_MINUTES = 9 * 60;
const STAGE_INTERMEDIATE_EVERY_DAYS = 10;

function dayNumber(parts: { year: number; month: number; day: number }): number {
	return Math.round(Date.UTC(parts.year, parts.month - 1, parts.day) / 86_400_000);
}

/**
 * Datas sugeridas para lembrar de um prazo, em vez de um aviso só (e tarde): um logo no dia
 * seguinte para planejar, intermediários a cada ~10 dias em horizontes longos, um 2 dias antes
 * e, se `important`, outro na véspera. Sempre 09:00 locais, no futuro, antes do dia do prazo,
 * no máximo `REMINDER_STAGES_MAX`, fora do silêncio quando `settings` é informado.
 */
export function suggestReminderStages(
	now: Date,
	deadline: Date,
	timeZone: string,
	options: { important?: boolean; settings?: ProactiveSettings } = {},
): Date[] {
	const today = localParts(now, timeZone);
	const end = localParts(deadline, timeZone);
	const todayN = dayNumber(today);
	const deadlineN = dayNumber(end);
	const daysLeft = deadlineN - todayN;
	if (daysLeft < 2) return [];

	const days = new Set<number>();
	const final = Math.max(deadlineN - 2, todayN + 1);
	const eve = deadlineN - 1;
	if (options.important && eve > final) days.add(eve);
	days.add(final);

	if (daysLeft >= 5) {
		const early = todayN + 1;
		days.add(early);
		const room = REMINDER_STAGES_MAX - days.size;
		const span = final - early;
		const count = Math.min(room, Math.floor(span / STAGE_INTERMEDIATE_EVERY_DAYS));
		for (let i = 1; i <= count; i += 1) days.add(early + Math.round((span * i) / (count + 1)));
	}

	return [...days]
		.sort((a, b) => a - b)
		.map((n) => {
			const d = new Date(n * 86_400_000);
			const at = wallToUtc(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), STAGE_MINUTES, timeZone);
			return options.settings ? nextAllowedTime(at, options.settings) : at;
		})
		.filter((at) => at.getTime() > now.getTime() && at.getTime() < deadline.getTime());
}

export type ReschedulePlan =
	| { ok: true; dueAt: Date; requestedFor: Date; movedForQuietHours: boolean }
	| { ok: false; error: string };

/**
 * Novo horário de um lembrete: lê `when` no fuso da conta (ISO sem fuso = fuso da conta),
 * recusa passado e empurra para o fim do silêncio quando cair dentro dele.
 */
export function planFollowupReschedule(input: { when: string; now: Date; settings: ProactiveSettings }): ReschedulePlan {
	const resolved = resolveFollowupWhen(input.when, input.now, input.settings.timezone);
	if (!resolved.ok) return { ok: false, error: resolved.error };
	const dueAt = nextAllowedTime(resolved.dueAt, input.settings);
	return { ok: true, dueAt, requestedFor: resolved.dueAt, movedForQuietHours: dueAt.getTime() !== resolved.dueAt.getTime() };
}

export type QuickRescheduleOption = { id: "tomorrow" | "in3days" | "monday"; label: string; local: string };

function localInputValue(n: number, minutes: number): string {
	const d = new Date(n * 86_400_000);
	const pad = (v: number) => String(v).padStart(2, "0");
	return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
}

/**
 * Atalhos do seletor de reagendamento ("Amanhã 9h", "Em 3 dias", "Próxima segunda 9h") como
 * horário de parede no fuso da conta (`YYYY-MM-DDTHH:mm`, o formato do input datetime-local).
 */
export function quickRescheduleOptions(now: Date, timeZone: string): QuickRescheduleOption[] {
	const today = localParts(now, timeZone);
	const n = dayNumber(today);
	const untilMonday = ((1 - today.weekday + 7) % 7) || 7;
	return [
		{ id: "tomorrow", label: "Amanhã 9h", local: localInputValue(n + 1, STAGE_MINUTES) },
		{ id: "in3days", label: "Em 3 dias", local: localInputValue(n + 3, STAGE_MINUTES) },
		{ id: "monday", label: "Próxima segunda 9h", local: localInputValue(n + untilMonday, STAGE_MINUTES) },
	];
}

/** Valor do input datetime-local para um instante, no fuso da conta. */
export function toLocalInputValue(date: Date, timeZone: string): string {
	const p = localParts(date, timeZone);
	return localInputValue(dayNumber(p), p.hour * 60 + p.minute);
}

// ---------------------------------------------------------------------------
// Avisos (etapas) de um mesmo lembrete
// ---------------------------------------------------------------------------

/** Um aviso do lembrete: quando dispara e, se já saiu, quando saiu. */
export type FollowupStage = { at: string; firedAt?: string | null };

/** Máximo de avisos num mesmo lembrete. */
export const FOLLOWUP_STAGES_MAX = REMINDER_STAGES_MAX;

/**
 * Lê o JSON de avisos guardado. Sem JSON (lembretes antigos) ou inválido, vira um aviso só no
 * `fallbackDueAt`. Já enviados vêm primeiro; os pendentes ficam em ordem de horário.
 */
export function parseFollowupStages(raw: unknown, fallbackDueAt: Date, done = false): FollowupStage[] {
	const list: FollowupStage[] = [];
	if (Array.isArray(raw)) {
		for (const item of raw) {
			const at = item && typeof item === "object" ? (item as Record<string, unknown>).at : null;
			const fired = item && typeof item === "object" ? (item as Record<string, unknown>).firedAt : null;
			if (typeof at !== "string" || Number.isNaN(Date.parse(at))) continue;
			list.push({ at: new Date(at).toISOString(), firedAt: typeof fired === "string" && !Number.isNaN(Date.parse(fired)) ? new Date(fired).toISOString() : null });
		}
	}
	if (list.length === 0) return [{ at: fallbackDueAt.toISOString(), firedAt: done ? fallbackDueAt.toISOString() : null }];
	return sortFollowupStages(list.slice(0, FOLLOWUP_STAGES_MAX));
}

export function sortFollowupStages(stages: readonly FollowupStage[]): FollowupStage[] {
	const fired = stages.filter((s) => s.firedAt);
	const pending = stages.filter((s) => !s.firedAt).sort((a, b) => a.at.localeCompare(b.at));
	return [...fired, ...pending];
}

/** Índice do próximo aviso pendente (-1 se todos já saíram). */
export function nextPendingStageIndex(stages: readonly FollowupStage[]): number {
	return stages.findIndex((s) => !s.firedAt);
}

/** Marca o próximo aviso como enviado. `nextDueAt` = horário do seguinte; null = era o último. */
export function advanceFollowupStages(stages: readonly FollowupStage[], now: Date): { stages: FollowupStage[]; nextDueAt: Date | null } {
	const index = nextPendingStageIndex(stages);
	const next = stages.map((s, i) => (i === index ? { ...s, firedAt: now.toISOString() } : { ...s }));
	const after = next.find((s) => !s.firedAt);
	return { stages: next, nextDueAt: after ? new Date(after.at) : null };
}

/** Troca o horário de um aviso pendente (índice 0-based); reordena os pendentes. null = aviso inexistente ou já enviado. */
export function setFollowupStageAt(stages: readonly FollowupStage[], index: number, at: Date): FollowupStage[] | null {
	const target = stages[index];
	if (!target || target.firedAt) return null;
	return sortFollowupStages(stages.map((s, i) => (i === index ? { at: at.toISOString(), firedAt: null } : s)));
}

/** Normaliza datas de avisos novos: ordena, tira repetidas (mesmo instante) e limita ao máximo. */
export function normalizeNewStages(dates: readonly Date[]): Date[] {
	const sorted = [...dates].sort((a, b) => a.getTime() - b.getTime());
	const out: Date[] = [];
	for (const d of sorted) if (out.length === 0 || d.getTime() - out[out.length - 1]!.getTime() >= 60_000) out.push(d);
	return out.slice(0, FOLLOWUP_STAGES_MAX);
}
