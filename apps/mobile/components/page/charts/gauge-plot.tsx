import { Canvas, Group, Path, Skia } from "@shopify/react-native-skia";
import * as React from "react";
import { View } from "react-native";
import { Text } from "@/components/ui/text";
import { gaugeNotches, gaugeRatio, gaugeText } from "@/lib/chart-data";
import { hexAlpha } from "@/lib/color-math";
import { useEntrance } from "./chart-env";
import type { ChartPlotProps } from "./chart-types";

const SIZE = 240;
const OUTER = 112;
const LENGTH = 22;

/** Medidor em arco de 270° com 40 entalhes (como o do web): os preenchidos na cor da série, o resto a 40%; o valor no centro. */
export function GaugePlot({ spec, theme }: ChartPlotProps) {
	const entrance = useEntrance();
	const ratio = gaugeRatio(spec);
	const color = theme.colors.series[0];
	const { active, inactive } = React.useMemo(() => {
		const on = Skia.PathBuilder.Make();
		const off = Skia.PathBuilder.Make();
		for (const notch of gaugeNotches(ratio)) {
			const radians = (notch.angle * Math.PI) / 180;
			const path = notch.active ? on : off;
			path.moveTo(SIZE / 2 + Math.cos(radians) * (OUTER - LENGTH), SIZE / 2 + Math.sin(radians) * (OUTER - LENGTH));
			path.lineTo(SIZE / 2 + Math.cos(radians) * OUTER, SIZE / 2 + Math.sin(radians) * OUTER);
		}
		return { active: on.detach(), inactive: off.detach() };
	}, [ratio]);
	const item = spec.series[0]!;
	return (
		<View className="items-center py-2">
			<View accessible accessibilityRole="progressbar" accessibilityLabel={`${item.label}: ${gaugeText(spec)}`} accessibilityValue={{ min: 0, max: 100, now: Math.round(ratio * 100) }} style={{ width: SIZE, height: SIZE }}>
				<Canvas style={{ width: SIZE, height: SIZE }}>
					<Path path={inactive} style="stroke" strokeWidth={5} strokeCap="round" color={hexAlpha(color, 0.4)} />
					<Group opacity={entrance}>
						<Path path={active} style="stroke" strokeWidth={5} strokeCap="round" color={color} />
					</Group>
				</Canvas>
				<View pointerEvents="none" className="absolute inset-0 items-center justify-center">
					<Text className="text-3xl font-semibold" style={{ fontVariant: ["tabular-nums"] }}>
						{gaugeText(spec)}
					</Text>
					<Text className="text-body" style={{ color: theme.label }} numberOfLines={1}>
						{item.label}
					</Text>
				</View>
			</View>
		</View>
	);
}
