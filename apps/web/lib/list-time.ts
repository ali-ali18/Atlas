import { formatDate, formatTime, formatWeekday } from "./format";
import { DEFAULT_UI_LOCALE, type UiLocale } from "./i18n/locales";

const MINUTO_MS = 60_000;
const DIA_MS = 86_400_000;

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string | undefined): Intl.DateTimeFormat {
	const key = timeZone ?? "";
	let formatter = formatters.get(key);
	if (!formatter) {
		formatter = new Intl.DateTimeFormat("en-US", {
			timeZone,
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			hourCycle: "h23",
		});
		formatters.set(key, formatter);
	}
	return formatter;
}

/** Partes de calendário (ano, mês, dia, hora, minuto) no fuso pedido. */
function partsOf(date: Date, timeZone: string | undefined) {
	const out: Record<string, number> = {};
	for (const part of formatterFor(timeZone).formatToParts(date)) {
		if (part.type !== "literal") out[part.type] = Number(part.value);
	}
	return {
		year: out.year ?? 0,
		month: out.month ?? 0,
		day: out.day ?? 0,
		hour: out.hour ?? 0,
		minute: out.minute ?? 0,
	};
}

const capitalize = (text: string, locale: UiLocale) => text.charAt(0).toLocaleUpperCase(locale) + text.slice(1);

/**
 * Hora da última mensagem na lista, estilo WhatsApp (exemplos em pt-BR):
 * "agora" (< 1 min) · "HH:mm" (hoje) · "Ontem" · "Seg" (últimos 6 dias) · "dd/MM/yy".
 * Os outros idiomas usam o formato e as palavras do próprio `Intl` (en: "now", "3:29 PM", "Yesterday", "Mon", "10/08/26").
 * Dias contados no calendário do fuso (padrão: o do navegador), não em UTC.
 * Sem data (ou inválida) devolve "".
 */
export function formatListTime(
	iso: string | null | undefined,
	now: Date,
	timeZone?: string,
	locale: UiLocale = DEFAULT_UI_LOCALE,
): string {
	if (!iso) return "";
	const date = new Date(iso);
	if (Number.isNaN(date.getTime()) || Number.isNaN(now.getTime())) return "";
	const relative = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
	if (now.getTime() - date.getTime() < MINUTO_MS && date.getTime() - now.getTime() < MINUTO_MS) {
		return relative.format(0, "second");
	}

	const then = partsOf(date, timeZone);
	const current = partsOf(now, timeZone);
	const thenDay = Date.UTC(then.year, then.month - 1, then.day) / DIA_MS;
	const today = Date.UTC(current.year, current.month - 1, current.day) / DIA_MS;
	const diff = today - thenDay;

	// Hoje (ou relógio levemente adiantado): só a hora.
	if (diff <= 0) return formatTime(date, locale, { timeZone });
	if (diff === 1) return capitalize(relative.format(-1, "day"), locale);
	if (diff <= 6) {
		return capitalize(formatWeekday(new Date(thenDay * DIA_MS), locale, { timeZone: "UTC" }).replace(/\.$/, ""), locale);
	}
	return formatDate(date, locale, { timeZone, day: "2-digit", month: "2-digit", year: "2-digit" });
}

/** Hora da linha: usa a data da última mensagem; sem o campo (dados fixos), cai no texto pronto. */
export function rowTime(agent: { lastMessageAt?: string | null; time: string }, nowMs: number, locale: UiLocale = DEFAULT_UI_LOCALE): string {
	if (agent.lastMessageAt === undefined) return agent.time;
	return formatListTime(agent.lastMessageAt, new Date(nowMs), undefined, locale);
}
