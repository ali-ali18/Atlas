"use client";

import { useState, type ReactNode } from "react";
import type { PageNode } from "@workspace/shared";
import { Separator } from "@workspace/ui/components/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@workspace/ui/components/tabs";
import { cn } from "@workspace/ui/lib/utils";

import { resolveTab } from "../page-format";
import { TONE_BG, TONE_BORDER, toneStyle } from "./tone";

/** Layout: section, grid, stack, card, tabs e divider. Os filhos já chegam renderizados (o renderizador é recursivo). */

export type RenderedChild = { node: PageNode; element: ReactNode };
type Of<T extends PageNode["type"]> = Extract<PageNode, { type: T }>;

const GAP = { sm: "gap-2", md: "gap-3", lg: "gap-5" } as const;

/**
 * Colunas por largura do CONTÊINER do painel (não da janela): o cartão do chat e a tela cheia têm larguras
 * diferentes no mesmo desktop. Celular = 1 coluna, tablet = 2; grade só de `stat` fica em 2 colunas no celular
 * (os tiles são curtos e 1 coluna vira uma coluna longa de números).
 */
const COLS = {
	1: "grid-cols-1",
	2: "grid-cols-1 @md:grid-cols-2",
	3: "grid-cols-1 @md:grid-cols-2 @2xl:grid-cols-3",
	4: "grid-cols-1 @md:grid-cols-2 @2xl:grid-cols-4",
} as const;
const STAT_COLS = {
	1: "grid-cols-1",
	2: "grid-cols-2",
	3: "grid-cols-2 @2xl:grid-cols-3",
	4: "grid-cols-2 @2xl:grid-cols-4",
} as const;
const SPAN = { 1: "", 2: "@md:col-span-2", 3: "@md:col-span-2 @2xl:col-span-3", 4: "@md:col-span-2 @2xl:col-span-4" } as const;
const STAT_SPAN = { 1: "", 2: "col-span-2", 3: "col-span-2 @2xl:col-span-3", 4: "col-span-2 @2xl:col-span-4" } as const;

export function SectionNode({ node, children }: { node: Of<"section">; children: RenderedChild[] }) {
	const { title, description } = node.props;
	return (
		<section aria-label={title} className="flex min-w-0 flex-col gap-3" data-page-node="section">
			{title || description ? (
				<header className="flex flex-col gap-0.5">
					{title ? <h4 className="font-heading font-semibold text-sm">{title}</h4> : null}
					{description ? <p className="text-muted-foreground text-xs [overflow-wrap:anywhere]">{description}</p> : null}
				</header>
			) : null}
			{children.map((child) => (
				<div className="min-w-0" key={child.node.id}>
					{child.element}
				</div>
			))}
		</section>
	);
}

export function GridNode({ node, children }: { node: Of<"grid">; children: RenderedChild[] }) {
	const cols = node.props.cols as 1 | 2 | 3 | 4;
	const statsOnly = children.length > 0 && children.every((child) => child.node.type === "stat");
	return (
		<div className={cn("grid min-w-0", GAP[node.props.gap ?? "md"], statsOnly ? STAT_COLS[cols] : COLS[cols])} data-page-node="grid">
			{children.map((child) => {
				const span = (("span" in child.node.props ? child.node.props.span : undefined) ?? 1) as 1 | 2 | 3 | 4;
				return (
					<div className={cn("min-w-0", statsOnly ? STAT_SPAN[span] : SPAN[span])} key={child.node.id}>
						{child.element}
					</div>
				);
			})}
		</div>
	);
}

export function StackNode({ node, children }: { node: Of<"stack">; children: RenderedChild[] }) {
	const horizontal = node.props.direction === "horizontal";
	return (
		<div className={cn("flex min-w-0", GAP[node.props.gap ?? "md"], horizontal ? "flex-row flex-wrap items-start" : "flex-col")} data-page-node="stack">
			{children.map((child) => (
				<div className={cn("min-w-0", horizontal ? "flex-1 basis-40" : "")} key={child.node.id}>
					{child.element}
				</div>
			))}
		</div>
	);
}

export function CardNode({ node, children }: { node: Of<"card">; children: RenderedChild[] }) {
	const { title, variant = "outlined", tone } = node.props;
	return (
		<div
			className={cn(
				"flex h-full min-w-0 flex-col gap-3 rounded-xl",
				variant === "plain" ? "" : "p-3.5",
				variant === "outlined" ? "border border-border/60 bg-card" : "",
				variant === "filled" ? "bg-muted/40" : "",
				tone && tone !== "neutral" ? cn("border-l-[3px]", TONE_BORDER, TONE_BG) : "",
			)}
			data-page-node="card"
			style={tone ? toneStyle(tone) : undefined}
		>
			{title ? <h4 className="font-heading font-semibold text-sm [overflow-wrap:anywhere]">{title}</h4> : null}
			{children.map((child) => (
				<div className="min-w-0" key={child.node.id}>
					{child.element}
				</div>
			))}
		</div>
	);
}

export function TabsNode({ node, children, initialTab }: { node: Of<"tabs">; children: RenderedChild[]; initialTab?: string }) {
	const tabs = node.props.tabs;
	// Estado local: a aba escolhida não vai ao servidor nem à conversa.
	const [active, setActive] = useState<string>(resolveTab(tabs, initialTab).id);
	const current = resolveTab(tabs, active).id;
	return (
		<Tabs onValueChange={(value) => setActive(String(value))} value={current} data-page-node="tabs">
			<div className="max-w-full overflow-x-auto">
				<TabsList className="mx-0">
					{tabs.map((tab) => (
						<TabsTrigger key={tab.id} value={tab.id}>
							{tab.label}
						</TabsTrigger>
					))}
				</TabsList>
			</div>
			{children.map((child) => (
				<TabsContent className="flex flex-col gap-4" key={child.node.id} value={child.node.type === "tab" ? child.node.props.tab : child.node.id}>
					{child.element}
				</TabsContent>
			))}
		</Tabs>
	);
}

export function DividerNode() {
	return <Separator data-page-node="divider" />;
}
