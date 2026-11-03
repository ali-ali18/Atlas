import { Canvas, Group, Path, Skia } from "@shopify/react-native-skia";
import * as React from "react";
import { Pressable, View } from "react-native";
import { Text } from "@/components/ui/text";
import { pieCenterText, pieShowsPercent, pieSliceAt, pieSlices } from "@/lib/chart-data";
import { useEntrance } from "./chart-env";
import type { ChartPlotProps } from "./chart-types";

const SIZE = 200;
const OUTER = 100;
const INNER = 64;
/** A rosca do web começa às 9 horas (o `startAngle` -π/2 do d3 é medido a partir das 12): a primeira fatia passa por cima. */
const START = 180;
/** Vão entre fatias (graus): o `padAngle` de 0,015 rad do web. */
const PAD = 0.86;

/** Rosca (ou pizza) em Skia: um arco por fatia, a primeira passando por cima como no web; tocar numa fatia mostra o valor dela no miolo, como o hover do web. */
export function PiePlot({ spec, theme }: ChartPlotProps) {
	const slices = React.useMemo(() => pieSlices(spec, theme.colors, theme.background), [spec, theme]);
	const entrance = useEntrance();
	const [active, setActive] = React.useState<number | null>(null);
	const total = slices.reduce((sum, slice) => sum + slice.value, 0);
	const mid = (OUTER + INNER) / 2;
	const arcs = React.useMemo(() => {
		let from = START;
		return slices.map((slice) => {
			const sweep = (slice.value / total) * 360;
			const path = Skia.PathBuilder.Make();
			const gap = slices.length > 1 ? Math.min(PAD, sweep / 3) : 0;
			path.addArc({ x: SIZE / 2 - mid, y: SIZE / 2 - mid, width: mid * 2, height: mid * 2 }, from + gap / 2, Math.max(0.1, sweep - gap));
			from += sweep;
			return path.detach();
		});
	}, [slices, total, mid]);
	const center = pieCenterText(spec, slices, active);
	const showPercent = pieShowsPercent(spec);
	const hit = (x: number, y: number) => setActive(pieSliceAt(slices.map((slice) => slice.value), x - SIZE / 2, y - SIZE / 2, START, INNER, OUTER));
	return (
		<View className="items-center gap-4 py-2">
			<Pressable accessibilityLabel={`${center.label}: ${center.value}`} onPressIn={(event) => hit(event.nativeEvent.locationX, event.nativeEvent.locationY)} onPressOut={() => setActive(null)} style={{ width: SIZE, height: SIZE }}>
				<Canvas style={{ width: SIZE, height: SIZE }} pointerEvents="none">
					<Group opacity={entrance}>
						{arcs.map((path, index) => (
							<Path key={slices[index]!.label + index} path={path} style="stroke" strokeWidth={OUTER - INNER + (active === index ? 6 : 0)} color={slices[index]!.color} end={entrance} />
						))}
					</Group>
				</Canvas>
				<View pointerEvents="none" className="absolute inset-0 m-auto items-center justify-center" style={{ width: INNER * 2 - 16, height: INNER * 2 - 16 }}>
					<Text className="max-w-full text-lg font-medium leading-tight" numberOfLines={1} style={{ fontVariant: ["tabular-nums"] }}>
						{center.value}
					</Text>
					<Text className="max-w-full text-body" numberOfLines={1} style={{ color: theme.label }}>
						{center.label}
					</Text>
				</View>
			</Pressable>
			<View className="w-full max-w-xs gap-1.5">
				{slices.map((slice, index) => (
					<View key={slice.label + index} accessible accessibilityLabel={`${slice.label}: ${slice.valueText}${showPercent ? `, ${slice.percentText}` : ""}`} className="min-w-0 flex-row items-center gap-2">
						<View className="size-2 rounded-full" style={{ backgroundColor: slice.color }} />
						<Text className="min-w-0 flex-1 text-body" numberOfLines={1} style={{ color: theme.label }}>
							{slice.label}
						</Text>
						<Text className="text-body" style={{ fontVariant: ["tabular-nums"] }}>
							{slice.valueText}
						</Text>
						{showPercent ? (
							<Text className="w-12 text-right text-body" style={{ color: theme.label, fontVariant: ["tabular-nums"] }}>
								{slice.percentText}
							</Text>
						) : null}
					</View>
				))}
			</View>
		</View>
	);
}
