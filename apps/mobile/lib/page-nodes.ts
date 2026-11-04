// Quais componentes nativos desenham cada tipo do painel. Mapa exaustivo: o compilador cobra um id para todo tipo de
// `PAGE_NODE_TYPES` (e o `page-view.tsx` cobra um componente para todo id), e o teste falha se um tipo ficar de fora.
// Assim um tipo novo no shared nunca vira um buraco em branco na tela do painel.
import type { PageNodeType } from "@workspace/shared";

export const PAGE_NODE_VIEWS = ["section", "grid", "stack", "card", "tabs", "tab", "divider", "stat", "chart", "bar_list", "table", "progress", "badge", "callout", "timeline", "kanban", "list", "text", "heading"] as const;
export type PageNodeView = (typeof PAGE_NODE_VIEWS)[number];

export const PAGE_NODE_VIEW_OF: Record<PageNodeType, PageNodeView> = {
	section: "section",
	grid: "grid",
	stack: "stack",
	card: "card",
	tabs: "tabs",
	tab: "tab",
	divider: "divider",
	stat: "stat",
	chart: "chart",
	bar_list: "bar_list",
	table: "table",
	progress: "progress",
	badge: "badge",
	callout: "callout",
	timeline: "timeline",
	kanban: "kanban",
	list: "list",
	text: "text",
	heading: "heading",
};
