import type { ChartSpec } from "@workspace/shared";
import type { ChartTheme } from "./chart-env";

/** Props de todo desenho de gráfico: o spec validado, as cores do esquema e a largura medida do cartão (pt). */
export type ChartPlotProps = { spec: ChartSpec; theme: ChartTheme; width: number };
