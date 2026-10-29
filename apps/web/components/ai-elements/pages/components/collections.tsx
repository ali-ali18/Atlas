import type { PageNode } from "@workspace/shared";
import { ChevronDownIcon } from "lucide-react";
import { Badge } from "@workspace/ui/components/badge";
import { cn } from "@workspace/ui/lib/utils";

import { useLocale } from "@/lib/i18n/provider";
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

/**
 * Colunas por status. Em contêiner estreito (celular) empilham, cada uma como seção recolhível com a contagem, e nada
 * fica cortado na borda; a partir de @2xl viram colunas lado a lado (o título deixa de ser clicável).
 */
export function KanbanNode({ node }: { node: Of<"kanban"> }) {
	return (
		<div className="flex max-w-full flex-col gap-2.5 @2xl:flex-row @2xl:gap-3" data-page-node="kanban">
			{node.props.columns.map((column, index) => (
				<details className="group flex min-w-0 flex-col rounded-xl bg-muted/40 p-2.5 @2xl:flex-1" key={`${column.title}-${index}`} open>
					<summary className="flex cursor-pointer list-none items-center justify-between gap-2 [&::-webkit-details-marker]:hidden @2xl:pointer-events-none @2xl:cursor-default">
						<h5 className="truncate font-medium text-xs">{column.title}</h5>
						<span className="flex items-center gap-1.5 text-muted-foreground text-xs tabular-nums">
							{column.items.length}
							<ChevronDownIcon aria-hidden className="size-3.5 transition-transform group-open:rotate-180 @2xl:hidden" />
						</span>
					</summary>
					<div className="mt-2 flex flex-col gap-2">
						{column.items.length === 0 ? <p className="py-2 text-center text-muted-foreground text-xs">Nada aqui</p> : null}
						{column.items.map((item, i) => (
							<div className="flex min-w-0 flex-col gap-1 rounded-lg border border-border/60 bg-card px-2.5 py-2" key={`${item.title}-${i}`}>
								<div className="text-xs font-medium [overflow-wrap:anywhere]">{item.title}</div>
								{item.subtitle ? <div className="text-muted-foreground text-caption [overflow-wrap:anywhere]">{item.subtitle}</div> : null}
								{item.badge ? (
									<Badge className="w-fit max-w-full" variant="secondary">
										{item.badge}
									</Badge>
								) : null}
							</div>
						))}
					</div>
				</details>
			))}
		</div>
	);
}

/** Lista de itens (ex.: top clientes): título e detalhe à esquerda, valor à direita no mesmo formato. */
export function ListNode({ node }: { node: Of<"list"> }) {
	const { items, unit, format } = node.props;
	const digits = currencyDigits(items.map((item) => (typeof item.value === "number" ? item.value : null)));
	const locale = useLocale();
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
						<div className={cn("shrink-0 font-medium text-sm tabular-nums", item.tone ? TONE_TEXT : "")}>{formatPageValue(item.value, { unit, format, digits, locale })}</div>
					) : null}
				</li>
			))}
		</ul>
	);
}
