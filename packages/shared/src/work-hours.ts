/**
 * Horário de trabalho da conta (`general.workHours`): janela do dia e dias úteis, no fuso da conta.
 * Só dados e funções puras (relógio por `now`, fuso por parâmetro). Quem usa (brief, vigia, alertas)
 * decide o que fazer fora da janela; aqui só se responde "está dentro?" e "quando começa de novo?".
 */
import { DEFAULT_PROACTIVE_TIMEZONE, isValidTimeZone, localParts, parseClockMinutes } from "./proactive.js";
import { zonedWallTimeToUtc } from "./routine-once.js";

/** `days`: 0-6 com domingo = 0. `start` < `end` (a janela não cruza a meia-noite). */
export type WorkHours = { start: string; end: string; days: number[] };

export const DEFAULT_WORK_HOURS: WorkHours = { start: "08:00", end: "18:00", days: [1, 2, 3, 4, 5] };

const CLOCK = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

/** Valida e normaliza (dias únicos e ordenados). Devolve `null` se algo estiver fora do formato. */
export function parseWorkHours(raw: unknown): WorkHours | null {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
	const { start, end, days } = raw as Record<string, unknown>;
	if (typeof start !== "string" || typeof end !== "string" || !CLOCK.test(start) || !CLOCK.test(end)) return null;
	if ((parseClockMinutes(start) ?? 0) >= (parseClockMinutes(end) ?? 0)) return null;
	if (!Array.isArray(days) || days.length === 0 || days.length > 7) return null;
	if (!days.every((d) => typeof d === "number" && Number.isInteger(d) && d >= 0 && d <= 6)) return null;
	if (new Set(days).size !== days.length) return null;
	return { start, end, days: [...(days as number[])].sort((a, b) => a - b) };
}

/** Lê `config.general.workHours`; ausente (conta antiga) ou inválido volta ao padrão. */
export function readWorkHours(config: { general?: { workHours?: unknown } } | null | undefined): WorkHours {
	const parsed = parseWorkHours(config?.general?.workHours);
	return parsed ?? { ...DEFAULT_WORK_HOURS, days: [...DEFAULT_WORK_HOURS.days] };
}

const zoneOrDefault = (timeZone: string | null | undefined) => (isValidTimeZone(timeZone) ? timeZone : DEFAULT_PROACTIVE_TIMEZONE);

/** `now` cai num dia útil e dentro de [início, fim) no fuso? */
export function isWithinWorkHours(now: Date, workHours: WorkHours, timeZone?: string | null): boolean {
	const parts = localParts(now, zoneOrDefault(timeZone));
	if (!workHours.days.includes(parts.weekday)) return false;
	const minutes = parts.hour * 60 + parts.minute;
	return minutes >= (parseClockMinutes(workHours.start) ?? 0) && minutes < (parseClockMinutes(workHours.end) ?? 0);
}

/**
 * Próximo começo de expediente ESTRITAMENTE depois de `now`: antes do início de um dia útil é o
 * início de hoje; durante ou depois do expediente é o início do próximo dia útil.
 */
export function nextWorkDayStart(now: Date, workHours: WorkHours, timeZone?: string | null): Date {
	const zone = zoneOrDefault(timeZone);
	const parts = localParts(now, zone);
	const startMinutes = parseClockMinutes(workHours.start) ?? 0;
	const days = workHours.days.length > 0 ? workHours.days : DEFAULT_WORK_HOURS.days;
	for (let offset = 0; offset <= 7; offset++) {
		const day = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + offset));
		if (!days.includes(day.getUTCDay())) continue;
		const candidate = zonedWallTimeToUtc(
			{
				year: day.getUTCFullYear(),
				month: day.getUTCMonth() + 1,
				day: day.getUTCDate(),
				hour: Math.floor(startMinutes / 60),
				minute: startMinutes % 60,
				second: 0,
			},
			zone,
		);
		if (candidate.getTime() > now.getTime()) return candidate;
	}
	return now;
}
