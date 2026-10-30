"use client";

import * as React from "react";

import * as format from "./format";
import { useLocale } from "./i18n/provider";

/** `format.ts` já com o idioma da tela: `const f = useFormat(); f.date(iso)`. */
export function useFormat() {
	const locale = useLocale();
	return React.useMemo(
		() => ({
			locale,
			date: (value: format.DateInput, options?: Intl.DateTimeFormatOptions) => format.formatDate(value, locale, options),
			time: (value: format.DateInput, options?: Intl.DateTimeFormatOptions) => format.formatTime(value, locale, options),
			dateTime: (value: format.DateInput, options?: Intl.DateTimeFormatOptions) => format.formatDateTime(value, locale, options),
			weekday: (value: format.DateInput, options?: Intl.DateTimeFormatOptions) => format.formatWeekday(value, locale, options),
			month: (value: format.DateInput, options?: Intl.DateTimeFormatOptions) => format.formatMonth(value, locale, options),
			number: (value: number, options?: Intl.NumberFormatOptions) => format.formatNumber(value, locale, options),
			compact: (value: number, maximumFractionDigits?: number) => format.formatCompactNumber(value, locale, maximumFractionDigits),
			percent: (fraction: number, maximumFractionDigits?: number) => format.formatPercent(fraction, locale, maximumFractionDigits),
			currency: (value: number, currency: string, options?: Intl.NumberFormatOptions) => format.formatCurrency(value, currency, locale, options),
			relative: (value: format.DateInput, now: format.DateInput) => format.formatRelative(value, now, locale),
			list: (items: readonly string[], type?: "conjunction" | "disjunction") => format.formatList(items, locale, type),
			compare: (a: string, b: string) => format.compareText(a, b, locale),
		}),
		[locale],
	);
}
