import type { PageNode } from "@workspace/shared";
import { Badge } from "@workspace/ui/components/badge";
import { cn } from "@workspace/ui/lib/utils";

import { currencyDigits, formatPageValue } from "../page-format";
import { TONE_FILL, TONE_TEXT, toneStyle } from "./tone";

type Of<T extends PageNode["type"]> = Extract<PageNode, { type: T }>;

/** Linha do tempo vertical (vencimentos, marcos): data à esquerda, ponto no tom e texto. */
export function TimelineNode({ node }: { node: Of<"timeline"> }) {
	const items = node.props.items;
	return (
		<ol className="flex flex-col" data-page-node="timeline">
			{items.map((item, index) => (
				<li className="relative flex min-w-0 gap-3 pb-4 last:pb-0" key={`${item.date}-${index}`} style={toneStyle(item.tone ?? "accent")}>
					<span aria-hidden className={cn("absolute top-1.5 left-[4.5rem] -ml-1 size-2 rounded-full ring-4 ring-background", TONE_FILL)} />
					{index < items.length - 1 ? <span aria-hidden className="absolute top-3.5 bottom-0 left-[4.5rem] w-px bg-border" /> : null}
					<time className="w-14 shrink-0 pt-0.5 text-right text-muted-foreground text-xs tabular-nums">{item.date}</time>
					<div className="min-w-0 flex-1 pl-5">
						<div className="font-medium text-sm [overflow-wrap:anywhere]">{item.title}</div>
						{item.text ? <div className="text-muted-foreground text-xs [overflow-wrap:anywhere]">{item.text}</div> : null}
					</div>
				</li>
			))}
		</ol>
	);
}

/** Colunas por status; no celular rolam na horizontal (cada coluna com largura própria). */
export function KanbanNode({ node }: { node: Of<"kanban"> }) {
	return (
		<div className="-mx-1 flex max-w-full gap-3 overflow-x-auto px-1 pb-1" data-page-node="kanban" tabIndex={0}>
			{node.props.columns.map((column, index) => (
				<section aria-label={column.title} className="flex w-56 shrink-0 flex-col gap-2 rounded-xl bg-muted/40 p-2.5 @2xl:flex-1" key={`${column.title}-${index}`}>
					<header className="flex items-center justify-between gap-2">
						<h5 className="truncate font-medium text-xs">{column.title}</h5>
						<span className="text-muted-foreground text-xs tabular-nums">{column.items.length}</span>
					</header>
					{column.items.length === 0 ? <p className="py-2 text-center text-muted-foreground text-xs">Nada aqui</p> : null}
					{column.items.map((item, i) => (
						<div className="flex min-w-0 flex-col gap-1 rounded-lg border border-border/60 bg-card px-2.5 py-2" key={`${item.title}-${i}`}>
							<div className="text-xs font-medium [overflow-wrap:anywhere]">{item.title}</div>
							{item.subtitle ? <div className="text-muted-foreground text-[11px] [overflow-wrap:anywhere]">{item.subtitle}</div> : null}
							{item.badge ? (
								<Badge className="w-fit max-w-full" variant="secondary">
									{item.badge}
								</Badge>
							) : null}
						</div>
					))}
				</section>
			))}
		</div>
	);
}

/** Lista de itens (ex.: top clientes): título e detalhe à esquerda, valor à direita no mesmo formato. */
export function ListNode({ node }: { node: Of<"list"> }) {
	const { items, unit, format } = node.props;
	const digits = currencyDigits(items.map((item) => (typeof item.value === "number" ? item.value : null)));
	return (
		<ul className="flex flex-col divide-y divide-border/60 rounded-lg border border-border/60" data-page-node="list">
			{items.map((item, index) => (
				<li className="flex min-w-0 items-center justify-between gap-3 px-3 py-2.5" key={`${item.title}-${index}`} style={item.tone ? toneStyle(item.tone) : undefined}>
					<div className="min-w-0">
						<div className="truncate text-sm" title={item.title}>
							{item.title}
						</div>
						{item.subtitle ? <div className="truncate text-muted-foreground text-xs">{item.subtitle}</div> : null}
					</div>
					{item.value !== undefined ? (
						<div className={cn("shrink-0 font-medium text-sm tabular-nums", item.tone ? TONE_TEXT : "")}>{formatPageValue(item.value, { unit, format, digits })}</div>
					) : null}
				</li>
			))}
		</ul>
	);
}
