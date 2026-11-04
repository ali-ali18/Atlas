import * as React from "react";
import { Pressable, ScrollView, View } from "react-native";
import { Text } from "@/components/ui/text";
import { resolveTab } from "@/lib/page-format";
import { clampSpan, gapPx, gridColumns, gridItemWidth, isStatsOnly } from "@/lib/page-layout";
import { pickTabChildren, tabCount } from "@/lib/page-tabs";
import { cardLook, SECTION_TITLE, stackGap } from "@/lib/page-views";
import { type Of, type RenderedChild, usePageTheme } from "./page-theme";

/** Layout: section, grid, stack, card, tabs e divider. Os filhos já chegam desenhados (o desenho é recursivo). */

export function SectionNode({ node, children }: { node: Of<"section">; children: RenderedChild[] }) {
	const { title, description } = node.props;
	const { surface } = usePageTheme();
	return (
		<View accessibilityRole="summary" className="min-w-0 gap-4">
			{title || description ? (
				<View className="gap-1">
					{title ? (
						<Text accessibilityRole="header" className="font-semibold tracking-tight" numberOfLines={3} style={{ fontSize: SECTION_TITLE.size, lineHeight: SECTION_TITLE.lineHeight }}>
							{title}
						</Text>
					) : null}
					{description ? (
						<Text className="text-control" numberOfLines={6} style={{ color: surface.muted }}>
							{description}
						</Text>
					) : null}
				</View>
			) : null}
			<View className="min-w-0" style={{ gap: 12 }}>
				{children.map((child) => (
					<View key={child.node.id} className="min-w-0">
						{child.element}
					</View>
				))}
			</View>
		</View>
	);
}

/**
 * Grade por flex-wrap com a largura de cada item calculada da largura MEDIDA da própria grade (`onLayout`): o RN não tem
 * container queries. Antes da primeira medida fica invisível (evita piscar uma coluna e depois duas). Grade só de métricas
 * (2 colunas no celular, sem caixa) ganha mais ar entre as linhas.
 */
export function GridNode({ node, children }: { node: Of<"grid">; children: RenderedChild[] }) {
	const [width, setWidth] = React.useState(0);
	const statsOnly = isStatsOnly(children.map((child) => child.node.type));
	const gap = gapPx(node.props.gap);
	const rowGap = statsOnly ? Math.max(gap, 24) : gap;
	const columnGap = statsOnly ? Math.max(gap, 16) : gap;
	const columns = gridColumns(node.props.cols, width, statsOnly);
	return (
		<View
			className="min-w-0 flex-row flex-wrap"
			style={{ rowGap, columnGap, opacity: width > 0 ? 1 : 0 }}
			onLayout={(event) => {
				const next = Math.floor(event.nativeEvent.layout.width);
				setWidth((previous) => (previous === next ? previous : next));
			}}
		>
			{children.map((child) => {
				const span = clampSpan("span" in child.node.props ? child.node.props.span : undefined, columns);
				return (
					<View key={child.node.id} style={{ width: width > 0 ? gridItemWidth(width, columns, columnGap, span) : "100%" }}>
						{child.element}
					</View>
				);
			})}
		</View>
	);
}

/** Pilha: vertical (padrão; entre seções o espaço é maior) ou em linha com quebra (cada filho com largura mínima, para não espremer no celular). */
export function StackNode({ node, children }: { node: Of<"stack">; children: RenderedChild[] }) {
	const gap = node.props.direction === "horizontal" ? gapPx(node.props.gap) : stackGap(node.props.gap, children.map((child) => child.node.type));
	if (node.props.direction === "horizontal") {
		return (
			<View className="min-w-0 flex-row flex-wrap items-start" style={{ gap }}>
				{children.map((child) => (
					<View key={child.node.id} className="min-w-0" style={{ flexGrow: 1, flexBasis: 150 }}>
						{child.element}
					</View>
				))}
			</View>
		);
	}
	return (
		<View className="min-w-0" style={{ gap }}>
			{children.map((child) => (
				<View key={child.node.id} className="min-w-0">
					{child.element}
				</View>
			))}
		</View>
	);
}

/** Cartão do web: cantos de 14, contorno suave (`border-border/60`), fundo do cartão, título de 15 em negrito. Com `tone`, fundo e borda do tom e faixa à esquerda. */
export function CardNode({ node, children }: { node: Of<"card">; children: RenderedChild[] }) {
	const look = cardLook(node.props);
	const { surface, tone: toneOf } = usePageTheme();
	const colors = look.tone ? toneOf(look.tone) : null;
	return (
		<View
			className="min-w-0 gap-3"
			style={[
				{ borderRadius: 14 },
				look.padded ? { padding: 14 } : null,
				look.fill === "card" ? { backgroundColor: surface.card } : null,
				look.fill === "muted" ? { backgroundColor: surface.soft } : null,
				look.border ? { borderWidth: 1, borderColor: surface.edge } : null,
				colors ? { backgroundColor: colors.soft, borderWidth: 1, borderColor: colors.edge, borderLeftWidth: 3, borderLeftColor: colors.fill } : null,
			]}
		>
			{node.props.title ? (
				<Text accessibilityRole="header" className="text-control font-semibold" numberOfLines={3}>
					{node.props.title}
				</Text>
			) : null}
			{children.map((child) => (
				<View key={child.node.id} className="min-w-0">
					{child.element}
				</View>
			))}
		</View>
	);
}

/**
 * Abas sublinhadas (o print do dono): rótulo, contagem cinza ao lado quando o conteúdo da aba é uma lista contável, e
 * um traço embaixo da ativa sobre um fio que vai de ponta a ponta. A aba escolhida é estado local (não vai ao servidor
 * nem à conversa); só o conteúdo da aba ativa é montado. Aba pedida que não existe cai na primeira (`resolveTab`).
 */
export function TabsNode({ node, children }: { node: Of<"tabs">; children: RenderedChild[] }) {
	const tabs = node.props.tabs;
	const [active, setActive] = React.useState(() => resolveTab(tabs, undefined).id);
	const current = resolveTab(tabs, active).id;
	const { surface } = usePageTheme();
	const counts = React.useMemo(() => tabs.map((entry) => tabCount(children, entry.id)), [tabs, children]);
	return (
		<View className="min-w-0 gap-4">
			<View style={{ borderBottomWidth: 1, borderBottomColor: surface.edge }}>
				<ScrollView horizontal showsHorizontalScrollIndicator={false} accessibilityRole="tablist" contentContainerStyle={{ gap: 24 }} className="flex-grow-0">
					{tabs.map((entry, index) => {
						const selected = entry.id === current;
						const count = counts[index];
						return (
							<Pressable
								key={entry.id}
								role="tab"
								accessibilityState={{ selected }}
								accessibilityLabel={count === null || count === undefined ? entry.label : `${entry.label}, ${count}`}
								onPress={() => setActive(entry.id)}
								hitSlop={{ top: 6, bottom: 6 }}
								className="min-h-11 flex-row items-center gap-1.5 active:opacity-70"
								style={{ borderBottomWidth: 2, borderBottomColor: selected ? surface.foreground : "transparent", marginBottom: -1 }}
							>
								<Text className="text-control font-medium" numberOfLines={1} style={{ color: selected ? surface.foreground : surface.muted }}>
									{entry.label}
								</Text>
								{count === null || count === undefined ? null : (
									<Text className="text-control" style={{ color: surface.muted, fontVariant: ["tabular-nums"] }}>
										{count}
									</Text>
								)}
							</Pressable>
						);
					})}
				</ScrollView>
			</View>
			{pickTabChildren(children, current).map((child) => (
				<View key={child.node.id} className="min-w-0">
					{child.element}
				</View>
			))}
		</View>
	);
}

/** Conteúdo de uma aba: os filhos empilhados (o `TabsNode` escolhe qual aba mostrar). */
export function TabNode({ children }: { children: RenderedChild[] }) {
	return (
		<View className="min-w-0 gap-4">
			{children.map((child) => (
				<View key={child.node.id} className="min-w-0">
					{child.element}
				</View>
			))}
		</View>
	);
}

export function DividerNode() {
	const { surface } = usePageTheme();
	return <View style={{ height: 1, backgroundColor: surface.edge }} />;
}
