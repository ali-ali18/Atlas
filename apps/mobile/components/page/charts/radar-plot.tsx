import { Canvas, Group, Path, Skia, type SkPath } from "@shopify/react-native-skia";
import * as React from "react";
import { View } from "react-native";
import { Text } from "@/components/ui/text";
import { chartValueFormatter, fitSize, RADAR_LABEL_ROOM, RADAR_LABEL_WIDTH, radarGeometry } from "@/lib/chart-data";
import { seriesColor } from "@/lib/chart-palette";
import { hexAlpha } from "@/lib/color-math";
import { useEntrance } from "./chart-env";
import type { ChartPlotProps } from "./chart-types";

function polygon(points: ReadonlyArray<{ x: number; y: number }>): SkPath {
	const path = Skia.PathBuilder.Make();
	points.forEach((point, index) => (index === 0 ? path.moveTo(point.x, point.y) : path.lineTo(point.x, point.y)));
	path.close();
	return path.detach();
}

/** Radar: eixos = linhas do spec, uma área por série, escala relativa ao maior valor (a legenda informa qual). */
export function RadarPlot({ spec, theme, width }: ChartPlotProps) {
	const size = fitSize(width, 340);
	const entrance = useEntrance();
	const geometry = React.useMemo(() => radarGeometry(spec, size, RADAR_LABEL_ROOM), [spec, size]);
	const grid = React.useMemo(() => geometry.grid.map(polygon), [geometry]);
	const areas = React.useMemo(() => geometry.areas.map(polygon), [geometry]);
	const axes = React.useMemo(() => {
		const path = Skia.PathBuilder.Make();
		for (const axis of geometry.axes) {
			path.moveTo(size / 2, size / 2);
			path.lineTo(axis.x, axis.y);
		}
		return path.detach();
	}, [geometry, size]);
	const peak = chartValueFormatter(spec)(geometry.peak);
	return (
		<View className="items-center gap-1 py-1">
			<View style={{ width: size, height: size }}>
				<Canvas style={{ width: size, height: size }}>
					<Group opacity={entrance}>
						{grid.map((path, index) => (
							<Path key={`g${index}`} path={path} style="stroke" strokeWidth={1} color={theme.grid} />
						))}
						<Path path={axes} style="stroke" strokeWidth={1} color={theme.grid} />
						{areas.map((path, index) => (
							<React.Fragment key={spec.series[index]!.key}>
								<Path path={path} style="fill" color={hexAlpha(seriesColor(theme.colors, index), 0.25)} />
								<Path path={path} style="stroke" strokeWidth={2} strokeJoin="round" color={seriesColor(theme.colors, index)} />
							</React.Fragment>
						))}
					</Group>
				</Canvas>
				{geometry.labels.map((label, index) => (
					<Text
						key={`${label.text}-${index}`}
						pointerEvents="none"
						className="absolute text-body"
						numberOfLines={3}
						style={{ width: RADAR_LABEL_WIDTH, color: theme.label, textAlign: label.align, left: label.align === "left" ? label.x : label.align === "right" ? label.x - RADAR_LABEL_WIDTH : label.x - RADAR_LABEL_WIDTH / 2, top: label.y - 9 }}
					>
						{label.text}
					</Text>
				))}
			</View>
			{spec.series.length > 1 ? (
				<View className="flex-row flex-wrap justify-center gap-x-4 gap-y-1">
					{spec.series.map((item, index) => (
						<View key={item.key} className="flex-row items-center gap-1.5">
							<View className="size-2 rounded-full" style={{ backgroundColor: seriesColor(theme.colors, index) }} />
							<Text className="text-body" style={{ color: theme.label }}>
								{item.label}
							</Text>
						</View>
					))}
				</View>
			) : null}
			<Text className="text-center text-body" style={{ color: theme.label }}>{`Escala relativa ao maior valor (${peak})`}</Text>
		</View>
	);
}
