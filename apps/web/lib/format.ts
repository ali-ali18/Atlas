/**
 * Datas, horas e números no idioma da interface. Puro: recebe o `locale` (pegue-o com `useLocale()`
 * ou use `useFormat()` no componente). Nada de `toLocale*("pt-BR")` nem `Intl` com idioma fixo.
 * Instâncias de `Intl` são cacheadas (criar é caro e esta lista roda em listas longas).
 */
import { DEFAULT_UI_LOCALE, type UiLocale } from "./i18n/locales";

export type DateInput = Date | string | number | null | undefined;

const cache = new Map<string, Intl.DateTimeFormat | Intl.NumberFormat | Intl.RelativeTimeFormat | Intl.ListFormat>();

function cached<T extends Intl.DateTimeFormat | Intl.NumberFormat | Intl.RelativeTimeFormat | Intl.ListFormat>(
	kind: string,
	locale: UiLocale,
	options: object | undefined,
	create: () => T,
): T {
	const key = `${kind}|${locale}|${options ? JSON.stringify(options) : ""}`;
	let found = cache.get(key);
	if (!found) {
		found = create();
		cache.set(key, found);
	}
	return found as T;
}

/** `Date` válido ou `null` (vazio, texto inválido e `NaN` não quebram a tela). */
export function toDate(value: DateInput): Date | null {
	if (value === null || value === undefined || value === "") return null;
	const date = value instanceof Date ? value : new Date(value);
	return Number.isNaN(date.getTime()) ? null : date;
}

function dateTime(locale: UiLocale, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
	return cached("dt", locale, options, () => new Intl.DateTimeFormat(locale, options));
}

/** Partes de uma data (`formatToParts`) no fuso pedido, para montar texto próprio. */
export function dateParts(value: DateInput, locale: UiLocale, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormatPart[] {
	const date = toDate(value);
	return date ? dateTime(locale, options).formatToParts(date) : [];
}

/** Data numérica curta (pt 03/10/2026 · en 10/03/2026 · es 3/10/2026). Passe `options` para outro formato. */
export function formatDate(
	value: DateInput,
	locale: UiLocale = DEFAULT_UI_LOCALE,
	options: Intl.DateTimeFormatOptions = { day: "2-digit", month: "2-digit", year: "numeric" },
): string {
	const date = toDate(value);
	return date ? dateTime(locale, options).format(date) : "";
}

/** Idiomas de relógio 12 h (en: "9:05 AM") escrevem a hora sem zero à esquerda; os de 24 h mantêm "09:05". */
function hourStyle(locale: UiLocale): "numeric" | "2-digit" {
	const cycle = dateTime(locale, { hour: "numeric" }).resolvedOptions().hourCycle;
	return cycle === "h12" || cycle === "h11" ? "numeric" : "2-digit";
}

/** Hora e minuto no formato do idioma (en usa AM/PM). `hourCycle: "h23"` em `options` força 24 h. */
export function formatTime(value: DateInput, locale: UiLocale = DEFAULT_UI_LOCALE, options: Intl.DateTimeFormatOptions = {}): string {
	const date = toDate(value);
	return date ? dateTime(locale, { hour: hourStyle(locale), minute: "2-digit", ...options }).format(date) : "";
}

/** Dia e mês + hora e minuto (ex.: histórico de falhas). */
export function formatDateTime(value: DateInput, locale: UiLocale = DEFAULT_UI_LOCALE, options: Intl.DateTimeFormatOptions = {}): string {
	const date = toDate(value);
	return date
		? dateTime(locale, { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", ...options }).format(date)
		: "";
}

/** Dia da semana ("seg.", "Mon", "lun"). */
export function formatWeekday(value: DateInput, locale: UiLocale = DEFAULT_UI_LOCALE, options: Intl.DateTimeFormatOptions = {}): string {
	const date = toDate(value);
	return date ? dateTime(locale, { weekday: "short", ...options }).format(date) : "";
}

/** Nome do mês ("out.", "Oct", "oct"). */
export function formatMonth(value: DateInput, locale: UiLocale = DEFAULT_UI_LOCALE, options: Intl.DateTimeFormatOptions = {}): string {
	const date = toDate(value);
	return date ? dateTime(locale, { month: "short", ...options }).format(date) : "";
}

function numberFormat(locale: UiLocale, options: Intl.NumberFormatOptions | undefined): Intl.NumberFormat {
	return cached("nf", locale, options, () => new Intl.NumberFormat(locale, options));
}

/** Número com separadores do idioma (pt 1.234,5 · en 1,234.5). */
export function formatNumber(value: number, locale: UiLocale = DEFAULT_UI_LOCALE, options?: Intl.NumberFormatOptions): string {
	return Number.isFinite(value) ? numberFormat(locale, options).format(value) : "";
}

/** Número compacto (1,2 mil · 1.2K · 1,2 mil). */
export function formatCompactNumber(value: number, locale: UiLocale = DEFAULT_UI_LOCALE, maximumFractionDigits = 1): string {
	return formatNumber(value, locale, { notation: "compact", maximumFractionDigits });
}

/** `0.256` -> "25,6%" (a fração, não o número já multiplicado por 100). */
export function formatPercent(fraction: number, locale: UiLocale = DEFAULT_UI_LOCALE, maximumFractionDigits = 0): string {
	return formatNumber(fraction, locale, { style: "percent", maximumFractionDigits });
}

export function formatCurrency(value: number, currency: string, locale: UiLocale = DEFAULT_UI_LOCALE, options?: Intl.NumberFormatOptions): string {
	return formatNumber(value, locale, { style: "currency", currency, ...options });
}

const RELATIVE_STEPS: readonly { unit: Intl.RelativeTimeFormatUnit; ms: number }[] = [
	{ unit: "year", ms: 365 * 86_400_000 },
	{ unit: "month", ms: 30 * 86_400_000 },
	{ unit: "week", ms: 7 * 86_400_000 },
	{ unit: "day", ms: 86_400_000 },
	{ unit: "hour", ms: 3_600_000 },
	{ unit: "minute", ms: 60_000 },
];

/** "há 5 minutos" / "5 minutes ago" / "hace 5 minutos"; menos de 1 min vira "agora"/"now". `now` é injetado. */
export function formatRelative(value: DateInput, now: DateInput, locale: UiLocale = DEFAULT_UI_LOCALE): string {
	const date = toDate(value);
	const reference = toDate(now);
	if (!date || !reference) return "";
	const diff = date.getTime() - reference.getTime();
	const formatter = cached("rt", locale, { numeric: "auto" }, () => new Intl.RelativeTimeFormat(locale, { numeric: "auto" }));
	for (const step of RELATIVE_STEPS) {
		if (Math.abs(diff) >= step.ms) return formatter.format(Math.trunc(diff / step.ms), step.unit);
	}
	return formatter.format(0, "second");
}

/** "a, b e c" / "a, b, and c" / "a, b y c". */
export function formatList(items: readonly string[], locale: UiLocale = DEFAULT_UI_LOCALE, type: "conjunction" | "disjunction" = "conjunction"): string {
	return cached("lf", locale, { type }, () => new Intl.ListFormat(locale, { type, style: "long" })).format(items);
}

/** Comparação para ordenar texto no alfabeto do idioma (acentos e maiúsculas sem surpresa). */
export function compareText(a: string, b: string, locale: UiLocale = DEFAULT_UI_LOCALE): number {
	return a.localeCompare(b, locale);
}

/** Chave de busca: minúsculas e sem acento. Independe do idioma da tela de propósito. */
export function foldSearch(text: string): string {
	return text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}
