import { createContext } from "react";

// Adaptado do Bklit UI (MIT): formatadores no idioma da tela (padrão pt-BR) em vez de en-US.
// O app injeta o idioma por `UiCopyProvider` (`copy.locale`), que chama `setChartLocale`: os formatadores
// abaixo leem o idioma na hora de formatar, então os usos antigos (`shortDateFmt.format(...)`, `intFmt(...)`)
// seguem iguais. Trocar de idioma recarrega a página, então o valor nunca fica velho.
let chartLocale = "pt-BR";

export function setChartLocale(locale: string | undefined): void {
  chartLocale = locale || "pt-BR";
}

export function getChartLocale(): string {
  return chartLocale;
}

const intlCache = new Map<string, Intl.DateTimeFormat | Intl.NumberFormat>();

function cachedIntl<T extends Intl.DateTimeFormat | Intl.NumberFormat>(
  kind: "dt" | "nf",
  locale: string,
  options: object | undefined,
  create: () => T
): T {
  const key = `${kind}|${locale}|${options ? JSON.stringify(options) : ""}`;
  let found = intlCache.get(key);
  if (!found) {
    found = create();
    intlCache.set(key, found);
  }
  return found as T;
}

/** `Intl.DateTimeFormat` do idioma atual dos gráficos (cacheado). */
export function chartDateFormat(options: Intl.DateTimeFormatOptions, locale: string = chartLocale): Intl.DateTimeFormat {
  return cachedIntl("dt", locale, options, () => new Intl.DateTimeFormat(locale, options));
}

/** `Intl.NumberFormat` do idioma atual dos gráficos (cacheado). */
export function chartNumberFormat(options?: Intl.NumberFormatOptions, locale: string = chartLocale): Intl.NumberFormat {
  return cachedIntl("nf", locale, options, () => new Intl.NumberFormat(locale, options));
}

type DateFormatter = { format: (date: Date | number) => string };

function lazyDateFormat(options: Intl.DateTimeFormatOptions): DateFormatter {
  return { format: (date) => chartDateFormat(options).format(date) };
}

export const shortDateFmt = lazyDateFormat({ day: "2-digit", month: "2-digit" });

export const weekdayDateFmt = lazyDateFormat({ weekday: "short", day: "2-digit", month: "2-digit" });

export const hmsTimeFmt = lazyDateFormat({ hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });

export const intFmt = (value: number): string => chartNumberFormat().format(value);

/**
 * Formatador do rótulo do eixo X (linha/área) vindo de fora: gráficos de categorias usam datas sintéticas
 * (um dia por ponto) e este contexto devolve o nome da categoria no lugar de "dd/mm".
 */
export const XLabelFormatContext = createContext<((date: Date) => string) | null>(null);

export const valueLabelFmt = (value: number): string =>
  chartNumberFormat({ maximumFractionDigits: 0 }).format(value);

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Tooltip value for a `<Band>` row: `"low – high"` (ordered), the value itself
 * when both edges read the same key, or `null` when either edge is missing
 * (e.g. Bollinger warm-up rows).
 */
export function formatBandRange(
  point: Record<string, unknown>,
  upperKey: string,
  lowerKey: string,
  format: (value: number) => string = intFmt
): string | number | null {
  const upper = point[upperKey];
  const lower = point[lowerKey];
  if (!(isFiniteNumber(upper) && isFiniteNumber(lower))) {
    return null;
  }
  if (upperKey === lowerKey) {
    return upper;
  }
  return `${format(Math.min(lower, upper))} – ${format(Math.max(lower, upper))}`;
}
