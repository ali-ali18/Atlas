import { View } from "react-native";
import { Text } from "@/components/ui/text";
import { DELTA_TONE, formatPageDelta, formatPageValue } from "@/lib/page-format";
import { statFontSize } from "@/lib/page-layout";
import { type Of, usePageTheme } from "./page-theme";

const VALUE_SIZE = { sm: 20, md: 26, lg: 34 } as const;

/**
 * KPI. Rótulo e variação em UMA linha (truncados), o valor encolhe para caber (`adjustsFontSizeToFit`) em vez de
 * quebrar. O tom colore o valor; a variação leva seta e sinal, então a cor não é a única pista.
 */
export function StatNode({ node }: { node: Of<"stat"> }) {
	const { label, value, unit, format, delta, size = "md", tone } = node.props;
	const { surface, tone: toneOf } = usePageTheme();
	const shown = formatPageValue(value, { unit, format });
	const fontSize = statFontSize(VALUE_SIZE[size], shown.length);
	const deltaText = delta ? formatPageDelta(delta, { unit, format }) : null;
	return (
		<View
			accessible
			accessibilityLabel={[label, shown, deltaText].filter(Boolean).join(", ")}
			className="min-w-0 gap-1 rounded-card px-3 py-2.5"
			// `flexGrow` (sem basis 0): os tiles de uma linha da grade ficam com a mesma altura, sem colapsar numa pilha de altura automática.
			style={{ flexGrow: 1, backgroundColor: surface.card, borderWidth: 1, borderColor: surface.edge }}
		>
			<Text variant="muted" className="text-caption" numberOfLines={1}>
				{label}
			</Text>
			<Text
				numberOfLines={1}
				adjustsFontSizeToFit
				minimumFontScale={0.6}
				className="font-semibold"
				style={{ fontSize, lineHeight: fontSize + 6, fontVariant: ["tabular-nums"], ...(tone ? { color: toneOf(tone).text } : null) }}
			>
				{shown}
			</Text>
			{deltaText && delta ? (
				<Text className="text-caption" numberOfLines={1} style={{ color: toneOf(DELTA_TONE[delta.direction]).text, fontVariant: ["tabular-nums"] }}>
					{deltaText}
				</Text>
			) : null}
		</View>
	);
}
