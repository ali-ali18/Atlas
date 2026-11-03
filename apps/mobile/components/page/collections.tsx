import * as React from "react";
import { Pressable, View } from "react-native";
import { ChevronDownIcon, ChevronUpIcon } from "@/components/icons";
import { Text } from "@/components/ui/text";
import { hexAlpha } from "@/lib/color-math";
import { kanbanLayout } from "@/lib/page-layout";
import { type KanbanColumnView, kanbanView, listView, timelineView } from "@/lib/page-views";
import { type Of, usePageTheme } from "./page-theme";

/** Linha do tempo vertical (vencimentos, marcos): data à esquerda, ponto no tom, fio ligando os itens e o texto. */
export function TimelineNode({ node }: { node: Of<"timeline"> }) {
	const rows = timelineView(node.props);
	const { surface, tone: toneOf } = usePageTheme();
	return (
		<View className="min-w-0">
			{rows.map((row, index) => {
				const colors = toneOf(row.tone);
				return (
					<View key={`${row.date}-${index}`} accessible accessibilityLabel={[row.date, row.title, row.text].filter(Boolean).join(", ")} className="min-w-0 flex-row gap-3">
						<Text className="w-14 pt-0.5 text-right text-body" numberOfLines={2} style={{ color: surface.muted, fontVariant: ["tabular-nums"] }}>
							{row.date}
						</Text>
						<View className="w-3 items-center">
							<View className="mt-1.5 rounded-full" style={{ width: 9, height: 9, backgroundColor: colors.fill }} />
							{row.last ? null : <View className="mt-1 flex-1" style={{ width: 1, backgroundColor: surface.edge }} />}
						</View>
						<View className="min-w-0 flex-1 gap-0.5" style={{ paddingBottom: row.last ? 0 : 16 }}>
							<Text className="text-control font-medium" numberOfLines={3}>
								{row.title}
							</Text>
							{row.text ? (
								<Text className="text-body" numberOfLines={6} style={{ color: surface.muted }}>
									{row.text}
								</Text>
							) : null}
						</View>
					</View>
				);
			})}
		</View>
	);
}

function KanbanColumn({ column, collapsible }: { column: KanbanColumnView; collapsible: boolean }) {
	const { surface } = usePageTheme();
	const [open, setOpen] = React.useState(true);
	const expanded = !collapsible || open;
	const header = (
		<View className="min-w-0 flex-row items-center justify-between gap-2">
			<Text className="min-w-0 shrink text-body font-medium" numberOfLines={1}>
				{column.title}
			</Text>
			<View className="shrink-0 flex-row items-center gap-1.5">
				<Text className="text-body" style={{ color: surface.muted, fontVariant: ["tabular-nums"] }}>
					{column.count}
				</Text>
				{collapsible ? expanded ? <ChevronUpIcon size={16} /> : <ChevronDownIcon size={16} /> : null}
			</View>
		</View>
	);
	return (
		<View className="min-w-0 p-2.5" style={{ borderRadius: 14, backgroundColor: surface.soft }}>
			{collapsible ? (
				<Pressable role="button" accessibilityState={{ expanded }} accessibilityLabel={`${column.title}, ${column.count}`} onPress={() => setOpen((value) => !value)} hitSlop={6} className="min-h-8 justify-center active:opacity-70">
					{header}
				</Pressable>
			) : (
				header
			)}
			{expanded ? (
				<View className="mt-2 gap-2">
					{column.count === 0 ? (
						<Text className="py-2 text-center text-body" style={{ color: surface.muted }}>
							Nada aqui.
						</Text>
					) : null}
					{column.items.map((item, index) => (
						<View key={`${item.title}-${index}`} accessible className="min-w-0 gap-1 px-2.5 py-2" style={{ borderRadius: 10, backgroundColor: surface.card, borderWidth: 1, borderColor: surface.edge }}>
							<Text className="text-body font-medium" numberOfLines={3}>
								{item.title}
							</Text>
							{item.subtitle ? (
								<Text className="text-caption" numberOfLines={3} style={{ color: surface.muted }}>
									{item.subtitle}
								</Text>
							) : null}
							{item.badge ? (
								<View className="max-w-full flex-row self-start rounded-full px-2 py-0.5" style={{ backgroundColor: hexAlpha(surface.muted, 0.2) }}>
									<Text className="text-caption" numberOfLines={1}>
										{item.badge}
									</Text>
								</View>
							) : null}
						</View>
					))}
				</View>
			) : null}
		</View>
	);
}

/**
 * Colunas por status. No celular empilham, cada uma recolhível (com a contagem) e nada fica cortado na borda; em
 * tablet e paisagem ficam lado a lado e o título deixa de ser um botão.
 */
export function KanbanNode({ node }: { node: Of<"kanban"> }) {
	const [width, setWidth] = React.useState(0);
	const side = kanbanLayout(width) === "columns";
	const columns = kanbanView(node.props);
	return (
		<View
			className={side ? "min-w-0 flex-row items-start gap-3" : "min-w-0 gap-2.5"}
			onLayout={(event) => {
				const next = Math.floor(event.nativeEvent.layout.width);
				setWidth((previous) => (previous === next ? previous : next));
			}}
		>
			{columns.map((column, index) => (
				<View key={`${column.title}-${index}`} className={side ? "min-w-0 flex-1" : "min-w-0"}>
					<KanbanColumn column={column} collapsible={!side} />
				</View>
			))}
		</View>
	);
}

/** Lista de itens: título e detalhe à esquerda, valor à direita no mesmo formato; fios finos entre as linhas (o cartão com marcadores do print). */
export function ListNode({ node }: { node: Of<"list"> }) {
	const rows = listView(node.props);
	const { surface, tone: toneOf } = usePageTheme();
	return (
		<View className="min-w-0 overflow-hidden" style={{ borderRadius: 10, borderWidth: 1, borderColor: surface.edge }}>
			{rows.map((row, index) => (
				<View key={`${row.title}-${index}`} accessible className="min-w-0 flex-row items-center justify-between gap-3 px-3.5 py-3" style={index > 0 ? { borderTopWidth: 1, borderTopColor: surface.edge } : undefined}>
					<View className="min-w-0 shrink gap-0.5">
						<Text className="text-control" numberOfLines={2}>
							{row.title}
						</Text>
						{row.subtitle ? (
							<Text className="text-body" numberOfLines={2} style={{ color: surface.muted }}>
								{row.subtitle}
							</Text>
						) : null}
					</View>
					{row.valueText !== null ? (
						<Text className="shrink-0 text-control font-medium" style={{ fontVariant: ["tabular-nums"], ...(row.tone ? { color: toneOf(row.tone).text } : null) }}>
							{row.valueText}
						</Text>
					) : null}
				</View>
			))}
		</View>
	);
}
