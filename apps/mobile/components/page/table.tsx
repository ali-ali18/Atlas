import { seeAllLabel } from "@workspace/ui/lib/chat-card-copy";
import * as React from "react";
import { View } from "react-native";
import Animated, { useAnimatedScrollHandler, useAnimatedStyle, useSharedValue } from "react-native-reanimated";
import { Button } from "@/components/ui/button";
import { Text } from "@/components/ui/text";
import { hexAlpha } from "@/lib/color-math";
import { visibleRows } from "@/lib/page-table";
import { mergedRowHeights, pinFirstColumn, setRowHeight, type TableCellView, type TableColumnView, tableView } from "@/lib/page-views";
import { type Of, usePageTheme } from "./page-theme";

const PAD_X = 14;

type Heights = readonly number[];
type Side = "left" | "right";

function Cell({ text, align, width, header, tone }: { text: string; align: TableCellView["align"]; width: number; header?: boolean; tone?: string }) {
	const { surface } = usePageTheme();
	return (
		<View style={{ width, paddingHorizontal: PAD_X, justifyContent: "center" }}>
			<Text className={header ? "text-body font-medium" : "text-body"} style={{ textAlign: align, color: tone ?? (header ? surface.muted : surface.foreground), fontVariant: ["tabular-nums"], ...(tone ? { fontWeight: "500" } : null) }}>
				{text}
			</Text>
		</View>
	);
}

/** Linha (ou cabeçalho) de células; mede a própria altura para a coluna fixa e a rolável ficarem alinhadas linha a linha. */
function Row({ index, cells, columns, from, to, minHeight, onHeight, padY, background, header }: { index: number; cells: ReadonlyArray<TableCellView | string>; columns: readonly TableColumnView[]; from: number; to: number; minHeight: number; onHeight: (index: number, height: number) => void; padY: number; background?: string; header?: boolean }) {
	const { surface, tone: toneOf } = usePageTheme();
	return (
		// O de fora aplica a altura mínima (a maior dos dois lados); o de dentro mede só o conteúdo, sem esse mínimo.
		<View style={{ justifyContent: "center", minHeight, borderTopWidth: index > 0 ? 1 : 0, borderTopColor: surface.edge, backgroundColor: background }}>
			<View onLayout={(event) => onHeight(index, event.nativeEvent.layout.height)} style={{ flexDirection: "row", alignItems: "stretch", paddingVertical: padY }}>
			{columns.slice(from, to).map((column, offset) => {
				const cell = cells[from + offset]!;
				const content = typeof cell === "string" ? { text: cell, align: column.align, tone: null } : cell;
				return <Cell key={column.key} text={content.text} align={content.align} width={column.width} header={header} tone={content.tone ? toneOf(content.tone).text : undefined} />;
			})}
			</View>
		</View>
	);
}

/** Barrinha de rolagem visível (como a do web): trilho e polegar na posição da rolagem. A posição fica em valor compartilhado (sem re-renderizar a tabela). */
function ScrollBar({ viewport, content, offset }: { viewport: number; content: number; offset: { value: number } }) {
	const { surface } = usePageTheme();
	const track = Math.max(0, viewport - PAD_X * 2);
	const thumb = Math.max(24, Math.round(track * (viewport / content)));
	const range = Math.max(1, content - viewport);
	const style = useAnimatedStyle(() => ({ transform: [{ translateX: (track - thumb) * Math.min(1, Math.max(0, offset.value / range)) }] }));
	return (
		<View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ height: 14, justifyContent: "center", paddingHorizontal: PAD_X }}>
			<View style={{ height: 4, borderRadius: 2, backgroundColor: surface.track }}>
				<Animated.View style={[{ width: thumb, height: 4, borderRadius: 2, backgroundColor: hexAlpha(surface.muted, 0.8) }, style]} />
			</View>
		</View>
	);
}

/**
 * Tabela do web (contorno suave, cabeçalho `bg-muted/40`, linhas finas) com rolagem horizontal. Quando é mais larga que a
 * tela a PRIMEIRA COLUNA FICA FIXA e as outras rolam ao lado (duas colunas de views; a altura de cada linha é a maior das
 * duas, medida por `onLayout`). Número à direita, veredito (Confirmado, Parcial…) na cor de estado. Com mais de 30 linhas
 * mostra 30 e "Ver tudo (n)" (cada linha é uma view; 100 de uma vez pesam no celular).
 */
export function TableNode({ node }: { node: Of<"table"> }) {
	const { surface } = usePageTheme();
	const [expanded, setExpanded] = React.useState(false);
	const [viewport, setViewport] = React.useState(0);
	const [measured, setMeasured] = React.useState<Record<Side, Heights>>({ left: [], right: [] });
	const shown = React.useMemo(() => visibleRows(node.props.rows, expanded), [node.props.rows, expanded]);
	const view = React.useMemo(() => tableView({ ...node.props, rows: [...shown.rows] }), [node.props, shown.rows]);
	const widths = view.columns.map((column) => column.width);
	const total = widths.reduce((sum, width) => sum + width, 0);
	const pinned = pinFirstColumn(widths, viewport);
	const split = pinned ? 1 : 0;
	const scrollWidth = total - (pinned ? widths[0]! : 0);
	const scrollViewport = viewport - (pinned ? widths[0]! : 0);
	const overflow = viewport > 0 && total > viewport;
	const offset = useSharedValue(0);
	const onScroll = useAnimatedScrollHandler((event) => {
		offset.value = event.contentOffset.x;
	});
	const onLeft = React.useCallback((index: number, height: number) => setMeasured((previous) => (previous.left[index] === Math.ceil(height) ? previous : { ...previous, left: setRowHeight(previous.left, index, height) })), []);
	const onRight = React.useCallback((index: number, height: number) => setMeasured((previous) => (previous.right[index] === Math.ceil(height) ? previous : { ...previous, right: setRowHeight(previous.right, index, height) })), []);
	const minHeights = React.useMemo(() => mergedRowHeights(pinned ? measured.left : [], measured.right, view.rows.length + 1), [measured, pinned, view.rows.length]);
	const padY = view.compact ? 6 : 10;
	const header = view.columns.map((column) => column.label);
	const rowBackground = (index: number) => (view.striped && index % 2 === 1 ? hexAlpha(surface.track, 0.3) : undefined);
	const body = (from: number, to: number, onHeight: (index: number, height: number) => void) => (
		<View>
			<Row index={0} cells={header} columns={view.columns} from={from} to={to} minHeight={minHeights[0] ?? 0} onHeight={onHeight} padY={8} background={surface.soft} header />
			{view.rows.map((cells, rowIndex) => (
				<Row key={rowIndex} index={rowIndex + 1} cells={cells} columns={view.columns} from={from} to={to} minHeight={minHeights[rowIndex + 1] ?? 0} onHeight={onHeight} padY={padY} background={rowBackground(rowIndex)} />
			))}
		</View>
	);
	return (
		<View className="min-w-0 gap-2">
			<View className="overflow-hidden" style={{ borderRadius: 10, borderWidth: 1, borderColor: surface.edge }} onLayout={(event) => setViewport(Math.floor(event.nativeEvent.layout.width) - 2)}>
				<View style={{ flexDirection: "row" }}>
					{pinned ? <View style={{ width: widths[0], borderRightWidth: 1, borderRightColor: surface.edge }}>{body(0, 1, onLeft)}</View> : null}
					<Animated.ScrollView horizontal nestedScrollEnabled showsHorizontalScrollIndicator={false} scrollEventThrottle={16} onScroll={onScroll} style={{ flex: 1 }} contentContainerStyle={{ flexGrow: 1 }}>
						<View style={{ width: Math.max(scrollWidth, scrollViewport) }}>{body(split, view.columns.length, onRight)}</View>
					</Animated.ScrollView>
				</View>
				{overflow ? <ScrollBar viewport={scrollViewport > 0 ? scrollViewport : viewport} content={scrollWidth} offset={offset} /> : null}
			</View>
			{shown.hidden > 0 ? (
				<Button variant="secondary" size="sm" className="self-start" onPress={() => setExpanded(true)}>
					<Text>{seeAllLabel(node.props.rows.length)}</Text>
				</Button>
			) : null}
		</View>
	);
}
