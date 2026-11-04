import { Canvas, Group, Path, Skia } from "@shopify/react-native-skia";
import * as React from "react";
import { View } from "react-native";
import { Text } from "@/components/ui/text";
import { funnelGeometry } from "@/lib/chart-data";
import { useEntrance } from "./chart-env";
import type { ChartPlotProps } from "./chart-types";

const STAGE = 30;
const TEXT_ROW = 22;
const GAP = 12;

/** Funil vertical: por etapa uma linha com nome, valor e % (a primeira = 100%) e, embaixo, o trapézio centrado cuja largura segue o valor. */
export function FunnelPlot({ spec, theme, width }: ChartPlotProps) {
	const entrance = useEntrance();
	const inner = Math.max(120, width - 8);
	const stages = React.useMemo(() => funnelGeometry(spec, inner, STAGE, TEXT_ROW + GAP), [spec, inner]);
	const height = stages.length * (STAGE + TEXT_ROW + GAP) - GAP;
	const paths = React.useMemo(
		() =>
			stages.map((stage) => {
				const path = Skia.PathBuilder.Make();
				const y = stage.top + TEXT_ROW;
				const left = (inner - stage.topWidth) / 2;
				const bottomLeft = (inner - stage.bottomWidth) / 2;
				path.moveTo(left, y);
				path.lineTo(left + stage.topWidth, y);
				path.lineTo(bottomLeft + stage.bottomWidth, y + STAGE);
				path.lineTo(bottomLeft, y + STAGE);
				path.close();
				return path.detach();
			}),
		[stages, inner],
	);
	return (
		<View className="items-center py-1" style={{ height }}>
			<View style={{ width: inner, height }}>
				<Canvas style={{ width: inner, height }}>
					<Group opacity={entrance}>
						{paths.map((path, index) => (
							<Path key={stages[index]!.label + index} path={path} color={theme.colors.series[0]} opacity={stages[index]!.opacity} />
						))}
					</Group>
				</Canvas>
				{stages.map((stage, index) => (
					<View key={stage.label + index} accessible accessibilityLabel={`${stage.label}: ${stage.valueText}, ${stage.percentText}`} pointerEvents="none" className="absolute inset-x-0 flex-row items-baseline gap-2" style={{ top: stage.top, height: TEXT_ROW }}>
						<Text className="min-w-0 flex-1 text-body" numberOfLines={1} style={{ color: theme.label }}>
							{stage.label}
						</Text>
						<Text className="text-body font-medium" style={{ fontVariant: ["tabular-nums"] }}>
							{stage.valueText}
						</Text>
						<Text className="w-10 text-right text-body" style={{ color: theme.label, fontVariant: ["tabular-nums"] }}>
							{stage.percentText}
						</Text>
					</View>
				))}
			</View>
		</View>
	);
}
