"use client";

import { useMemo, type ReactNode } from "react";
import type { PageNode, PagePalette, PageSpec } from "@workspace/shared";
import { chartPaletteCss, resolveChartPalette } from "@workspace/ui/charts/chart-palettes";
import { cn } from "@workspace/ui/lib/utils";

import { BarListNode, ProgressNode } from "./components/bars";
import { ChartNode } from "./components/chart";
import { KanbanNode, ListNode, TimelineNode } from "./components/collections";
import { BadgeNode, CalloutNode } from "./components/feedback";
import { CardNode, DividerNode, GridNode, SectionNode, StackNode, TabsNode, type RenderedChild } from "./components/layout";
import { StatNode } from "./components/stat";
import { TableNode } from "./components/table";
import { HeadingNode, TextNode } from "./components/text";

/**
 * Desenha a árvore de componentes de um painel (v2). Usado inline no cartão do chat e na tela cheia: o mesmo
 * componente, só muda o espaço (o layout responde à largura do contêiner, não da janela). Cada tipo do spec
 * mapeia para um componente de `./components/*`; o resto do painel nunca vira HTML do modelo.
 */

function renderChildren(node: PageNode, initialTab?: string): RenderedChild[] {
	return (node.children ?? []).map((child) => ({ node: child, element: <PageNodeView initialTab={initialTab} key={child.id} node={child} /> }));
}

export function PageNodeView({ node, initialTab }: { node: PageNode; initialTab?: string }) {
	switch (node.type) {
		case "section":
			return <SectionNode node={node}>{renderChildren(node, initialTab)}</SectionNode>;
		case "grid":
			return <GridNode node={node}>{renderChildren(node, initialTab)}</GridNode>;
		case "stack":
			return <StackNode node={node}>{renderChildren(node, initialTab)}</StackNode>;
		case "card":
			return <CardNode node={node}>{renderChildren(node, initialTab)}</CardNode>;
		case "tabs":
			return (
				<TabsNode initialTab={initialTab} node={node}>
					{renderChildren(node, initialTab)}
				</TabsNode>
			);
		case "tab":
			// Conteúdo de uma aba: os filhos empilhados (o `TabsNode` escolhe qual mostrar).
			return <div className="flex min-w-0 flex-col gap-4">{renderChildren(node, initialTab).map((child) => child.element)}</div>;
		case "divider":
			return <DividerNode />;
		case "stat":
			return <StatNode node={node} />;
		case "chart":
			return <ChartNode node={node} />;
		case "bar_list":
			return <BarListNode node={node} />;
		case "table":
			return <TableNode node={node} />;
		case "progress":
			return <ProgressNode node={node} />;
		case "badge":
			return <BadgeNode node={node} />;
		case "callout":
			return <CalloutNode node={node} />;
		case "timeline":
			return <TimelineNode node={node} />;
		case "kanban":
			return <KanbanNode node={node} />;
		case "list":
			return <ListNode node={node} />;
		case "text":
			return <TextNode node={node} />;
		case "heading":
			return <HeadingNode node={node} />;
	}
}

/**
 * Escopo da paleta: define `--chart-1..6` (e derivados) só dentro do painel, pelo mesmo mecanismo dos gráficos
 * (`data-chart-palette` + CSS gerado de ids fixos ou hash, nunca texto livre). O destaque dos componentes
 * (`accent`) e os gráficos sem paleta própria herdam daqui.
 */
export function PagePaletteScope({ palette, children, className }: { palette?: PagePalette; children: ReactNode; className?: string }) {
	const resolved = useMemo(() => (palette ? (typeof palette === "string" ? resolveChartPalette(palette) : resolveChartPalette("custom", palette.colors)) : undefined), [palette]);
	return (
		<div className={className} data-chart-palette={resolved?.scope}>
			{resolved ? <style>{chartPaletteCss(resolved)}</style> : null}
			{children}
		</div>
	);
}

export function PageView({ spec, className, initialTab }: { spec: PageSpec; className?: string; initialTab?: string }) {
	return (
		<PagePaletteScope className={cn("@container min-w-0", className)} palette={spec.palette}>
			<div className="min-w-0" data-testid="page-view">
				<PageNodeView initialTab={initialTab} node={spec.root} />
			</div>
		</PagePaletteScope>
	);
}
