import type { PageNode } from "@workspace/shared";

import { useLocale } from "@/lib/i18n/provider";
import { barPercent, currencyDigits, formatPageNumber } from "../page-format";
import { TONE_FILL, toneStyle } from "./tone";

type Of<T extends PageNode["type"]> = Extract<PageNode, { type: T }>;

/** Lista de barras: a barra usa o destaque da paleta (ou o `tone`), nunca preto/branco. Números no mesmo formato. */
export function BarListNode({ node }: { node: Of<"bar_list"> }) {
	const { items, unit, format, tone = "accent" } = node.props;
	const max = Math.max(0, ...items.map((item) => item.value));
	const digits = currencyDigits(items.map((item) => item.value));
	const locale = useLocale();
	return (
		<ul className="flex flex-col gap-2.5" data-page-node="bar_list" style={toneStyle(tone)}>
			{items.map((item, index) => (
				<li className="min-w-0" key={`${item.label}-${index}`}>
					<div className="flex items-baseline justify-between gap-3 text-xs">
						<span className="min-w-0 truncate" title={item.label}>
							{item.label}
						</span>
						<span className="shrink-0 font-medium tabular-nums">{item.display ?? formatPageNumber(item.value, { unit, format, digits, locale })}</span>
					</div>
					<div className="mt-1 h-2 overflow-hidden rounded-full bg-muted">
						<div className={`h-full rounded-full ${TONE_FILL}`} data-bar style={{ width: `${barPercent(item.value, max)}%` }} />
					</div>
				</li>
			))}
		</ul>
	);
}

/** Meta atingida: "R$ 62.000 de R$ 100.000 · 62%" com a barra no destaque da paleta. */
export function ProgressNode({ node }: { node: Of<"progress"> }) {
	const { label, value, max, unit, format, tone = "accent" } = node.props;
	const digits = currencyDigits([value, max]);
	const locale = useLocale();
	const percent = Math.round((value / max) * 100);
	return (
		<div className="min-w-0" data-page-node="progress" style={toneStyle(tone)}>
			<div className="flex items-baseline justify-between gap-3 text-xs">
				<span className="min-w-0 truncate font-medium" title={label}>
					{label}
				</span>
				<span className="shrink-0 font-semibold tabular-nums">{percent}%</span>
			</div>
			<div
				aria-label={label}
				aria-valuemax={max}
				aria-valuemin={0}
				aria-valuenow={Math.min(value, max)}
				className="mt-1 h-2.5 overflow-hidden rounded-full bg-muted"
				role="progressbar"
			>
				<div className={`h-full rounded-full ${TONE_FILL}`} data-bar style={{ width: `${barPercent(value, max)}%` }} />
			</div>
			<div className="mt-1 text-muted-foreground text-xs tabular-nums">
				{formatPageNumber(value, { unit, format, digits, locale })} de {formatPageNumber(max, { unit, format, digits, locale })}
			</div>
		</div>
	);
}
