import * as React from "react";
import { Pressable, View } from "react-native";
import { ChevronDownIcon, ChevronUpIcon } from "@/components/icons";
import { Text } from "@/components/ui/text";
import { currencyDigits, formatPageValue } from "@/lib/page-format";
import { kanbanLayout } from "@/lib/page-layout";
import { type Of, usePageTheme } from "./page-theme";

/** Linha do tempo vertical (vencimentos, marcos): data à esquerda, ponto no tom, linha ligando os itens e o texto. */
export function TimelineNode({ node }: { node: Of<"timeline"> }) {
	const { items } = node.props;
	const { surface, tone: toneOf } = usePageTheme();
	return (
		<View className="min-w-0">
			{items.map((item, index) => {
				const colors = toneOf(item.tone ?? "accent");
				const last = index === items.length - 1;
				return (
					<View key={`${item.date}-${index}`} accessible accessibilityLabel={[item.date, item.title, item.text].filter(Boolean).join(", ")} className="min-w-0 flex-row gap-3">
						<Text variant="muted" className="w-14 pt-0.5 text-right text-caption" numberOfLines={2} style={{ fontVariant: ["tabular-nums"] }}>
							{item.date}
						</Text>
						<View className="w-3 items-center">
							<View className="mt-1.5 rounded-full" style={{ width: 9, height: 9, backgroundColor: colors.fill }} />
							{last ? null : <View className="mt-1 flex-1" style={{ width: 1, backgroundColor: surface.edge }} />}
						</View>
						<View className="min-w-0 flex-1 gap-0.5" style={{ paddingBottom: last ? 0 : 16 }}>
							<Text className="text-control font-medium" numberOfLines={3}>
								{item.title}
							</Text>
							{item.text ? (
								<Text variant="muted" numberOfLines={6}>
									{item.text}
								</Text>
							) : null}
						</View>
					</View>
				);
			})}
		</View>
	);
}

function KanbanColumn({ column, collapsible }: { column: Of<"kanban">["props"]["columns"][number]; collapsible: boolean }) {
	const { surface } = usePageTheme();
	const [open, setOpen] = React.useState(true);
	const expanded = !collapsible || open;
	const header = (
		<View className="min-w-0 flex-row items-center justify-between gap-2">
			<Text className="min-w-0 shrink font-medium" numberOfLines={1}>
				{column.title}
			</Text>
			<View className="shrink-0 flex-row items-center gap-1.5">
				<Text variant="muted" className="text-caption" style={{ fontVariant: ["tabular-nums"] }}>
					{column.items.length}
				</Text>
				{collapsible ? (expanded ? <ChevronUpIcon size={16} /> : <ChevronDownIcon size={16} />) : null}
			</View>
		</View>
	);
	return (
		<View className="min-w-0 rounded-card p-2.5" style={{ backgroundColor: surface.card, borderWidth: 1, borderColor: surface.edge }}>
			{collapsible ? (
				<Pressable role="button" accessibilityState={{ expanded }} accessibilityLabel={`${column.title}, ${column.items.length}`} onPress={() => setOpen((value) => !value)} hitSlop={6} className="min-h-8 justify-center active:opacity-70">
					{header}
				</Pressable>
			) : (
				header
			)}
			{expanded ? (
				<View className="mt-2 gap-2">
					{column.items.length === 0 ? (
						<Text variant="muted" className="py-2 text-center text-caption">
							Nada aqui.
						</Text>
					) : null}
					{column.items.map((item, index) => (
						<View key={`${item.title}-${index}`} accessible className="min-w-0 gap-1 rounded-lg px-2.5 py-2" style={{ backgroundColor: surface.screen, borderWidth: 1, borderColor: surface.edge }}>
							<Text className="font-medium" numberOfLines={3}>
								{item.title}
							</Text>
							{item.subtitle ? (
								<Text variant="muted" className="text-caption" numberOfLines={3}>
									{item.subtitle}
								</Text>
							) : null}
							{item.badge ? (
								<View className="max-w-full flex-row self-start rounded-full px-2 py-0.5" style={{ backgroundColor: surface.edge }}>
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
	return (
		<View
			className={side ? "min-w-0 flex-row items-start gap-3" : "min-w-0 gap-2.5"}
			onLayout={(event) => {
				const next = Math.floor(event.nativeEvent.layout.width);
				setWidth((previous) => (previous === next ? previous : next));
			}}
		>
			{node.props.columns.map((column, index) => (
				<View key={`${column.title}-${index}`} className={side ? "min-w-0 flex-1" : "min-w-0"}>
					<KanbanColumn column={column} collapsible={!side} />
				</View>
			))}
		</View>
	);
}

/** Lista de itens (ex.: top clientes): título e detalhe à esquerda, valor à direita no mesmo formato. */
export function ListNode({ node }: { node: Of<"list"> }) {
	const { items, unit, format } = node.props;
	const { surface, tone: toneOf } = usePageTheme();
	const digits = currencyDigits(items.map((item) => (typeof item.value === "number" ? item.value : null)));
	return (
		<View className="min-w-0 overflow-hidden rounded-card" style={{ borderWidth: 1, borderColor: surface.edge, backgroundColor: surface.card }}>
			{items.map((item, index) => (
				<View
					key={`${item.title}-${index}`}
					accessible
					className="min-w-0 flex-row items-center justify-between gap-3 px-3.5 py-2.5"
					style={index > 0 ? { borderTopWidth: 1, borderTopColor: surface.edge } : undefined}
				>
					<View className="min-w-0 shrink gap-0.5">
						<Text className="text-control" numberOfLines={1}>
							{item.title}
						</Text>
						{item.subtitle ? (
							<Text variant="muted" className="text-caption" numberOfLines={1}>
								{item.subtitle}
							</Text>
						) : null}
					</View>
					{item.value !== undefined ? (
						<Text className="shrink-0 font-medium" style={{ fontVariant: ["tabular-nums"], ...(item.tone ? { color: toneOf(item.tone).text } : null) }}>
							{formatPageValue(item.value, { unit, format, digits })}
						</Text>
					) : null}
				</View>
			))}
		</View>
	);
}
