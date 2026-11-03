import type { PageNode, PageSpec } from "@workspace/shared";
import * as React from "react";
import { View } from "react-native";
import { useAppColorScheme } from "@/lib/use-theme";
import { BarListNode, ProgressNode } from "./bars";
import { ChartNode } from "./chart";
import { KanbanNode, ListNode, TimelineNode } from "./collections";
import { BadgeNode, CalloutNode } from "./feedback";
import { CardNode, DividerNode, GridNode, SectionNode, StackNode, TabNode, TabsNode } from "./layout";
import { PageThemeContext, type RenderedChild } from "./page-theme";
import { StatNode } from "./stat";
import { TableNode } from "./table";
import { HeadingNode, TextNode } from "./text";

/**
 * Desenha a árvore de componentes de um painel (v2), um tipo do spec por componente. O spec chega já validado
 * (`parsePageSpec` em `lib/page-api.ts`) e nunca vira HTML: só componentes nativos. Tipo que este app não conhece
 * (um servidor mais novo) é ignorado sem quebrar o resto do painel.
 */

function renderChildren(node: PageNode): RenderedChild[] {
	return (node.children ?? []).map((child) => ({ node: child, element: <PageNodeView key={child.id} node={child} /> }));
}

/** `memo` por nó: o spec só muda quando o painel é atualizado, e os nós que não mudaram não redesenham. */
export const PageNodeView = React.memo(function PageNodeView({ node }: { node: PageNode }): React.ReactNode {
	switch (node.type) {
		case "section":
			return <SectionNode node={node}>{renderChildren(node)}</SectionNode>;
		case "grid":
			return <GridNode node={node}>{renderChildren(node)}</GridNode>;
		case "stack":
			return <StackNode node={node}>{renderChildren(node)}</StackNode>;
		case "card":
			return <CardNode node={node}>{renderChildren(node)}</CardNode>;
		case "tabs":
			return <TabsNode node={node}>{renderChildren(node)}</TabsNode>;
		case "tab":
			return <TabNode>{renderChildren(node)}</TabNode>;
		case "timeline":
			return <TimelineNode node={node} />;
		case "kanban":
			return <KanbanNode node={node} />;
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
		case "list":
			return <ListNode node={node} />;
		case "text":
			return <TextNode node={node} />;
		case "heading":
			return <HeadingNode node={node} />;
		default: {
			// Compilador: todo tipo do shared tem um `case` acima (o teste de `page-nodes` cobra o mesmo em tempo de execução).
			// Em tempo de execução um servidor mais novo pode mandar tipo que este app não conhece: some, o resto do painel fica.
			const unknown: never = node;
			void unknown;
			return null;
		}
	}
});

export function PageView({ spec }: { spec: PageSpec }) {
	const scheme = useAppColorScheme();
	const theme = React.useMemo(() => ({ scheme, palette: spec.palette }), [scheme, spec.palette]);
	return (
		<PageThemeContext.Provider value={theme}>
			<View className="min-w-0">
				<PageNodeView node={spec.root} />
			</View>
		</PageThemeContext.Provider>
	);
}
