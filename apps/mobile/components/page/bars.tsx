import { View } from "react-native";
import { Text } from "@/components/ui/text";
import { barListView, progressView } from "@/lib/page-views";
import { type Of, usePageTheme } from "./page-theme";

/** Trilho (`bg-muted`) e preenchimento de uma barra; a largura é uma porcentagem já calculada (0 a 100). */
function Bar({ percent, color, track, height }: { percent: number; color: string; track: string; height: number }) {
	return (
		<View className="overflow-hidden rounded-full" style={{ height, backgroundColor: track }}>
			<View className="h-full rounded-full" style={{ width: `${percent}%`, backgroundColor: color }} />
		</View>
	);
}

/** Lista de barras: a barra usa o tom (destaque da paleta por padrão), nunca preto/branco. Números no mesmo formato. */
export function BarListNode({ node }: { node: Of<"bar_list"> }) {
	const view = barListView(node.props);
	const { surface, tone: toneOf } = usePageTheme();
	const colors = toneOf(view.tone);
	return (
		<View className="min-w-0 gap-3">
			{view.rows.map((row, index) => (
				<View key={`${row.label}-${index}`} accessible accessibilityLabel={`${row.label}: ${row.shown}`} className="min-w-0 gap-1.5">
					<View className="min-w-0 flex-row items-baseline justify-between gap-3">
						<Text className="min-w-0 shrink text-control" numberOfLines={1}>
							{row.label}
						</Text>
						<Text className="shrink-0 text-control font-medium" style={{ fontVariant: ["tabular-nums"] }}>
							{row.shown}
						</Text>
					</View>
					<Bar percent={row.percent} color={colors.fill} track={surface.track} height={8} />
				</View>
			))}
		</View>
	);
}

/** Meta atingida: "62%" com a barra no tom do nó e "R$ 62.000 de R$ 100.000" embaixo. */
export function ProgressNode({ node }: { node: Of<"progress"> }) {
	const view = progressView(node.props);
	const { surface, tone: toneOf } = usePageTheme();
	return (
		<View accessibilityRole="progressbar" accessibilityLabel={view.label} accessibilityValue={{ min: 0, max: view.max, now: view.now }} className="min-w-0 gap-1.5">
			<View className="min-w-0 flex-row items-baseline justify-between gap-3">
				<Text className="min-w-0 shrink text-control font-medium" numberOfLines={1}>
					{view.label}
				</Text>
				<Text className="shrink-0 text-control font-semibold" style={{ fontVariant: ["tabular-nums"] }}>
					{view.percentText}
				</Text>
			</View>
			<Bar percent={view.percent} color={toneOf(view.tone).fill} track={surface.track} height={10} />
			<Text className="text-body" numberOfLines={1} style={{ color: surface.muted, fontVariant: ["tabular-nums"] }}>
				{view.detail}
			</Text>
		</View>
	);
}
