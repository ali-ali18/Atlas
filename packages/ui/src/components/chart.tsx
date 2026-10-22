"use client"

import * as React from "react"
import { CheckIcon, CopyIcon } from "lucide-react"
import {
  chartSpecToCsv,
  type ChartSpec,
} from "@workspace/shared"

import { cn } from "@workspace/ui/lib/utils"
import { AreaChart, Area } from "@workspace/ui/charts/area-chart"
import { BarChart } from "@workspace/ui/charts/bar-chart"
import { Bar } from "@workspace/ui/charts/bar"
import { BarXAxis } from "@workspace/ui/charts/bar-x-axis"
import { BarYAxis } from "@workspace/ui/charts/bar-y-axis"
import { chartPaletteCss, resolveChartPalette } from "@workspace/ui/charts/chart-palettes"
import { XLabelFormatContext } from "@workspace/ui/charts/chart-formatters"
import { Grid } from "@workspace/ui/charts/grid"
import { LineChart, Line } from "@workspace/ui/charts/line-chart"
import { PieChart } from "@workspace/ui/charts/pie-chart"
import { usePieHover, usePieStable } from "@workspace/ui/charts/pie-context"
import { PieSlice } from "@workspace/ui/charts/pie-slice"
import { TooltipContent } from "@workspace/ui/charts/tooltip/tooltip-content"
import { ChartTooltip } from "@workspace/ui/charts/tooltip/chart-tooltip"
import { XAxis } from "@workspace/ui/charts/x-axis"
import { YAxis } from "@workspace/ui/charts/y-axis"
import { curveMonotoneX } from "@visx/curve"

/**
 * Gráfico nativo do chat: desenha uma `ChartSpec` (linha, barras, área, pizza) com os componentes do Bklit UI
 * (MIT, vendorizados em `src/charts`), cores `--chart-1..6`, números e datas em pt-BR.
 */

const MONTHS = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"]
const MONTHS_LONG = [
  "janeiro", "fevereiro", "março", "abril", "maio", "junho",
  "julho", "agosto", "setembro", "outubro", "novembro", "dezembro",
]
const CURRENCY: Record<string, string> = { BRL: "BRL", USD: "USD", EUR: "EUR" }

export function seriesColor(index: number): string {
  return `var(--chart-${(index % 6) + 1})`
}

/** Fatias além da sexta repetem a cor misturada com o fundo, para continuarem distintas. */
function sliceColor(index: number): string {
  const base = seriesColor(index)
  if (index < 6) return base
  return `color-mix(in oklch, ${base} 55%, var(--background))`
}

export type ValueFormatter = (value: number) => string

/** Formata valores do spec em pt-BR (1.234,56 · R$ · % · sufixo da unidade); `axis` encurta para os eixos. */
export function makeValueFormatter(
  spec: Pick<ChartSpec, "unit" | "format">,
  options: { axis?: boolean; max?: number } = {}
): ValueFormatter {
  const compact =
    spec.format === "compact" ||
    (options.axis === true && (options.max ?? 0) >= 10_000)
  const currency = spec.unit ? CURRENCY[spec.unit.toUpperCase()] : undefined
  const numberOptions: Intl.NumberFormatOptions = compact
    ? { notation: "compact", maximumFractionDigits: 1 }
    : { maximumFractionDigits: 2 }
  if (currency) {
    const intl = new Intl.NumberFormat("pt-BR", {
      style: "currency",
      currency,
      // Moeda herda 2 casas mínimas; no compacto isso vira "R$ 60,0 mil".
      ...(compact ? { notation: "compact", maximumFractionDigits: 1, minimumFractionDigits: 0 } : {}),
      ...(!compact && options.axis ? { maximumFractionDigits: 2, minimumFractionDigits: 0 } : {}),
    })
    return (value) => intl.format(value)
  }
  const intl = new Intl.NumberFormat("pt-BR", numberOptions)
  if (spec.unit === "%" || spec.format === "percent") {
    return (value) => `${intl.format(value)}%`
  }
  if (spec.unit) return (value) => `${intl.format(value)} ${spec.unit}`
  return (value) => intl.format(value)
}

/** Data ISO só com dia → data local (sem o deslocamento de fuso de `new Date("2025-01-01")`). */
export function parseChartDate(value: string): Date {
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (day) return new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3]))
  return new Date(value)
}

type XLabels = {
  /** Rótulo curto do eixo. */
  axis: (value: string | number) => string
  /** Título do tooltip. */
  title: (value: string | number) => string
}

/** Rótulos do eixo X: categorias como vieram; datas mensais "jan/25"; demais datas "dd/mm" (com ano se passar de um ano). */
export function makeXLabels(spec: ChartSpec): XLabels {
  if (spec.xKind !== "date") {
    return { axis: (value) => String(value), title: (value) => String(value) }
  }
  const dates = spec.data.map((point) => parseChartDate(String(point[spec.x])))
  const monthly = dates.every((date) => date.getDate() === 1)
  const times = dates.map((date) => date.getTime())
  const spanDays = (Math.max(...times) - Math.min(...times)) / 86_400_000
  const pad = (value: number) => String(value).padStart(2, "0")
  return {
    axis: (value) => {
      const date = parseChartDate(String(value))
      if (monthly) return `${MONTHS[date.getMonth()]}/${pad(date.getFullYear() % 100)}`
      const base = `${pad(date.getDate())}/${pad(date.getMonth() + 1)}`
      return spanDays > 366 ? `${base}/${pad(date.getFullYear() % 100)}` : base
    },
    title: (value) => {
      const date = parseChartDate(String(value))
      if (monthly) return `${MONTHS_LONG[date.getMonth()]} de ${date.getFullYear()}`
      return `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()}`
    },
  }
}

function maxAbs(spec: ChartSpec): number {
  let max = 0
  for (const point of spec.data) {
    for (const item of spec.series) {
      const value = point[item.key]
      if (typeof value === "number") max = Math.max(max, Math.abs(value))
    }
  }
  return max
}

function stackedMax(spec: ChartSpec): number {
  return Math.max(
    0,
    ...spec.data.map((point) =>
      spec.series.reduce((sum, item) => sum + (typeof point[item.key] === "number" ? (point[item.key] as number) : 0), 0)
    )
  )
}

type TimePoint = Record<string, unknown> & { __date: Date; __orig: Record<string, string | number | null> }

/** Linha/área: eixo de tempo do Bklit. Categorias viram datas sintéticas (um dia por ponto); nulos são interpolados só no traço. */
function toTimeData(spec: ChartSpec): { rows: TimePoint[]; categoryByTime: Map<number, string> } {
  const categoryByTime = new Map<number, string>()
  const rows = spec.data.map((point, index) => {
    const raw = point[spec.x] as string | number
    const date = spec.xKind === "date" ? parseChartDate(String(raw)) : new Date(2000, 0, 1 + index)
    if (spec.xKind !== "date") categoryByTime.set(date.getTime(), String(raw))
    return { __date: date, __orig: point } as TimePoint
  })
  for (const item of spec.series) {
    const known = rows.map((row, index) => (typeof row.__orig[item.key] === "number" ? index : -1)).filter((index) => index >= 0)
    rows.forEach((row, index) => {
      const own = row.__orig[item.key]
      if (typeof own === "number") {
        row[item.key] = own
        return
      }
      const before = [...known].reverse().find((candidate) => candidate < index)
      const after = known.find((candidate) => candidate > index)
      const a = before === undefined ? undefined : (rows[before]!.__orig[item.key] as number)
      const b = after === undefined ? undefined : (rows[after]!.__orig[item.key] as number)
      if (a !== undefined && b !== undefined && before !== undefined && after !== undefined) {
        row[item.key] = a + ((b - a) * (index - before)) / (after - before)
      } else {
        row[item.key] = a ?? b ?? 0
      }
    })
  }
  return { rows, categoryByTime }
}

const CHART_MARGIN = { top: 16, right: 14, bottom: 36, left: 58 }

/** Margem esquerda que cabe o maior rótulo do eixo Y (≈6,6px por caractere em 12px). */
function chartMargin(axisFormat: ValueFormatter, max: number) {
  const longest = Math.max(axisFormat(0).length, axisFormat(max).length, axisFormat(max / 2).length)
  return { ...CHART_MARGIN, left: Math.max(36, Math.round(longest * 6.6 + 14)) }
}

const PlotWidthContext = React.createContext(600)
/** Quantos rótulos do eixo X cabem sem encostar (~74px cada). */
function labelBudget(plotWidth: number, margin: { left: number; right: number }, max: number) {
  return Math.max(2, Math.min(max, Math.floor((plotWidth - margin.left - margin.right) / 74)))
}
const PLOT_CLASS = "h-[260px] w-full"

function Legend({ spec }: { spec: ChartSpec }) {
  if (spec.series.length < 2) return null
  return (
    <ul
      className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 px-1 text-xs text-muted-foreground"
      data-slot="chart-legend"
    >
      {spec.series.map((item, index) => (
        <li className="flex min-w-0 items-center gap-1.5" key={item.key}>
          <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: seriesColor(index) }} />
          <span className="truncate">{item.label}</span>
        </li>
      ))}
    </ul>
  )
}

function TimeSeriesPlot({ spec }: { spec: ChartSpec }) {
  const plotWidth = React.useContext(PlotWidthContext)
  const { rows, categoryByTime } = React.useMemo(() => toTimeData(spec), [spec])
  const labels = React.useMemo(() => makeXLabels(spec), [spec])
  const tooltipFormat = React.useMemo(() => makeValueFormatter(spec), [spec])
  const axisFormat = React.useMemo(
    () => makeValueFormatter(spec, { axis: true, max: spec.type === "area" && spec.stacked ? stackedMax(spec) : maxAbs(spec) }),
    [spec]
  )
  const margin = React.useMemo(() => chartMargin(axisFormat, spec.type === "area" && spec.stacked ? stackedMax(spec) : maxAbs(spec)), [axisFormat, spec])
  const formatX = React.useCallback(
    (date: Date) => {
      const category = categoryByTime.get(date.getTime())
      if (category !== undefined) return category
      const index = rows.findIndex((row) => row.__date.getTime() === date.getTime())
      return labels.axis(String(spec.data[index]?.[spec.x] ?? ""))
    },
    [categoryByTime, labels, rows, spec]
  )
  const tooltipContent = React.useCallback(
    ({ point }: { point: Record<string, unknown> }) => {
      const row = point as TimePoint
      return (
        <TooltipContent
          rows={spec.series.map((item, index) => {
            const value = row.__orig[item.key]
            return {
              color: seriesColor(index),
              label: item.label,
              value: typeof value === "number" ? tooltipFormat(value) : "—",
            }
          })}
          title={labels.title(String(row.__orig[spec.x]))}
        />
      )
    },
    [labels, spec, tooltipFormat]
  )
  const Chart = spec.type === "area" ? AreaChart : LineChart

  return (
    <XLabelFormatContext.Provider value={formatX}>
      <Chart
        aspectRatio=""
        className={PLOT_CLASS}
        data={rows}
        margin={margin}
        xDataKey="__date"
      >
        <Grid horizontal />
        {spec.series.map((item, index) =>
          spec.type === "area" ? (
            <Area
              curve={curveMonotoneX}
              dataKey={item.key}
              fill={seriesColor(index)}
              fillOpacity={0.22}
              key={item.key}
              stroke={seriesColor(index)}
              strokeWidth={2}
            />
          ) : (
            <Line
              curve={curveMonotoneX}
              dataKey={item.key}
              fadeEdges={false}
              key={item.key}
              stroke={seriesColor(index)}
              strokeWidth={2}
            />
          )
        )}
        <YAxis formatValue={axisFormat} />
        <XAxis numTicks={labelBudget(plotWidth, margin, 6)} />
        <ChartTooltip content={tooltipContent} />
      </Chart>
    </XLabelFormatContext.Provider>
  )
}

function BarPlot({ spec }: { spec: ChartSpec }) {
  const plotWidth = React.useContext(PlotWidthContext)
  const labels = React.useMemo(() => makeXLabels(spec), [spec])
  const data = React.useMemo(
    () =>
      spec.data.map((point) => {
        const row: Record<string, unknown> = { __label: labels.axis(point[spec.x] as string | number), __orig: point }
        for (const item of spec.series) row[item.key] = typeof point[item.key] === "number" ? point[item.key] : 0
        return row
      }),
    [labels, spec]
  )
  const tooltipFormat = React.useMemo(() => makeValueFormatter(spec), [spec])
  const axisFormat = React.useMemo(
    () => makeValueFormatter(spec, { axis: true, max: spec.stacked ? stackedMax(spec) : maxAbs(spec) }),
    [spec]
  )
  const margin = React.useMemo(() => chartMargin(axisFormat, spec.stacked ? stackedMax(spec) : maxAbs(spec)), [axisFormat, spec])
  const tooltipContent = React.useCallback(
    ({ point }: { point: Record<string, unknown> }) => {
      const orig = point.__orig as Record<string, string | number | null>
      return (
        <TooltipContent
          rows={spec.series.map((item, index) => {
            const value = orig[item.key]
            return {
              color: seriesColor(index),
              label: item.label,
              value: typeof value === "number" ? tooltipFormat(value) : "—",
            }
          })}
          title={labels.title(orig[spec.x] as string | number)}
        />
      )
    },
    [labels, spec, tooltipFormat]
  )

  // Largura que não comporta todos os rótulos: barras horizontais, categorias à esquerda (truncadas; o tooltip traz o nome inteiro).
  const horizontal = labelBudget(plotWidth, margin, 12) < spec.data.length
  const rowHeight = Math.max(260, spec.data.length * (spec.series.length > 1 ? 14 * spec.series.length + 14 : 34) + 24)
  return (
    <div style={horizontal ? { height: rowHeight } : undefined}>
    <BarChart
      aspectRatio=""
      barGap={spec.data.length > 24 ? 0.1 : 0.25}
      className={horizontal ? "h-full w-full" : PLOT_CLASS}
      data={data}
      margin={horizontal ? { top: 8, right: 16, bottom: 16, left: 84 } : margin}
      orientation={horizontal ? "horizontal" : "vertical"}
      stacked={spec.stacked === true}
      xDataKey="__label"
    >
      <Grid horizontal={!horizontal} vertical={horizontal} />
      {spec.series.map((item, index) => (
        <Bar
          dataKey={item.key}
          fill={seriesColor(index)}
          key={item.key}
          lineCap={spec.data.length > 24 ? 0 : 3}
        />
      ))}
      {horizontal ? <BarYAxis maxLabels={40} /> : <YAxis formatValue={axisFormat} />}
      {horizontal ? null : <BarXAxis maxLabels={labelBudget(plotWidth, margin, 12)} />}
      <ChartTooltip content={tooltipContent} />
    </BarChart>
    </div>
  )
}

function PieCenterText({ format, label }: { format: ValueFormatter; label: string }) {
  const { data, totalValue, innerRadius } = usePieStable()
  const { hoveredIndex } = usePieHover()
  if (innerRadius <= 0) return null
  const hovered = hoveredIndex === null ? null : data[hoveredIndex]
  const size = innerRadius * 2 - 16
  return (
    <div
      className="pointer-events-none absolute inset-0 m-auto flex flex-col items-center justify-center text-center"
      style={{ width: size, height: size }}
    >
      <span className="max-w-full truncate font-medium text-foreground text-lg tabular-nums leading-tight">
        {format(hovered ? hovered.value : totalValue)}
      </span>
      <span className="max-w-full truncate text-muted-foreground text-xs">
        {hovered ? hovered.label : label}
      </span>
    </div>
  )
}

function PiePlot({ spec }: { spec: ChartSpec }) {
  const valueKey = spec.series[0]!.key
  const slices = React.useMemo(
    () =>
      spec.data
        .map((point) => ({ label: String(point[spec.x]), value: typeof point[valueKey] === "number" ? (point[valueKey] as number) : 0 }))
        .filter((slice) => slice.value > 0)
        .map((slice, index) => ({ ...slice, color: sliceColor(index) })),
    [spec, valueKey]
  )
  const format = React.useMemo(() => makeValueFormatter(spec), [spec])
  const total = slices.reduce((sum, slice) => sum + slice.value, 0)
  const percent = React.useMemo(() => new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 1 }), [])

  return (
    <div className="flex min-w-0 flex-col items-center gap-4 py-2 sm:flex-row sm:justify-center sm:gap-8">
      <PieChart cornerRadius={3} data={slices} innerRadius={64} padAngle={0.015} size={200}>
        {slices.map((slice, index) => (
          <PieSlice index={index} key={slice.label + index} showGlow={false} />
        ))}
        <PieCenterText format={format} label={spec.series[0]!.label} />
      </PieChart>
      <ul className="w-full min-w-0 max-w-xs space-y-1.5 text-xs" data-slot="chart-legend">
        {slices.map((slice, index) => (
          <li className="flex min-w-0 items-center gap-2" key={slice.label + index}>
            <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: slice.color }} />
            <span className="min-w-0 flex-1 truncate text-muted-foreground">{slice.label}</span>
            <span className="shrink-0 text-foreground tabular-nums">{format(slice.value)}</span>
            <span className="w-12 shrink-0 text-right text-muted-foreground tabular-nums">
              {percent.format((slice.value / total) * 100)}%
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** O gráfico em si (sem moldura): escolhe o desenho pelo `type` do spec. */
function ChartView({ spec }: { spec: ChartSpec }) {
  const ref = React.useRef<HTMLDivElement>(null)
  const [width, setWidth] = React.useState(600)
  React.useEffect(() => {
    const node = ref.current
    if (!node || typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(([entry]) => entry && setWidth(entry.contentRect.width))
    observer.observe(node)
    return () => observer.disconnect()
  }, [])
  const palette = React.useMemo(() => resolveChartPalette(spec.palette, spec.colors), [spec.palette, spec.colors])
  return (
    <PlotWidthContext.Provider value={width}>
    <div data-chart-palette={palette?.scope} data-slot="chart-view" data-chart-type={spec.type} ref={ref}>
      {palette ? <style>{chartPaletteCss(palette)}</style> : null}
      {spec.type === "pie" ? (
        <PiePlot spec={spec} />
      ) : spec.type === "bar" ? (
        <BarPlot spec={spec} />
      ) : (
        <TimeSeriesPlot spec={spec} />
      )}
      {spec.type === "pie" ? null : <Legend spec={spec} />}
    </div>
    </PlotWidthContext.Provider>
  )
}

function CopyCsvButton({ spec }: { spec: ChartSpec }) {
  const [copied, setCopied] = React.useState(false)
  React.useEffect(() => {
    if (!copied) return
    const timeout = setTimeout(() => setCopied(false), 2000)
    return () => clearTimeout(timeout)
  }, [copied])
  return (
    <button
      aria-label="Copiar dados (CSV)"
      className="inline-flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-2 text-muted-foreground text-xs outline-none transition-colors hover:bg-foreground/5 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 dark:hover:bg-foreground/10"
      data-slot="chart-copy-csv"
      onClick={() => {
        navigator.clipboard
          .writeText(chartSpecToCsv(spec))
          .then(() => setCopied(true))
          .catch(() => {})
      }}
      type="button"
    >
      {copied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
      <span className="max-[480px]:sr-only">{copied ? "Copiado" : "Copiar dados (CSV)"}</span>
    </button>
  )
}

/** Gráfico com moldura: título opcional, botão discreto de copiar os dados e o desenho. */
function Chart({ spec, className }: { spec: ChartSpec; className?: string }) {
  return (
    <figure
      className={cn(
        "my-2 w-[min(68ch,calc(100vw-5rem))] min-w-0 max-w-full overflow-hidden rounded-lg border border-border/60 bg-muted/30 pb-3",
        className
      )}
      data-slot="chart"
    >
      <figcaption className="flex min-h-9 items-center justify-between gap-2 pt-1.5 pr-1.5 pl-3">
        <span className="min-w-0 truncate font-medium text-foreground/90 text-sm" data-slot="chart-title">
          {spec.title ?? ""}
        </span>
        <CopyCsvButton spec={spec} />
      </figcaption>
      <div className="px-2">
        <ChartView spec={spec} />
      </div>
    </figure>
  )
}

export { Chart, ChartView, CopyCsvButton }
