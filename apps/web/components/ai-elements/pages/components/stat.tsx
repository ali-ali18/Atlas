import type { PageNode } from "@workspace/shared";
import { cn } from "@workspace/ui/lib/utils";

import { formatPageDelta, formatPageValue } from "../page-format";
import { TONE_TEXT, toneStyle } from "./tone";

type StatNode = Extract<PageNode, { type: "stat" }>;

const VALUE_SIZE = { sm: "text-base", md: "text-xl", lg: "text-3xl" } as const;
const DELTA_TONE = { up: "positive", down: "critical", flat: "neutral" } as const;

/**
 * KPI. Os tiles de uma linha têm a mesma altura (`h-full` na grade); rótulo e variação ficam em UMA linha
 * (truncados), o valor quebra em qualquer ponto só se for texto muito longo.
 */
export function StatNode({ node }: { node: StatNode }) {
	const { label, value, unit, format, delta, size = "md", tone } = node.props;
	const base = { unit, format };
	// Texto completo (sem abreviar o rótulo) no title, para quem passa o mouse ou toca.
	const fullDelta = delta ? [formatPageDelta({ ...delta, label: undefined }, base), delta.label].filter(Boolean).join(" ") : undefined;
	return (
		<div className="flex h-full min-w-0 flex-col gap-1 rounded-lg border border-border/60 bg-muted/30 px-3 py-2.5" data-page-node="stat" data-testid="page-stat">
			<div className="truncate text-muted-foreground text-xs" title={label}>
				{label}
			</div>
			<div className={cn("font-heading font-semibold tabular-nums leading-tight [overflow-wrap:anywhere]", VALUE_SIZE[size], tone ? TONE_TEXT : "")} style={tone ? toneStyle(tone) : undefined}>
				{formatPageValue(value, { unit, format })}
			</div>
			{delta ? (
				<div className={cn("truncate text-caption tabular-nums leading-4", TONE_TEXT)} style={toneStyle(DELTA_TONE[delta.direction])} title={fullDelta}>
					{formatPageDelta(delta, base)}
				</div>
			) : null}
		</div>
	);
}
