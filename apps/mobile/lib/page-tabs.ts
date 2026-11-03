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
