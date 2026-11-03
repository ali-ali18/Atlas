import { seeAllLabel } from "@workspace/ui/lib/chat-card-copy";
import * as React from "react";
import { View } from "react-native";
import Animated, { useAnimatedScrollHandler, useAnimatedStyle, useSharedValue } from "react-native-reanimated";
import { Button } from "@/components/ui/button";
import { Text } from "@/components/ui/text";
import { hexAlpha } from "@/lib/color-math";
import { visibleRows } from "@/lib/page-table";
import { mergedRowHeights, setRowHeight, type TableCellView, type TableColumnView, tableLayout, tableView } from "@/lib/page-views";
import { type Of, usePageTheme } from "./page-theme";

const PAD_X = 14;

type Heights = readonly number[];
type Side = "left" | "right";

function Cell({ text, align, width, flex, header, tone }: { text: string; align: TableCellView["align"]; width: number; flex?: boolean; header?: boolean; tone?: string }) {
	const { surface } = usePageTheme();
	// `flex`: coluna de rótulo numa tabela que cabe; reparte o espaço que sobra e o texto quebra nela. Senão, a largura do conteúdo.
	return (
		<View style={[flex ? { flexGrow: 1, flexShrink: 1, flexBasis: width, minWidth: 0 } : { width }, { paddingHorizontal: PAD_X, justifyContent: "center" }]}>
			<Text className={header ? "text-body font-medium" : "text-body"} style={{ textAlign: align, color: tone ?? (header ? surface.muted : surface.foreground), fontVariant: ["tabular-nums"], ...(tone ? { fontWeight: "500" } : null) }}>
				{text}
			</Text>
		</View>
	);
}

/** Linha (ou cabeçalho) de células; mede a própria altura para a coluna fixa e a rolável ficarem alinhadas linha a linha. */
function Row({ index, cells, columns, widths, flex, from, to, minHeight, onHeight, padY, background, header }: { index: number; cells: ReadonlyArray<TableCellView | string>; columns: readonly TableColumnView[]; widths: readonly number[]; flex: readonly boolean[]; from: number; to: number; minHeight: number; onHeight: (index: number, height: number) => void; padY: number; background?: string; header?: boolean }) {
	const { surface, tone: toneOf } = usePageTheme();
	return (
		// O de fora aplica a altura mínima (a maior dos dois lados); o de dentro mede só o conteúdo, sem esse mínimo.
		<View style={{ justifyContent: "center", minHeight, borderTopWidth: index > 0 ? 1 : 0, borderTopColor: surface.edge, backgroundColor: background }}>
			<View onLayout={(event) => onHeight(index, event.nativeEvent.layout.height)} style={{ flexDirection: "row", alignItems: "stretch", paddingVertical: padY }}>
			{columns.slice(from, to).map((column, offset) => {
				const cell = cells[from + offset]!;
				const content = typeof cell === "string" ? { text: cell, align: column.align, tone: null } : cell;
				return <Cell key={column.key} text={content.text} align={content.align} width={widths[from + offset]!} flex={flex[from + offset]} header={header} tone={content.tone ? toneOf(content.tone).text : undefined} />;
			})}
			</View>
		</View>
	);
}

/**
 * Barrinha de rolagem visível (como a do web): o trilho ocupa a largura da tabela e o polegar mostra a proporção REAL
 * (parte visível / conteúdo que rola). A posição fica em valor compartilhado (sem re-renderizar a tabela).
 */
function ScrollBar({ viewport, scrollViewport, content, offset }: { viewport: number; scrollViewport: number; content: number; offset: { value: number } }) {
	const { surface } = usePageTheme();
	const track = Math.max(0, viewport - PAD_X * 2);
	const thumb = Math.min(track, Math.max(24, Math.round(track * (scrollViewport / content))));
	const range = Math.max(1, content - scrollViewport);
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
 * Tabela do web (contorno suave, cabeçalho `bg-muted/40`, linhas finas). Se CABE na tela, as colunas repartem a largura
 * (rótulo flexível e quebrando, número à direita com a largura do conteúdo), sem rolagem nem barra. Se não cabe, rola na
 * horizontal; com 3+ colunas a PRIMEIRA FICA FIXA (até 45% da tela) e as outras rolam ao lado (duas colunas de views; a
 * altura de cada linha é a maior das duas, medida por `onLayout`). A decisão é `tableLayout` (pura, testada). Número à direita, veredito (Confirmado, Parcial…) na cor de estado. Com mais de 30 linhas
 * mostra 30 e "Ver tudo (n)" (cada linha é uma view; 100 de uma vez pesam no celular).
 */
export function TableNode({ node }: { node: Of<"table"> }) {
	const { surface } = usePageTheme();
	const [expanded, setExpanded] = React.useState(false);
	const [viewport, setViewport] = React.useState(0);
	const [measured, setMeasured] = React.useState<Record<Side, Heights>>({ left: [], right: [] });
	const shown = React.useMemo(() => visibleRows(node.props.rows, expanded), [node.props.rows, expanded]);
	const view = React.useMemo(() => tableView({ ...node.props, rows: [...shown.rows] }), [node.props, shown.rows]);
	const layout = tableLayout(view.columns.map((column) => column.width), view.columns.map((column) => column.align), viewport);
	const scroll = layout.kind === "scroll";
	const pinned = layout.kind === "scroll" && layout.pinned;
	const split = pinned ? 1 : 0;
	const widths = layout.widths;
	const flex = layout.kind === "fit" ? layout.flex : widths.map(() => false);
	const scrollWidth = layout.kind === "scroll" ? layout.scrollWidth : 0;
	const scrollViewport = layout.kind === "scroll" ? layout.scrollViewport : viewport;
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
			<Row index={0} cells={header} columns={view.columns} widths={widths} flex={flex} from={from} to={to} minHeight={minHeights[0] ?? 0} onHeight={onHeight} padY={8} background={surface.soft} header />
			{view.rows.map((cells, rowIndex) => (
				<Row key={rowIndex} index={rowIndex + 1} cells={cells} columns={view.columns} widths={widths} flex={flex} from={from} to={to} minHeight={minHeights[rowIndex + 1] ?? 0} onHeight={onHeight} padY={padY} background={rowBackground(rowIndex)} />
			))}
		</View>
	);
	return (
		<View className="min-w-0 gap-2">
			<View className="overflow-hidden" style={{ borderRadius: 10, borderWidth: 1, borderColor: surface.edge }} onLayout={(event) => setViewport(Math.floor(event.nativeEvent.layout.width) - 2)}>
				{scroll ? (
					<View style={{ flexDirection: "row" }}>
						{pinned ? <View style={{ width: widths[0], borderRightWidth: 1, borderRightColor: surface.edge }}>{body(0, 1, onLeft)}</View> : null}
						<Animated.ScrollView horizontal nestedScrollEnabled showsHorizontalScrollIndicator={false} scrollEventThrottle={16} onScroll={onScroll} style={{ flex: 1 }}>
							{/* Nunca menor que o conteúdo (os valores não encostam no divisor) nem que a janela (o fundo da linha vai até a borda). */}
							<View style={{ width: Math.max(scrollWidth, scrollViewport) }}>{body(split, view.columns.length, onRight)}</View>
						</Animated.ScrollView>
					</View>
				) : (
					body(0, view.columns.length, onRight)
				)}
				{scroll ? <ScrollBar viewport={viewport} scrollViewport={scrollViewport} content={scrollWidth} offset={offset} /> : null}
			</View>
			{shown.hidden > 0 ? (
				<Button variant="secondary" size="sm" className="self-start" onPress={() => setExpanded(true)}>
					<Text>{seeAllLabel(node.props.rows.length)}</Text>
				</Button>
			) : null}
		</View>
	);
}
