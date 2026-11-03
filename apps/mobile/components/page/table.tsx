import * as React from "react";
import { TableCard } from "@/components/chat/markdown-text";
import { pageTableBlock } from "@/lib/page-table";
import { type Of, usePageTheme } from "./page-theme";

/**
 * Tabela do painel: o mesmo `TableCard` das tabelas do chat (rolagem horizontal com larguras por coluna e a barrinha
 * de rolagem). Aqui só se converte o spec em bloco de tabela; número fica à direita.
 */
export function TableNode({ node }: { node: Of<"table"> }) {
	const { scheme } = usePageTheme();
	const table = React.useMemo(() => pageTableBlock(node.props.columns, node.props.rows), [node.props.columns, node.props.rows]);
	return <TableCard block={table.block} aligns={table.aligns} scheme={scheme} />;
}
