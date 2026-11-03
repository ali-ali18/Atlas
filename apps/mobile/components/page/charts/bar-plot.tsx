import { Group, rect } from "@shopify/react-native-skia";
import * as React from "react";
import { View } from "react-native";
import { useDerivedValue } from "react-native-reanimated";
import { Bar, BarGroup, CartesianChart, HorizontalBar, HorizontalBarGroup, HorizontalStackedBar, StackedBar, useChartPressState } from "victory-native";
import { barLayout, buildBarRows, chartValueFormatter, niceScale, pickTickValues, pressRows, SERIES_KEYS } from "@/lib/chart-data";
import { seriesColor } from "@/lib/chart-palette";
import { type AxisMarks, AxisOverlay, PRESS_CONFIG, PressLayer, useAxisScales, useEntrance, usePressTap } from "./chart-env";
import type { ChartPlotProps } from "./chart-types";

const FRAME = { lineWidth: 0 } as const;
const PRESS_INIT = { x: 0, y: { s0: 0, s1: 0, s2: 0, s3: 0, s4: 0, s5: 0 } };

/**
 * Barras (vertical ou deitada, agrupadas ou empilhadas) com o Victory Native XL. Como no web, nomes longos e numerosos
 * deitam sozinhos (`orientation` do spec força). A entrada cresce por um recorte animado (sem animar se o sistema pede menos movimento).
 */
export function BarPlot({ spec, theme, width }: ChartPlotProps) {
	const model = React.useMemo(() => buildBarRows(spec), [spec]);
	const axes = useAxisScales();
	const entrance = useEntrance();
	const { state } = useChartPressState(PRESS_INIT);
	const tap = usePressTap(state);
	const layout = React.useMemo(() => barLayout({ labels: model.labels, seriesCount: spec.series.length, orientation: spec.orientation, plotWidth: width - 90 }), [model.labels, spec.series.length, spec.orientation, width]);
	const horizontal = layout.horizontal;
	const stacked = spec.stacked === true && spec.series.length > 1;
	const keys = SERIES_KEYS.slice(0, spec.series.length);
	const max = Math.max(0, ...model.rows.map((row) => (stacked ? keys.reduce((sum, key) => sum + row[key], 0) : Math.max(...keys.map((key) => row[key])))));
	const min = Math.min(0, ...model.rows.flatMap((row) => keys.map((key) => row[key])));
	const scale = React.useMemo(() => niceScale(min, max, horizontal ? 3 : 4), [min, max, horizontal]);
	const axisFormat = React.useMemo(() => chartValueFormatter(spec, { axis: true, max: Math.max(Math.abs(scale.max), Math.abs(scale.min)) }), [spec, scale]);
	const height = layout.height;
	const rowTicks = React.useMemo(() => pickTickValues(model.rows.map((row) => row.x), layout.rowLabels), [model, layout]);
	const longestRow = Math.max(...rowTicks.map((x) => (model.labels[Math.round(x)] ?? "").length));
	const gutter = horizontal ? Math.min(130, Math.max(48, longestRow * 6 + 14)) : Math.max(36, Math.max(...scale.ticks.map((tick) => axisFormat(tick).length)) * 6 + 14);
	const valueMarks = scale.ticks.map((tick) => ({ text: axisFormat(tick), v: tick }));
	const marks: AxisMarks | null =
		axes.scales && axes.bounds
			? horizontal
				? { bounds: axes.bounds, x: valueMarks.map((mark) => ({ text: mark.text, at: axes.scales!.x(mark.v) })), y: rowTicks.map((x) => ({ text: model.labels[Math.round(x)] ?? "", at: axes.scales!.y(x) })) }
				: { bounds: axes.bounds, y: valueMarks.map((mark) => ({ text: mark.text, at: axes.scales!.y(mark.v) })), x: rowTicks.map((x) => ({ text: model.labels[Math.round(x)] ?? "", at: axes.scales!.x(x) })) }
			: null;
	// Meia faixa de cada categoria de cada lado: a primeira e a última barra ficam inteiras dentro do gráfico.
	const padAlong = Math.max(10, ((horizontal ? height - 34 : width - gutter - 12) / (2 * model.rows.length)));
	const contentFor = React.useCallback(
		(index: number) => {
			const row = model.rows[index];
			return row ? { title: model.titles[index]!, rows: pressRows(spec, theme.colors, spec.series.map((_, column) => row[SERIES_KEYS[column]!])) } : null;
		},
		[model, spec, theme.colors],
	);
	const domain = React.useMemo(() => ({ y: [scale.min, scale.max] as [number, number] }), [scale]);
	const domainPadding = React.useMemo(() => (horizontal ? { top: padAlong, bottom: padAlong, right: 8 } : { left: padAlong, right: padAlong, top: 4 }), [horizontal, padAlong]);
	const padding = React.useMemo(() => ({ left: gutter, right: horizontal ? 24 : 12, top: 8, bottom: 26 }), [gutter, horizontal]);
	const xAxis = React.useMemo(() => ({ tickValues: horizontal ? scale.ticks : rowTicks, lineWidth: horizontal ? 1 : 0, lineColor: theme.grid }), [horizontal, scale, rowTicks, theme.grid]);
	const yAxis = React.useMemo(() => [{ tickValues: horizontal ? rowTicks : scale.ticks, lineColor: theme.grid, lineWidth: horizontal ? 0 : 1 }], [horizontal, scale, rowTicks, theme.grid]);
	const clip = useDerivedValue(() => (horizontal ? rect(0, 0, Math.max(1, width * entrance.value), height + 20) : rect(0, (height + 20) * (1 - entrance.value), width + 20, (height + 20) * entrance.value + 1)));
	const rounded = { topLeft: 3, topRight: 3 } as const;
	const roundedH = { topRight: 3, bottomRight: 3 } as const;
	return (
		<View style={{ height }}>
			{marks ? <AxisOverlay marks={marks} gutter={gutter} color={theme.label} width={width} rowLabels={horizontal} /> : null}
			<PressLayer state={state} mode="x" scheme={theme.scheme} contentFor={contentFor} />
			<CartesianChart
				data={model.rows}
				xKey="x"
				yKeys={keys}
				orientation={horizontal ? "horizontal" : "vertical"}
				domain={domain}
				domainPadding={domainPadding}
				padding={padding}
				onScaleChange={axes.onScaleChange}
				onChartBoundsChange={axes.onChartBoundsChange}
				xAxis={xAxis}
				yAxis={yAxis}
				frame={FRAME}
				chartPressState={state}
				chartPressConfig={PRESS_CONFIG}
				actionsRef={tap.actionsRef as never}
				customGestures={tap.customGestures as never}
			>
				{({ points, chartBounds }) => {
					const colorsOf = spec.series.map((_, index) => seriesColor(theme.colors, index));
					const all = keys.map((key) => points[key]);
					let bars: React.ReactNode;
					if (stacked) {
						bars = horizontal ? <HorizontalStackedBar points={all} chartBounds={chartBounds} colors={colorsOf} innerPadding={0.35} /> : <StackedBar points={all} chartBounds={chartBounds} colors={colorsOf} innerPadding={0.35} barOptions={({ isTop }) => ({ roundedCorners: isTop ? rounded : undefined })} />;
					} else if (keys.length > 1) {
						bars = horizontal ? (
							<HorizontalBarGroup chartBounds={chartBounds} roundedCorners={roundedH} betweenGroupPadding={0.3} withinGroupPadding={0.08}>
								{keys.map((key, index) => <HorizontalBarGroup.Bar key={key} points={points[key]} color={colorsOf[index]} />)}
							</HorizontalBarGroup>
						) : (
							<BarGroup chartBounds={chartBounds} roundedCorners={rounded} betweenGroupPadding={0.3} withinGroupPadding={0.08}>
								{keys.map((key, index) => <BarGroup.Bar key={key} points={points[key]} color={colorsOf[index]} />)}
							</BarGroup>
						);
					} else {
						bars = horizontal ? <HorizontalBar points={points.s0} chartBounds={chartBounds} color={colorsOf[0]} innerPadding={0.35} roundedCorners={roundedH} /> : <Bar points={points.s0} chartBounds={chartBounds} color={colorsOf[0]} innerPadding={0.35} roundedCorners={rounded} />;
					}
					return <Group clip={clip}>{bars}</Group>;
				}}
			</CartesianChart>
		</View>
	);
}
