import { DashPathEffect, Group, LinearGradient, Line as SkLine, Rect, rect, vec } from "@shopify/react-native-skia";
import * as React from "react";
import { View } from "react-native";
import { useDerivedValue } from "react-native-reanimated";
import { Area, Bar, CartesianChart, Line, StackedArea, useChartPressState } from "victory-native";
import { buildChartRows, chartExtent, chartValueFormatter, labelBudget, niceScale, pickTickValues, pressContent, SERIES_KEYS, type SeriesKey, xLabelSlot } from "@/lib/chart-data";
import { seriesColor } from "@/lib/chart-palette";
import { hexAlpha } from "@/lib/color-math";
import type { ChartTheme } from "./chart-env";
import { type AxisMarks, AxisOverlay, PRESS_CONFIG, PressLayer, useAxisScales, useEntrance, usePressTap } from "./chart-env";
import type { ChartPlotProps } from "./chart-types";

const HEIGHT = 240;
const FRAME = { lineWidth: 0 } as const;
const PRESS_INIT = { x: 0, y: { s0: 0, s1: 0, s2: 0, s3: 0, s4: 0, s5: 0, f: 0 } };

type Kind = "bar" | "line" | "area";
function kindOf(type: string, kind: Kind | undefined, index: number): Kind {
	if (type === "composed") return kind ?? (index === 0 ? "bar" : "line");
	return type === "area" ? "area" : "line";
}

/**
 * Linha, área e composto (barras + linhas + áreas no mesmo eixo de datas) com o Victory Native XL sobre o Skia. Ordem de
 * empilhamento do web: áreas atrás, barras no meio, linhas por cima; a previsão é uma linha tracejada na cor da 1ª série.
 */
export function CartesianPlot({ spec, theme, width }: ChartPlotProps) {
	const model = React.useMemo(() => buildChartRows(spec), [spec]);
	const axes = useAxisScales();
	const entrance = useEntrance();
	const { state } = useChartPressState(PRESS_INIT);
	const tap = usePressTap(state);
	const extent = React.useMemo(() => chartExtent(spec, model.rows), [spec, model.rows]);
	const scale = React.useMemo(() => niceScale(extent.min, extent.max, 4), [extent]);
	const axisFormat = React.useMemo(() => chartValueFormatter(spec, { axis: true, max: Math.max(Math.abs(scale.max), Math.abs(scale.min)) }), [spec, scale]);
	const yKeys = React.useMemo(() => [...SERIES_KEYS.slice(0, spec.series.length), ...(spec.forecast ? (["f"] as const) : [])] as Array<SeriesKey | "f">, [spec.series.length, spec.forecast]);
	const gutter = Math.max(36, Math.max(...scale.ticks.map((tick) => axisFormat(tick).length)) * 6 + 14);
	const composed = spec.type === "composed";
	const pad = composed ? Math.max(14, (width - gutter - 12) / (2 * model.rows.length)) : 8;
	const xTicks = React.useMemo(() => {
		// Rótulos entre todos os períodos (os projetados também), espalhados pela largura útil do gráfico.
		const all = model.rows.map((row) => row.x);
		const slot = xLabelSlot(all.map((x) => model.labelOf(x))) + 6;
		return pickTickValues(all, labelBudget(width - gutter - 12 - 2 * pad, slot));
	}, [model, width, gutter, pad]);
	const marks: AxisMarks | null = axes.scales && axes.bounds ? { bounds: axes.bounds, y: scale.ticks.map((tick) => ({ text: axisFormat(tick), at: axes.scales!.y(tick) })), x: xTicks.map((x) => ({ text: model.labelOf(x), at: axes.scales!.x(x) })) } : null;
	const stackedArea = spec.type === "area" && spec.stacked === true;
	const contentFor = React.useCallback((index: number) => pressContent(spec, theme.colors, model, index), [spec, theme.colors, model]);
	// Props objeto do victory memoizadas: com objeto novo a cada render o gráfico inteiro recalcularia escalas e eixos.
	const domain = React.useMemo(() => ({ y: [scale.min, scale.max] as [number, number] }), [scale]);
	const domainPadding = React.useMemo(() => ({ left: pad, right: pad, top: 4 }), [pad]);
	const padding = React.useMemo(() => ({ left: gutter, right: 12, top: 8, bottom: 26 }), [gutter]);
	const yAxis = React.useMemo(() => [{ tickValues: scale.ticks, lineColor: theme.grid, lineWidth: 1, labelPosition: "inset" as const }], [scale, theme.grid]);
	const dash = <DashPathEffect intervals={[5, 5]} />;
	const clipBounds = useDerivedValue(() => rect(0, 0, Math.max(1, width * entrance.value), HEIGHT + 20));
	const indicatorOpacity = useDerivedValue(() => (state.isActive.value ? 1 : 0));
	return (
		<View style={{ height: HEIGHT }}>
			{marks ? <AxisOverlay marks={marks} gutter={gutter} color={theme.label} width={width} /> : null}
			<PressLayer state={state} mode="matched" scheme={theme.scheme} contentFor={contentFor} />
			<CartesianChart
				data={model.rows}
				xKey="x"
				yKeys={yKeys}
				domain={domain}
				domainPadding={domainPadding}
				padding={padding}
				onScaleChange={axes.onScaleChange}
				onChartBoundsChange={axes.onChartBoundsChange}
				yAxis={yAxis}
				frame={FRAME}
				chartPressState={state}
				chartPressConfig={PRESS_CONFIG}
				actionsRef={tap.actionsRef as never}
				customGestures={tap.customGestures as never}
			>
				{({ points, chartBounds, yScale }) => {
					const layers = (["area", "bar", "line"] as const).flatMap((layer) => spec.series.flatMap((item, index) => (kindOf(spec.type, item.kind, index) === layer ? [{ index, layer }] : [])));
					const referenceTop = spec.reference ? yScale(spec.reference.to ?? scale.max) : 0;
					const referenceBottom = spec.reference ? yScale(spec.reference.from ?? scale.min) : 0;
					return (
						<Group clip={clipBounds}>
							{spec.reference ? (
								<>
									<Rect x={chartBounds.left} y={Math.min(referenceTop, referenceBottom)} width={chartBounds.right - chartBounds.left} height={Math.abs(referenceBottom - referenceTop)} color={hexAlpha(theme.label, 0.1)} />
									{spec.reference.to !== undefined ? <SkLine p1={vec(chartBounds.left, referenceTop)} p2={vec(chartBounds.right, referenceTop)} color={theme.label} strokeWidth={1}>{dash}</SkLine> : null}
									{spec.reference.from !== undefined ? <SkLine p1={vec(chartBounds.left, referenceBottom)} p2={vec(chartBounds.right, referenceBottom)} color={theme.label} strokeWidth={1}>{dash}</SkLine> : null}
								</>
							) : null}
							{stackedArea ? (
								<>
									<StackedArea points={spec.series.map((_, index) => points[SERIES_KEYS[index]!])} y0={chartBounds.bottom} curveType="monotoneX" colors={spec.series.map((_, index) => hexAlpha(seriesColor(theme.colors, index), 0.55))} />
								</>
							) : null}
							{(stackedArea ? [] : layers).map(({ index, layer }) => {
								const key = SERIES_KEYS[index]!;
								const color = seriesColor(theme.colors, index);
								if (layer === "area") {
									return (
										<React.Fragment key={key}>
											<Area points={points[key]} y0={chartBounds.bottom} curveType="monotoneX" color={color}>
												<LinearGradient start={vec(0, chartBounds.top)} end={vec(0, chartBounds.bottom)} colors={[hexAlpha(color, 0.4), hexAlpha(color, 0.02)]} />
											</Area>
											<Line points={points[key]} color={color} strokeWidth={2} curveType="monotoneX" />
										</React.Fragment>
									);
								}
								if (layer === "bar") return <Bar key={key} points={points[key]} chartBounds={chartBounds} color={color} innerPadding={0.35} roundedCorners={{ topLeft: 3, topRight: 3 }} />;
								return <Line key={key} points={points[key]} color={color} strokeWidth={2} curveType="monotoneX" />;
							})}
							{spec.forecast ? <Line points={points.f} color={seriesColor(theme.colors, 0)} strokeWidth={2} curveType="linear">{dash}</Line> : null}
							<Group opacity={indicatorOpacity}>
								<Indicator state={state} chartBounds={chartBounds} theme={theme} />
							</Group>
						</Group>
					);
				}}
			</CartesianChart>
		</View>
	);
}

function Indicator({ state, chartBounds, theme }: { state: ReturnType<typeof useChartPressState<typeof PRESS_INIT>>["state"]; chartBounds: { top: number; bottom: number }; theme: ChartTheme }) {
	const p1 = useDerivedValue(() => vec(state.x.position.value, chartBounds.top));
	const p2 = useDerivedValue(() => vec(state.x.position.value, chartBounds.bottom));
	return <SkLine p1={p1} p2={p2} color={hexAlpha(theme.label, 0.7)} strokeWidth={1} />;
}
