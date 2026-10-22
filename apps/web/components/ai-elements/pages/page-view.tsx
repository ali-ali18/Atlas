"use client";

import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { PageBlock, PageLeafBlock, PageSpec, PageTabsBlock } from "@workspace/shared";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@workspace/ui/components/tabs";
import { cn } from "@workspace/ui/lib/utils";

import { markdownComponents } from "@/components/ui/templates/template-4/chat-thread/assistant-message";
import { LazyChart } from "@/components/ai-elements/chart/lazy-chart";

import { barPercent, formatPageDelta, formatPageNumber, formatPageValue, resolveTab } from "./page-format";

/**
 * Desenha o spec de uma página (blocos em ordem). Usado inline no cartão do chat e na tela cheia: o mesmo
 * componente, só muda o espaço. Markdown passa pelo renderizador seguro do chat (sem HTML cru).
 */

const DELTA_TONE = {
	up: "text-emerald-600 dark:text-emerald-400",
	down: "text-red-600 dark:text-red-400",
	flat: "text-muted-foreground",
} as const;

function StatsBlock({ block }: { block: Extract<PageLeafBlock, { type: "stats" }> }) {
	return (
		<div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4" data-page-block="stats">
			{block.items.map((item) => (
				<div className="min-w-0 rounded-lg border border-border/60 bg-muted/30 px-3 py-2.5" key={item.label} data-testid="page-stat">
					<div className="truncate text-muted-foreground text-xs">{item.label}</div>
					<div className="mt-0.5 font-heading font-semibold text-lg tabular-nums [overflow-wrap:anywhere]">
						{formatPageValue(item.value, { unit: item.unit, format: item.format })}
					</div>
					{item.delta ? <div className={cn("mt-0.5 text-xs tabular-nums", DELTA_TONE[item.delta.direction])}>{formatPageDelta(item.delta)}</div> : null}
				</div>
			))}
		</div>
	);
}

function BarListBlock({ block }: { block: Extract<PageLeafBlock, { type: "bar_list" }> }) {
	const max = Math.max(0, ...block.items.map((item) => item.value));
	return (
		<ul className="flex flex-col gap-2" data-page-block="bar_list">
			{block.items.map((item) => (
				<li className="min-w-0" key={item.label}>
					<div className="flex items-baseline justify-between gap-3 text-xs">
						<span className="min-w-0 truncate">{item.label}</span>
						<span className="shrink-0 text-muted-foreground tabular-nums">{item.display ?? formatPageNumber(item.value, { unit: block.unit })}</span>
					</div>
					<div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
						<div className="h-full rounded-full bg-primary" style={{ width: `${barPercent(item.value, max)}%` }} />
					</div>
				</li>
			))}
		</ul>
	);
}

function TableBlock({ block }: { block: Extract<PageLeafBlock, { type: "table" }> }) {
	return (
		<div className="max-w-full overflow-x-auto rounded-lg border border-border/60" data-page-block="table">
			<table className="w-full border-collapse text-xs">
				<thead className="bg-muted/40">
					<tr>
						{block.columns.map((column) => (
							<th className={cn("whitespace-nowrap px-3 py-2 font-medium", column.align === "right" ? "text-right" : column.align === "center" ? "text-center" : "text-left")} key={column.key} scope="col">
								{column.label}
							</th>
						))}
					</tr>
				</thead>
				<tbody>
					{block.rows.map((row, index) => (
						<tr className="border-border/60 border-t" key={index}>
							{block.columns.map((column) => {
								const cell = row[column.key];
								const align = column.align ?? (typeof cell === "number" ? "right" : "left");
								return (
									<td className={cn("px-3 py-1.5 align-top", typeof cell === "number" ? "whitespace-nowrap tabular-nums" : "min-w-[6rem]", align === "right" ? "text-right" : align === "center" ? "text-center" : "text-left")} key={column.key}>
										{formatPageValue(cell, { format: column.format })}
									</td>
								);
							})}
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}

function TabsBlock({ block, initialTab }: { block: PageTabsBlock; initialTab?: string }) {
	// Estado local: a aba escolhida não vai ao servidor nem à conversa.
	const [active, setActive] = useState<string>(resolveTab(block.tabs, initialTab).id);
	const current = resolveTab(block.tabs, active).id;
	return (
		<Tabs value={current} onValueChange={(value) => setActive(String(value))} data-page-block="tabs">
			<div className="max-w-full overflow-x-auto">
				<TabsList className="mx-0">
					{block.tabs.map((tab) => (
						<TabsTrigger key={tab.id} value={tab.id}>
							{tab.label}
						</TabsTrigger>
					))}
				</TabsList>
			</div>
			{block.tabs.map((tab) => (
				<TabsContent className="flex flex-col gap-4" key={tab.id} value={tab.id}>
					{tab.blocks.map((child) => (
						<PageBlockView block={child} key={child.id} />
					))}
				</TabsContent>
			))}
		</Tabs>
	);
}

export function PageBlockView({ block, initialTab }: { block: PageBlock; initialTab?: string }) {
	switch (block.type) {
		case "heading":
			return (
				<h3 className="font-heading font-semibold text-sm" data-page-block="heading">
					{block.text}
				</h3>
			);
		case "markdown":
			return (
				<div className="flex flex-col gap-2 text-sm [overflow-wrap:anywhere]" data-page-block="markdown">
					<ReactMarkdown components={markdownComponents} remarkPlugins={[remarkGfm]}>
						{block.text}
					</ReactMarkdown>
				</div>
			);
		case "stats":
			return <StatsBlock block={block} />;
		case "chart":
			return (
				<div className="min-w-0" data-page-block="chart">
					<LazyChart spec={block.spec} />
				</div>
			);
		case "bar_list":
			return <BarListBlock block={block} />;
		case "table":
			return <TableBlock block={block} />;
		case "tabs":
			return <TabsBlock block={block} initialTab={initialTab} />;
	}
}

export function PageView({ spec, className, initialTab }: { spec: PageSpec; className?: string; initialTab?: string }) {
	return (
		<div className={cn("flex min-w-0 flex-col gap-4", className)} data-testid="page-view">
			{spec.blocks.map((block) => (
				<PageBlockView block={block} initialTab={initialTab} key={block.id} />
			))}
		</div>
	);
}
