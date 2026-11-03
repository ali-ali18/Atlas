import { View } from "react-native";
import { Text } from "@/components/ui/text";
import { currencyDigits, formatPageValue } from "@/lib/page-format";
import { type Of, usePageTheme } from "./page-theme";

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
