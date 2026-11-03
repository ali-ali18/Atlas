import * as React from "react";
import { View } from "react-native";
import { TableCard } from "@/components/chat/markdown-text";
import { Button } from "@/components/ui/button";
import { Text } from "@/components/ui/text";
import { chartTable } from "@/lib/page-format";
import { pageTableBlock } from "@/lib/page-table";
import { type Of, usePageTheme } from "./page-theme";

/**
 * Gráfico ainda não tem desenho nativo: o nó mostra "Gráfico · <título>" com os dados em tabela simples (até 12
 * linhas) e, quando a tabela não conta tudo (ou não há dados), o botão "Abrir no navegador".
 */
export function ChartNode({ node }: { node: Of<"chart"> }) {
	const { scheme, onOpenWeb } = usePageTheme();
	const table = React.useMemo(() => chartTable(node.props.spec), [node.props.spec]);
	const block = React.useMemo(() => (table ? pageTableBlock(table.header.map((label, index) => ({ key: String(index), label })), table.rows.map((row) => Object.fromEntries(row.map((cell, index) => [String(index), cell])))) : null), [table]);
	const title = table?.title ?? (node.props.spec.title?.trim() || "Gráfico");
	return (
		<View className="min-w-0 gap-2">
			<Text variant="heading" className="text-control" numberOfLines={2}>
				{`Gráfico · ${title}`}
			</Text>
			{block ? <TableCard block={block.block} aligns={block.aligns.map((_, index) => (index === 0 ? "left" : "right"))} scheme={scheme} /> : <Text variant="muted">Sem dados para mostrar aqui.</Text>}
			{table && table.hidden > 0 ? (
				<Text variant="muted" className="text-caption">
					{`Mostrando ${table.rows.length} de ${table.rows.length + table.hidden} linhas.`}
				</Text>
			) : null}
			{onOpenWeb && (!table || table.hidden > 0) ? (
				<Button variant="secondary" size="sm" className="self-start" onPress={onOpenWeb}>
					<Text>Abrir no navegador</Text>
				</Button>
			) : null}
		</View>
	);
}
