import type * as React from "react";
import type { ChartDrawing } from "@/lib/chart-data";
import { BarPlot } from "./bar-plot";
import { CartesianPlot } from "./cartesian-plot";
import type { ChartPlotProps } from "./chart-types";
import { FunnelPlot } from "./funnel-plot";
import { GaugePlot } from "./gauge-plot";
import { PiePlot } from "./pie-plot";
import { RadarPlot } from "./radar-plot";

/** Um componente por desenho: o `Record<ChartDrawing, …>` faz o compilador cobrar um desenho para cada id (e `CHART_DRAWING_OF` cobre cada tipo do spec). */
export const CHART_DRAWINGS: Record<ChartDrawing, React.ComponentType<ChartPlotProps>> = {
	cartesian: CartesianPlot,
	bar: BarPlot,
	pie: PiePlot,
	radar: RadarPlot,
	funnel: FunnelPlot,
	gauge: GaugePlot,
};
