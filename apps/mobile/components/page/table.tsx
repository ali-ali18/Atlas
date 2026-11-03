import { seeAllLabel } from "@workspace/ui/lib/chat-card-copy";
import * as React from "react";
import { View } from "react-native";
import { TableCard } from "@/components/chat/markdown-text";
import { Button } from "@/components/ui/button";
import { Text } from "@/components/ui/text";
import { pageTableBlock, visibleRows } from "@/lib/page-table";
import { type Of, usePageTheme } from "./page-theme";

/**
 * Tabela do painel: o mesmo `TableCard` das tabelas do chat (rolagem horizontal com larguras por coluna e a barrinha
 * de rolagem). Aqui só se converte o spec em bloco de tabela; número fica à direita. Com mais de 30 linhas mostra 30
 * e "Ver tudo (n)" (cada linha é uma view; 100 linhas de uma vez pesam no celular).
 */
export function TableNode({ node }: { node: Of<"table"> }) {
	const { scheme } = usePageTheme();
	const [expanded, setExpanded] = React.useState(false);
	const shown = React.useMemo(() => visibleRows(node.props.rows, expanded), [node.props.rows, expanded]);
	const table = React.useMemo(() => pageTableBlock(node.props.columns, shown.rows), [node.props.columns, shown.rows]);
	return (
		<View className="min-w-0 gap-2">
			<TableCard block={table.block} aligns={table.aligns} scheme={scheme} />
			{shown.hidden > 0 ? (
				<Button variant="secondary" size="sm" className="self-start" onPress={() => setExpanded(true)}>
					<Text>{seeAllLabel(node.props.rows.length)}</Text>
				</Button>
			) : null}
		</View>
	);
}
