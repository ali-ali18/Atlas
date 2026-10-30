/** Separadores de horário da conversa (estilo Grok): puro, no idioma da interface e no fuso do usuário. */

import { formatDate, formatTime } from "./format";
import { DEFAULT_UI_LOCALE, type UiLocale } from "./i18n/locales";

export const SEPARATOR_GAP_MS = 60 * 60 * 1000;

/** Só para ler números das partes (não aparece na tela). */
const PARTS_LOCALE = "en-US";

type Parts = { year: number; month: number; day: number; hour: number; minute: number };

function partsOf(date: Date, timeZone?: string): Parts {
	const formatter = new Intl.DateTimeFormat(PARTS_LOCALE, {
		timeZone,
		year: "numeric",
		month: "numeric",
		day: "numeric",
		hour: "numeric",
		minute: "numeric",
		hourCycle: "h23",
	});
	const out: Record<string, number> = {};
	for (const part of formatter.formatToParts(date)) {
		if (part.type !== "literal") out[part.type] = Number(part.value);
	}
	return {
		year: out.year ?? 0,
		month: out.month ?? 1,
		day: out.day ?? 1,
		hour: (out.hour ?? 0) % 24,
		minute: out.minute ?? 0,
	};
}

/** Número do dia civil (no fuso) para comparar dias sem depender de horas de 23/25h. */
function dayNumber(p: Parts): number {
	return Math.floor(Date.UTC(p.year, p.month - 1, p.day) / 86_400_000);
}

export function parseTimestamp(value: string | undefined | null): Date | null {
	if (!value) return null;
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? null : date;
}

/** Há separador entre duas mensagens? Sem anterior, sempre; senão >60min ou outro dia. */
export function needsSeparator(
	previous: Date | null,
	current: Date,
	timeZone?: string,
): boolean {
	if (!previous) return true;
	if (current.getTime() - previous.getTime() > SEPARATOR_GAP_MS) return true;
	return dayNumber(partsOf(previous, timeZone)) !== dayNumber(partsOf(current, timeZone));
}

/**
 * pt-BR: "18:13" (hoje) · "ontem, 18:13" · "sex., 9 de out. 18:13" (últimos 7 dias)
 * · "9 de out. 18:13" (mesmo ano) · "9 de out. de 2025, 18:13" (outro ano).
 * Os outros idiomas seguem a mesma regra com o formato e as palavras do próprio `Intl`.
 */
export function formatSeparatorLabel(date: Date, now: Date, timeZone?: string, locale: UiLocale = DEFAULT_UI_LOCALE): string {
	const p = partsOf(date, timeZone);
	const n = partsOf(now, timeZone);
	const time = formatTime(date, locale, { timeZone });
	const diff = dayNumber(n) - dayNumber(p);
	if (diff === 0) return time;
	if (diff === 1) return `${new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(-1, "day")}, ${time}`;
	if (diff > 1 && diff < 7) {
		return `${formatDate(date, locale, { timeZone, weekday: "short", day: "numeric", month: "short" })} ${time}`;
	}
	if (p.year !== n.year) return `${formatDate(date, locale, { timeZone, day: "numeric", month: "short", year: "numeric" })}, ${time}`;
	return `${formatDate(date, locale, { timeZone, day: "numeric", month: "short" })} ${time}`;
}

/**
 * Mapa `id da mensagem -> rótulo` com o separador que vem ANTES dela.
 * Mensagens sem `createdAt` válido não geram separador nem viram referência.
 */
export function buildTimeSeparators(
	items: ReadonlyArray<{ id: string; createdAt?: string | null }>,
	now: Date = new Date(),
	timeZone?: string,
	locale: UiLocale = DEFAULT_UI_LOCALE,
): Map<string, string> {
	const result = new Map<string, string>();
	let previous: Date | null = null;
	for (const item of items) {
		const date = parseTimestamp(item.createdAt);
		if (!date) continue;
		if (needsSeparator(previous, date, timeZone)) {
			result.set(item.id, formatSeparatorLabel(date, now, timeZone, locale));
		}
		previous = date;
	}
	return result;
}
