import { View } from "react-native";
import { Text } from "@/components/ui/text";
import { statView } from "@/lib/page-views";
import { type Of, usePageTheme } from "./page-theme";

/**
 * Métrica sem caixa (como no print do dono): o número grande e a legenda cinza embaixo; a variação, se houver, vai logo
 * abaixo (seta e sinal além da cor). O tom colore o número. O valor encolhe para caber em vez de quebrar.
 */
export function StatNode({ node }: { node: Of<"stat"> }) {
	const view = statView(node.props);
	const { surface, tone: toneOf } = usePageTheme();
	return (
		// `flexGrow`: as métricas de uma linha da grade ficam com a mesma altura.
		<View accessible accessibilityLabel={view.accessibilityLabel} className="min-w-0 gap-0.5" style={{ flexGrow: 1 }}>
			<Text
				numberOfLines={1}
				adjustsFontSizeToFit
				minimumFontScale={0.6}
				className="font-semibold tracking-tight"
				style={{ fontSize: view.fontSize, lineHeight: view.fontSize + 6, fontVariant: ["tabular-nums"], ...(view.tone ? { color: toneOf(view.tone).text } : null) }}
			>
				{view.value}
			</Text>
			<Text className="text-body" numberOfLines={2} style={{ color: surface.muted }}>
				{view.label}
			</Text>
			{view.delta ? (
				<Text className="text-caption" numberOfLines={1} style={{ color: toneOf(view.delta.tone).text, fontVariant: ["tabular-nums"] }}>
					{view.delta.text}
				</Text>
			) : null}
		</View>
	);
}
