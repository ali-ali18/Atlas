/** Separadores de horário da conversa (estilo Grok): puro, em pt-BR e no fuso do usuário. */

export const SEPARATOR_GAP_MS = 60 * 60 * 1000;

const LOCALE = "pt-BR";

type Parts = { year: number; month: number; day: number; hour: number; minute: number };

function partsOf(date: Date, timeZone?: string): Parts {
	const formatter = new Intl.DateTimeFormat(LOCALE, {
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

const pad = (n: number) => String(n).padStart(2, "0");

function monthShort(date: Date, timeZone?: string): string {
	return new Intl.DateTimeFormat(LOCALE, { timeZone, month: "short" }).format(date);
}

function weekdayShort(date: Date, timeZone?: string): string {
	return new Intl.DateTimeFormat(LOCALE, { timeZone, weekday: "short" }).format(date);
}

/**
 * "18:13" (hoje) · "ontem, 18:13" · "sex., 9 de out. 18:13" (últimos 7 dias)
 * · "9 de out. 18:13" (mesmo ano) · "9 de out. de 2025, 18:13" (outro ano).
 */
export function formatSeparatorLabel(date: Date, now: Date, timeZone?: string): string {
	const p = partsOf(date, timeZone);
	const n = partsOf(now, timeZone);
	const time = `${pad(p.hour)}:${pad(p.minute)}`;
	const diff = dayNumber(n) - dayNumber(p);
	if (diff === 0) return time;
	if (diff === 1) return `ontem, ${time}`;
	const month = monthShort(date, timeZone);
	if (diff > 1 && diff < 7) {
		return `${weekdayShort(date, timeZone)}, ${p.day} de ${month} ${time}`;
	}
	if (p.year !== n.year) return `${p.day} de ${month} de ${p.year}, ${time}`;
	return `${p.day} de ${month} ${time}`;
}

/**
 * Mapa `id da mensagem -> rótulo` com o separador que vem ANTES dela.
 * Mensagens sem `createdAt` válido não geram separador nem viram referência.
 */
export function buildTimeSeparators(
	items: ReadonlyArray<{ id: string; createdAt?: string | null }>,
	now: Date = new Date(),
	timeZone?: string,
): Map<string, string> {
	const result = new Map<string, string>();
	let previous: Date | null = null;
	for (const item of items) {
		const date = parseTimestamp(item.createdAt);
		if (!date) continue;
		if (needsSeparator(previous, date, timeZone)) {
			result.set(item.id, formatSeparatorLabel(date, now, timeZone));
		}
		previous = date;
	}
	return result;
}
