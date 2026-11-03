import * as React from "react";
import { Pressable, ScrollView, View } from "react-native";
import { Text } from "@/components/ui/text";
import { resolveTab } from "@/lib/page-format";
import { clampSpan, gapPx, gridColumns, gridItemWidth, isStatsOnly } from "@/lib/page-layout";
import { pickTabChildren } from "@/lib/page-tabs";
import { type Of, type RenderedChild, usePageTheme } from "./page-theme";

/** Layout: section, grid, stack, card e divider. Os filhos já chegam desenhados (o desenho é recursivo). */

export function SectionNode({ node, children }: { node: Of<"section">; children: RenderedChild[] }) {
	const { title, description } = node.props;
	return (
		<View accessibilityRole="summary" className="min-w-0 gap-3">
			{title || description ? (
				<View className="gap-0.5">
					{title ? (
						<Text accessibilityRole="header" variant="heading" numberOfLines={3}>
							{title}
						</Text>
					) : null}
					{description ? (
						<Text variant="muted" numberOfLines={6}>
							{description}
						</Text>
					) : null}
				</View>
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
 * Grade por flex-wrap com a largura de cada item calculada da largura MEDIDA da própria grade (`onLayout`): o RN não tem
 * container queries. Antes da primeira medida fica invisível (evita piscar uma coluna e depois duas).
 */
export function GridNode({ node, children }: { node: Of<"grid">; children: RenderedChild[] }) {
	const [width, setWidth] = React.useState(0);
	const gap = gapPx(node.props.gap);
	const columns = gridColumns(node.props.cols, width, isStatsOnly(children.map((child) => child.node.type)));
	return (
		<View
			className="min-w-0 flex-row flex-wrap"
			style={{ gap, opacity: width > 0 ? 1 : 0 }}
			onLayout={(event) => {
				const next = Math.floor(event.nativeEvent.layout.width);
				setWidth((previous) => (previous === next ? previous : next));
			}}
		>
			{children.map((child) => {
				const span = clampSpan("span" in child.node.props ? child.node.props.span : undefined, columns);
				return (
					<View key={child.node.id} style={{ width: width > 0 ? gridItemWidth(width, columns, gap, span) : "100%" }}>
						{child.element}
					</View>
				);
			})}
		</View>
	);
}

/** Pilha: vertical (padrão) ou em linha com quebra (cada filho com largura mínima, para não espremer no celular). */
export function StackNode({ node, children }: { node: Of<"stack">; children: RenderedChild[] }) {
	const gap = gapPx(node.props.gap);
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

export function CardNode({ node, children }: { node: Of<"card">; children: RenderedChild[] }) {
	const { title, variant = "outlined", tone } = node.props;
	const { surface, tone: toneOf } = usePageTheme();
	const colors = tone && tone !== "neutral" ? toneOf(tone) : null;
	const padded = variant !== "plain";
	return (
		<View
			className="min-w-0 gap-3 rounded-card"
			style={[
				padded ? { padding: 14 } : null,
				variant === "outlined" ? { backgroundColor: surface.card, borderWidth: 1, borderColor: surface.edge } : null,
				variant === "filled" ? { backgroundColor: surface.card } : null,
				colors ? { backgroundColor: colors.soft, borderLeftWidth: 3, borderLeftColor: colors.fill } : null,
			]}
		>
			{title ? (
				<Text accessibilityRole="header" variant="heading" numberOfLines={3}>
					{title}
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
 * Abas roláveis no topo da seção. A aba escolhida é estado local (não vai ao servidor nem à conversa); só o conteúdo da
 * aba ativa é montado. Aba pedida que não existe cai na primeira (`resolveTab`).
 */
export function TabsNode({ node, children }: { node: Of<"tabs">; children: RenderedChild[] }) {
	const tabs = node.props.tabs;
	const [active, setActive] = React.useState(() => resolveTab(tabs, undefined).id);
	const current = resolveTab(tabs, active).id;
	const { surface, tone } = usePageTheme();
	const accent = tone("accent");
	return (
		<View className="min-w-0 gap-3">
			<ScrollView horizontal showsHorizontalScrollIndicator={false} accessibilityRole="tablist" contentContainerStyle={{ gap: 8 }} className="flex-grow-0">
				{tabs.map((entry) => {
					const selected = entry.id === current;
					return (
						<Pressable
							key={entry.id}
							role="tab"
							accessibilityState={{ selected }}
							onPress={() => setActive(entry.id)}
							className="min-h-9 justify-center rounded-full px-4 active:opacity-80"
							style={{ backgroundColor: selected ? accent.soft : surface.card, borderWidth: 1, borderColor: selected ? accent.edge : surface.edge }}
						>
							<Text className="text-control font-medium" numberOfLines={1} style={selected ? { color: accent.text } : undefined}>
								{entry.label}
							</Text>
						</Pressable>
					);
				})}
			</ScrollView>
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
