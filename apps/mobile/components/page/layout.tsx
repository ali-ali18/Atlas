import * as React from "react";
import { View } from "react-native";
import { Text } from "@/components/ui/text";
import { clampSpan, gapPx, gridColumns, gridItemWidth, isStatsOnly } from "@/lib/page-layout";
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

export function DividerNode() {
	const { surface } = usePageTheme();
	return <View style={{ height: 1, backgroundColor: surface.edge }} />;
}
