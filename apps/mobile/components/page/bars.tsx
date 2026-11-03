import { View } from "react-native";
import { Text } from "@/components/ui/text";
import { barPercent, currencyDigits, formatPageNumber } from "@/lib/page-format";
import { type Of, usePageTheme } from "./page-theme";

/** Trilho e preenchimento de uma barra; a largura é uma porcentagem já calculada (`barPercent`, de 0 a 100). */
function Bar({ percent, color, track, height }: { percent: number; color: string; track: string; height: number }) {
	return (
		<View className="overflow-hidden rounded-full" style={{ height, backgroundColor: track }}>
			<View className="h-full rounded-full" style={{ width: `${percent}%`, backgroundColor: color }} />
		</View>
	);
}

/** Lista de barras: a barra usa o tom (destaque por padrão), nunca preto/branco. Números no mesmo formato. */
export function BarListNode({ node }: { node: Of<"bar_list"> }) {
	const { items, unit, format, tone = "accent" } = node.props;
	const { surface, tone: toneOf } = usePageTheme();
	const max = Math.max(0, ...items.map((item) => item.value));
	const digits = currencyDigits(items.map((item) => item.value));
	const colors = toneOf(tone);
	return (
		<View className="min-w-0 gap-3">
			{items.map((item, index) => {
				const shown = item.display ?? formatPageNumber(item.value, { unit, format, digits });
				return (
					<View key={`${item.label}-${index}`} accessible accessibilityLabel={`${item.label}: ${shown}`} className="min-w-0 gap-1">
						<View className="min-w-0 flex-row items-baseline justify-between gap-3">
							<Text className="min-w-0 shrink" numberOfLines={1}>
								{item.label}
							</Text>
							<Text className="shrink-0 font-medium" style={{ fontVariant: ["tabular-nums"] }}>
								{shown}
							</Text>
						</View>
						<Bar percent={barPercent(item.value, max)} color={colors.fill} track={surface.edge} height={8} />
					</View>
				);
			})}
		</View>
	);
}

/** Meta atingida: "R$ 62.000 de R$ 100.000 · 62%" com a barra no tom do nó. */
export function ProgressNode({ node }: { node: Of<"progress"> }) {
	const { label, value, max, unit, format, tone = "accent" } = node.props;
	const { surface, tone: toneOf } = usePageTheme();
	const digits = currencyDigits([value, max]);
	const percent = Math.round((value / max) * 100);
	const base = { unit, format, digits };
	return (
		<View
			accessibilityRole="progressbar"
			accessibilityLabel={label}
			accessibilityValue={{ min: 0, max, now: Math.min(value, max) }}
			className="min-w-0 gap-1"
		>
			<View className="min-w-0 flex-row items-baseline justify-between gap-3">
				<Text className="min-w-0 shrink font-medium" numberOfLines={1}>
					{label}
				</Text>
				<Text className="shrink-0 font-semibold" style={{ fontVariant: ["tabular-nums"] }}>{`${Number.isFinite(percent) ? percent : 0}%`}</Text>
			</View>
			<Bar percent={barPercent(value, max)} color={toneOf(tone).fill} track={surface.edge} height={10} />
			<Text variant="muted" className="text-caption" numberOfLines={1} style={{ fontVariant: ["tabular-nums"] }}>
				{`${formatPageNumber(value, base)} de ${formatPageNumber(max, base)}`}
			</Text>
		</View>
	);
}
