"use client";

import { BarChart } from "./bar-chart";
import type { Margin } from "./chart-context";

const EMPTY_DATA: Record<string, unknown>[] = [];

export interface BarChartLoadingProps {
  /** Chart margins. */
  margin?: Partial<Margin>;
  /** Aspect ratio as "width / height". Sem valor, o esqueleto ocupa a altura do contêiner (mín. 160px). */
  aspectRatio?: string;
  /** Additional class name for the container. */
  className?: string;
  /** Fill color for the loading skeleton. Defaults to the chart foreground. */
  loadingFill?: string;
}

/**
 * Turnkey loading skeleton for bar charts, a thin shortcut for
 * `<BarChart status="loading" />`. Renders shimmer-swept placeholder bars while
 * data is fetching; swap in a real `<BarChart>` once it resolves.
 */
export function BarChartLoading({
  margin,
  aspectRatio,
  className = "",
  loadingFill,
}: BarChartLoadingProps) {
  return (
    <BarChart
      aspectRatio={aspectRatio ?? ""}
      className={aspectRatio ? className : `h-full min-h-[160px] w-full ${className}`}
      data={EMPTY_DATA}
      loadingFill={loadingFill}
      margin={margin}
      status="loading"
    />
  );
}

export default BarChartLoading;
