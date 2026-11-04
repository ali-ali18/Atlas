// Abas do painel: qual conteúdo aparece. `tabs.props.tabs` declara as abas; cada filho `tab` leva o id da sua.
import type { PageNode } from "@workspace/shared";

/** Id da aba que um nó `tab` representa (outro tipo de nó não é conteúdo de aba). */
export function tabNodeId(node: PageNode): string | null {
	return node.type === "tab" ? node.props.tab : null;
}

/** Só o conteúdo da aba ativa: os nós `tab` com aquele id. Aba sem conteúdo no spec fica vazia, sem quebrar. */
export function pickTabChildren<C extends { node: PageNode }>(children: readonly C[], activeId: string): C[] {
	return children.filter((child) => tabNodeId(child.node) === activeId);
}

/** Quantos itens um nó tem para a contagem da aba: linhas da tabela, itens de lista/barras/linha do tempo, cartões do kanban. */
function itemCount(node: PageNode): number | null {
	switch (node.type) {
		case "table":
			return node.props.rows.length;
		case "list":
		case "bar_list":
		case "timeline":
			return node.props.items.length;
		case "kanban":
			return node.props.columns.reduce((sum, column) => sum + column.items.length, 0);
		default:
			return null;
	}
}

/** Contêineres que só embrulham: a contagem da aba desce por eles até o primeiro conteúdo de verdade. */
const WRAPPERS: readonly PageNode["type"][] = ["section", "stack", "card", "grid"];

/**
 * Contagem ao lado do rótulo da aba ("Causas 5"): os itens do PRIMEIRO filho do conteúdo da aba (descendo por cartão,
 * seção e pilha). Só aparece quando dá para derivar do spec (tabela, lista, barras, linha do tempo, kanban); com texto
 * ou gráfico como primeiro filho não há número honesto, então não mostra nada (null) em vez de inventar.
 */
export function tabCount(children: ReadonlyArray<{ node: PageNode }>, tabId: string): number | null {
	const content = children.map((child) => child.node).filter((node) => tabNodeId(node) === tabId);
	let node: PageNode | undefined = content[0]?.children?.[0];
	for (let depth = 0; node && depth < 4; depth += 1) {
		const count = itemCount(node);
		if (count !== null) return count;
		if (!WRAPPERS.includes(node.type)) return null;
		node = node.children?.[0];
	}
	return null;
}
