import * as React from "react";
import { View } from "react-native";
import { Text } from "@/components/ui/text";
import { CHART_DRAWING_OF, CHART_OWN_A11Y, chartA11yLabel, describeReference } from "@/lib/chart-data";
import { colorsForChart } from "@/lib/chart-palette";
import { hexAlpha } from "@/lib/color-math";
import { chartTheme } from "./charts/chart-env";
import { CHART_DRAWINGS } from "./charts/chart-drawings";
import { type Of, usePageTheme } from "./page-theme";

/**
 * Gráfico do painel, desenhado no próprio app (Victory Native XL sobre o Skia; rosca, radar, funil e medidor direto em
 * Skia). Moldura do web: cartão suave (`bg-muted/60`, cantos grandes), título à esquerda, o gráfico, a legenda das séries
 * (só quando há mais de uma e o desenho não tem legenda própria) e a legenda da meta. A paleta do gráfico vence a do painel.
 */
export function ChartNode({ node }: { node: Of<"chart"> }) {
	const { scheme, chartColors, surface } = usePageTheme();
	const spec = node.props.spec;
	const [width, setWidth] = React.useState(0);
	const colors = React.useMemo(() => colorsForChart(scheme, spec, chartColors), [scheme, spec, chartColors]);
	const theme = React.useMemo(() => chartTheme(scheme, colors), [scheme, colors]);
	const Drawing = CHART_DRAWINGS[CHART_DRAWING_OF[spec.type]];
	const reference = describeReference(spec);
	const drawing = CHART_DRAWING_OF[spec.type];
	const showLegend = spec.series.length > 1 && (drawing === "cartesian" || drawing === "bar");
	return (
		<View className="min-w-0 overflow-hidden pb-3" style={{ backgroundColor: hexAlpha(surface.track, 0.6), borderRadius: 18 }}>
			<View className="min-h-9 justify-center pl-3 pr-2 pt-1.5">
				<Text className="text-sm font-medium" style={{ opacity: 0.9 }} numberOfLines={1}>
					{spec.title ?? ""}
				</Text>
			</View>
			<View className="px-2" accessible={!CHART_OWN_A11Y.has(drawing)} accessibilityRole={CHART_OWN_A11Y.has(drawing) ? undefined : "image"} accessibilityLabel={CHART_OWN_A11Y.has(drawing) ? undefined : chartA11yLabel(spec)} onLayout={(event) => setWidth(Math.floor(event.nativeEvent.layout.width))}>
				{width > 0 ? <Drawing spec={spec} theme={theme} width={width} /> : null}
				{reference ? (
					<View className="mt-1 flex-row items-center gap-1.5 px-1">
						<View className="rounded-sm border border-dashed" style={{ width: 16, height: 10, borderColor: theme.label, backgroundColor: hexAlpha(theme.label, 0.2) }} />
						<Text className="min-w-0 flex-1 text-body" numberOfLines={1} style={{ color: theme.label }}>
							{reference}
						</Text>
					</View>
				) : null}
				{showLegend ? (
					<View className="mt-2 flex-row flex-wrap items-center gap-x-4 gap-y-1 px-1">
						{spec.series.map((item, index) => (
							<View key={item.key} className="min-w-0 flex-row items-center gap-1.5">
								<View className="size-2 rounded-full" style={{ backgroundColor: colors.series[index % 6] }} />
								<Text className="text-body" style={{ color: theme.label }} numberOfLines={1}>
									{item.label}
								</Text>
							</View>
						))}
					</View>
				) : null}
			</View>
		</View>
	);
}
