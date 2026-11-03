// Dados e geometria dos gráficos do painel, parte pura (sem React, Skia nem Victory): o que o componente desenha vem
// daqui, então formatação, escala, previsão, fatias, radar, funil e medidor ficam testáveis em node. Porta do
// `packages/ui/src/components/chart.tsx` do web (mesmas regras de rótulo, de escala relativa do radar, de fatias e de
// previsão linear), só em pt-BR.
import type { ChartSpec } from "@workspace/shared";
import { mixHex } from "./color-math";
import { type ChartColors, seriesColor } from "./chart-palette";
import { formatDecimal, formatPageNumber } from "./page-format";

// ---------- Tipos de gráfico: qual desenho cada um usa ----------

/** Desenhos que o app tem (um componente por id em `components/page/charts`). Tipo novo no spec = id novo aqui. */
export const CHART_DRAWINGS = ["cartesian", "bar", "pie", "radar", "funnel", "gauge"] as const;
export type ChartDrawing = (typeof CHART_DRAWINGS)[number];

/**
 * Qual desenho cobre cada `type` do `ChartSpec`. Mapa exaustivo (o compilador cobra `Record<ChartType, …>`) e o teste
 * falha se um tipo de `CHART_TYPES` ficar sem desenho: tipo novo no shared nunca vira gráfico em branco no app.
 */
export const CHART_DRAWING_OF: Record<ChartSpec["type"], ChartDrawing> = {
	line: "cartesian",
	area: "cartesian",
	composed: "cartesian",
	bar: "bar",
	pie: "pie",
	radar: "radar",
	funnel: "funnel",
	gauge: "gauge",
};

// ---------- Formatação ----------

/** Formata valores do spec (1.234,56 · R$ · % · sufixo da unidade); `axis` encurta no eixo (compacto a partir de 10 mil). */
export function chartValueFormatter(spec: Pick<ChartSpec, "unit" | "format">, options: { axis?: boolean; max?: number; whole?: boolean } = {}): (value: number) => string {
	const compact = spec.format === "compact" || (options.axis === true && (options.max ?? 0) >= 10_000);
	const format = compact ? "compact" : spec.format;
	return (value) => formatPageNumber(value, { unit: spec.unit, format, digits: options.whole || Number.isInteger(value) ? 0 : 2 });
}

const MONTHS = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"] as const;
const MONTHS_LONG = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"] as const;
const pad = (value: number) => String(value).padStart(2, "0");
const DAY_MS = 86_400_000;

/** Data ISO do eixo X como instante UTC (só o dia conta: sem deslocamento de fuso, como o `parseChartDate` do web). */
export function parseChartDay(value: string): number {
	const day = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
	if (day) return Date.UTC(Number(day[1]), Number(day[2]) - 1, Number(day[3]));
	return Date.parse(value);
}

export type XLabels = {
	/** Rótulo curto do eixo para o valor de X do spec. */
	axis: (value: string | number) => string;
	/** Rótulo curto do eixo para um instante (inclui períodos projetados). */
	axisDate: (ms: number) => string;
	/** Título do que aparece ao tocar. */
	title: (value: string | number) => string;
	monthly: boolean;
};

/** Rótulos do eixo X: categorias como vieram; datas mensais "jan/25"; demais "dd/mm" (com ano se passar de um ano). */
export function chartXLabels(spec: ChartSpec): XLabels {
	if (spec.xKind !== "date") {
		return { axis: String, axisDate: (ms) => String(ms), title: String, monthly: false };
	}
	const times = spec.data.map((point) => parseChartDay(String(point[spec.x])));
	const monthly = times.every((time) => new Date(time).getUTCDate() === 1);
	const spanDays = (Math.max(...times) - Math.min(...times)) / DAY_MS;
	const axisDate = (ms: number) => {
		const date = new Date(ms);
		if (monthly) return `${MONTHS[date.getUTCMonth()]}/${pad(date.getUTCFullYear() % 100)}`;
		const base = `${pad(date.getUTCDate())}/${pad(date.getUTCMonth() + 1)}`;
		return spanDays > 366 ? `${base}/${pad(date.getUTCFullYear() % 100)}` : base;
	};
	return {
		axis: (value) => axisDate(parseChartDay(String(value))),
		axisDate,
		title: (value) => {
			const date = new Date(parseChartDay(String(value)));
			if (monthly) return `${MONTHS_LONG[date.getUTCMonth()]} de ${date.getUTCFullYear()}`;
			return `${pad(date.getUTCDate())}/${pad(date.getUTCMonth() + 1)}/${date.getUTCFullYear()}`;
		},
		monthly,
	};
}

/** Texto da faixa/meta ("Meta (a partir de R$ 5.000)"), no formato do gráfico; null sem `reference`. */
export function describeReference(spec: ChartSpec): string | null {
	const reference = spec.reference;
	if (!reference) return null;
	const format = chartValueFormatter(spec);
	const range =
		reference.from !== undefined && reference.to !== undefined
			? `${format(reference.from)} – ${format(reference.to)}`
			: reference.from !== undefined
				? `a partir de ${format(reference.from)}`
				: `até ${format(reference.to!)}`;
	return reference.label ? `${reference.label} (${range})` : range;
}

// ---------- Escala ----------

/** Escala "bonita": limites e marcas redondos (1, 2, 5 × 10ⁿ) que cobrem [min, max]. */
export function niceScale(min: number, max: number, count = 4): { min: number; max: number; ticks: number[] } {
	if (!Number.isFinite(min) || !Number.isFinite(max)) return { min: 0, max: 1, ticks: [0, 1] };
	let lo = Math.min(min, max);
	let hi = Math.max(min, max);
	if (lo === hi) {
		hi = lo === 0 ? 1 : lo + Math.abs(lo) * 0.1;
		lo = lo === 0 ? 0 : lo - Math.abs(lo) * 0.1;
	}
	const rough = (hi - lo) / Math.max(1, count);
	const magnitude = 10 ** Math.floor(Math.log10(rough));
	const residual = rough / magnitude;
	const step = (residual <= 1.5 ? 1 : residual <= 3 ? 2 : residual <= 7 ? 5 : 10) * magnitude;
	const start = Math.floor(lo / step) * step;
	const end = Math.ceil(hi / step) * step;
	const ticks: number[] = [];
	for (let value = start, guard = 0; value <= end + step / 2 && guard < 50; value += step, guard += 1) ticks.push(Math.round(value / step) * step);
	return { min: start, max: end, ticks };
}

/** Quais posições do eixo X recebem rótulo: `budget` espalhadas por igual, sempre com a primeira e a última. */
export function pickTickValues<T>(values: readonly T[], budget: number): T[] {
	if (values.length <= budget) return [...values];
	if (budget <= 1) return values.length ? [values[0]!] : [];
	const picked = new Set<number>();
	for (let i = 0; i < budget; i += 1) picked.add(Math.round((i * (values.length - 1)) / (budget - 1)));
	return [...picked].sort((a, b) => a - b).map((index) => values[index]!);
}

/** Quantos rótulos do eixo X cabem sem encostar: `slot` pt cada (texto mais folga). */
export function labelBudget(plotWidth: number, slot: number, max = 6): number {
	return Math.max(2, Math.min(max, Math.floor(plotWidth / Math.max(1, slot))));
}

/** Largura reservada por rótulo do eixo X: texto (~6,4 pt por caractere em 12 pt) mais folga entre vizinhos. */
export function xLabelSlot(labels: readonly string[]): number {
	const longest = Math.max(0, ...labels.map((label) => label.length));
	return Math.min(110, Math.max(48, Math.round(longest * 6.4 + 20)));
}

// ---------- Linha, área e composto ----------

export const SERIES_KEYS = ["s0", "s1", "s2", "s3", "s4", "s5"] as const;
export type SeriesKey = (typeof SERIES_KEYS)[number];

/** Linha de dados do gráfico cartesiano: `x` numérico (instante ou posição), uma coluna por série e `f` (previsão). */
export type ChartDatum = { x: number; f: number | null } & Record<SeriesKey, number | null>;

const emptyDatum = (x: number): ChartDatum => ({ x, f: null, s0: null, s1: null, s2: null, s3: null, s4: null, s5: null });

export type ChartRows = {
	rows: ChartDatum[];
	/** Rótulo de cada X (também dos períodos projetados), para o eixo e para o toque. */
	labelOf: (x: number) => string;
	titleOf: (x: number) => string;
	/** Quantos pontos são dados de verdade (o resto é previsão). */
	actual: number;
	/** Valores originais do spec por posição (nulo = sem dado), para o toque mostrar o número certo. */
	original: Array<Array<number | null>>;
};

/**
 * Linhas do gráfico de linha/área/composto. Datas viram instantes (espaçamento proporcional ao tempo); categorias viram
 * posições 0..n-1. Buracos (nulo) na linha e na área são interpolados entre vizinhos, como no web; no composto as barras
 * ficam sem valor. `forecast` acrescenta períodos futuros e a coluna `f` (tracejada, parte do último ponto real).
 */
export function buildChartRows(spec: ChartSpec): ChartRows {
	const labels = chartXLabels(spec);
	const isDate = spec.xKind === "date";
	const xs = spec.data.map((point, index) => (isDate ? parseChartDay(String(point[spec.x])) : index));
	const original = spec.data.map((point) => spec.series.map((item) => (typeof point[item.key] === "number" ? (point[item.key] as number) : null)));
	const rows = xs.map((x) => emptyDatum(x));
	spec.series.forEach((item, column) => {
		const key = SERIES_KEYS[column]!;
		const kind = spec.type === "composed" ? (item.kind ?? (column === 0 ? "bar" : "line")) : "line";
		const known = original.map((values, index) => (values[column] === null ? -1 : index)).filter((index) => index >= 0);
		rows.forEach((row, index) => {
			const own = original[index]![column]!;
			if (own !== null) {
				row[key] = own;
				return;
			}
			if (kind === "bar") return;
			const before = [...known].reverse().find((candidate) => candidate < index);
			const after = known.find((candidate) => candidate > index);
			const a = before === undefined ? undefined : original[before]![column]!;
			const b = after === undefined ? undefined : original[after]![column]!;
			if (a !== undefined && b !== undefined && before !== undefined && after !== undefined) row[key] = a + ((b - a) * (index - before)) / (after - before);
			else row[key] = a ?? b ?? 0;
		});
	});
	const projected = spec.forecast ? buildForecast(xs, original.map((values) => values[0]!), spec.forecast.points, labels.monthly) : null;
	const future = new Map<number, string>();
	if (projected && rows.length > 0) {
		const lastIndex = rows.length - 1;
		const lastValue = rows[lastIndex]!.s0;
		rows[lastIndex]!.f = lastValue;
		projected.xs.forEach((x, index) => {
			const row = emptyDatum(x);
			row.f = projected.ys[index]!;
			rows.push(row);
			future.set(x, labels.axisDate(x));
		});
	}
	const labelOf = (x: number) => (isDate ? labels.axisDate(x) : (spec.data[Math.round(x)]?.[spec.x] === undefined ? "" : String(spec.data[Math.round(x)]![spec.x])));
	const titleOf = (x: number) => (isDate ? (future.has(x) ? labels.axisDate(x) : labels.title(new Date(x).toISOString().slice(0, 10))) : labelOf(x));
	return { rows, labelOf, titleOf, actual: spec.data.length, original };
}

/** Soma `months` meses a um instante UTC (dia 1 de cada mês: previsão de série mensal anda mês a mês). */
function addMonthsUtc(ms: number, months: number): number {
	const date = new Date(ms);
	return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, date.getUTCDate());
}

/**
 * Projeção tracejada da primeira série: regressão linear sobre os pontos conhecidos, `points` períodos à frente. O passo
 * é o mês (série mensal) ou a mediana dos intervalos; sem dois pontos conhecidos não há projeção.
 */
export function buildForecast(xs: readonly number[], ys: ReadonlyArray<number | null>, points: number, monthly: boolean): { xs: number[]; ys: number[] } {
	const known = xs.flatMap((x, index) => (typeof ys[index] === "number" ? [{ x, y: ys[index] as number }] : []));
	if (known.length < 2 || points < 1) return { xs: [], ys: [] };
	const meanX = known.reduce((sum, p) => sum + p.x, 0) / known.length;
	const meanY = known.reduce((sum, p) => sum + p.y, 0) / known.length;
	const variance = known.reduce((sum, p) => sum + (p.x - meanX) ** 2, 0);
	const slope = variance === 0 ? 0 : known.reduce((sum, p) => sum + (p.x - meanX) * (p.y - meanY), 0) / variance;
	const intercept = meanY - slope * meanX;
	const gaps = xs.slice(1).map((x, index) => x - xs[index]!).sort((a, b) => a - b);
	const step = gaps.length ? gaps[Math.floor(gaps.length / 2)]! : 1;
	const last = xs[xs.length - 1]!;
	const outX: number[] = [];
	for (let i = 1; i <= points; i += 1) outX.push(monthly ? addMonthsUtc(last, i) : last + step * i);
	return { xs: outX, ys: outX.map((x) => slope * x + intercept) };
}

/**
 * Extremos de todas as séries, da previsão e da meta (empilhado soma por linha). Área e barras têm o zero como base;
 * a linha pura usa só a faixa dos dados (senão uma série de 1.000 a 1.100 viraria uma reta colada no topo).
 */
export function chartExtent(spec: ChartSpec, rows: readonly ChartDatum[]): { min: number; max: number } {
	const zeroBased = spec.type !== "line";
	let min = zeroBased ? 0 : Number.POSITIVE_INFINITY;
	let max = zeroBased ? 0 : Number.NEGATIVE_INFINITY;
	for (const row of rows) {
		let stack = 0;
		for (let i = 0; i < spec.series.length; i += 1) {
			const value = row[SERIES_KEYS[i]!];
			if (value === null) continue;
			stack += value;
			min = Math.min(min, value);
			max = Math.max(max, spec.stacked ? stack : value);
		}
		if (row.f !== null) {
			min = Math.min(min, row.f);
			max = Math.max(max, row.f);
		}
	}
	if (spec.reference) {
		for (const value of [spec.reference.from, spec.reference.to]) {
			if (value === undefined) continue;
			min = Math.min(min, value);
			max = Math.max(max, value);
		}
	}
	return Number.isFinite(min) && Number.isFinite(max) ? { min, max } : { min: 0, max: 1 };
}

// ---------- Barras ----------

/** Barras ficam na vertical enquanto os rótulos couberem (ou puderem ser afinados); nomes longos e numerosos deitam. */
export function shouldUseHorizontalBars(labels: readonly string[], plotInnerWidth: number): boolean {
	const longest = Math.max(0, ...labels.map((label) => label.length));
	if (labels.length * (longest * 6.4 + 10) <= plotInnerWidth) return false;
	return longest > 9 || labels.length > 40;
}

/** Teto de altura do gráfico de barras deitadas: acima disso o Canvas passa do limite de textura da GPU (branco ou crash no Android). */
export const BAR_MAX_HEIGHT = 1200;
/** Acima disto de categorias as barras não deitam: ficam na vertical com rótulos afinados (a altura estouraria o teto). */
export const BAR_MAX_HORIZONTAL_ROWS = 60;

/**
 * Orientação, altura e quantos rótulos de categoria cabem no gráfico de barras. Deitada só até 60 categorias (mesmo com
 * `orientation: "horizontal"` no spec), com a altura limitada a 1200 pt; a vertical tem 240 pt e rótulos afinados.
 */
export function barLayout(input: { labels: readonly string[]; seriesCount: number; orientation?: "vertical" | "horizontal"; plotWidth: number }): { horizontal: boolean; height: number; rowLabels: number } {
	const rows = input.labels.length;
	const wanted = input.orientation === "horizontal" || (input.orientation === undefined && shouldUseHorizontalBars(input.labels, input.plotWidth));
	const horizontal = wanted && rows <= BAR_MAX_HORIZONTAL_ROWS;
	if (!horizontal) return { horizontal, height: 240, rowLabels: Math.max(2, Math.min(12, Math.floor(input.plotWidth / Math.max(1, xLabelSlot(input.labels))))) };
	const perGroup = input.seriesCount > 1 ? 14 * input.seriesCount + 14 : 34;
	const height = Math.min(BAR_MAX_HEIGHT, Math.max(200, rows * perGroup + 36));
	return { horizontal, height, rowLabels: Math.max(2, Math.floor((height - 34) / 22)) };
}

export type BarRows = { rows: Array<{ x: number } & Record<SeriesKey, number>>; labels: string[]; titles: string[] };

/** Linhas do gráfico de barras: posição 0..n-1, valor ausente vira 0 (como no web); `labels` é o texto do eixo. */
export function buildBarRows(spec: ChartSpec): BarRows {
	const labels = chartXLabels(spec);
	const rows = spec.data.map((point, index) => {
		const row = { x: index, s0: 0, s1: 0, s2: 0, s3: 0, s4: 0, s5: 0 } as { x: number } & Record<SeriesKey, number>;
		spec.series.forEach((item, column) => {
			row[SERIES_KEYS[column]!] = typeof point[item.key] === "number" ? (point[item.key] as number) : 0;
		});
		return row;
	});
	return { rows, labels: spec.data.map((point) => labels.axis(point[spec.x] as string | number)), titles: spec.data.map((point) => labels.title(point[spec.x] as string | number)) };
}

// ---------- Rosca ----------

export type PieSliceInfo = { label: string; value: number; color: string; percent: number; percentText: string; valueText: string };

/** Fatia além da sexta repete a cor misturada ao fundo, para continuar distinta (como `sliceColor` do web). */
export function sliceColor(colors: ChartColors, index: number, background: string): string {
	const base = seriesColor(colors, index);
	return index < 6 ? base : mixHex(base, background, 0.55);
}

/** Fatias da rosca: só valores positivos; `percent` (0 a 100) e os textos já formatados (porcentagem some se o valor já for %). */
export function pieSlices(spec: ChartSpec, colors: ChartColors, background: string): PieSliceInfo[] {
	const valueKey = spec.series[0]!.key;
	const positive = spec.data
		.map((point) => ({ label: String(point[spec.x]), value: typeof point[valueKey] === "number" ? (point[valueKey] as number) : 0 }))
		.filter((slice) => slice.value > 0);
	const total = positive.reduce((sum, slice) => sum + slice.value, 0);
	const format = chartValueFormatter(spec, { whole: positive.every((slice) => Number.isInteger(slice.value)) });
	return positive.map((slice, index) => {
		const percent = total > 0 ? (slice.value / total) * 100 : 0;
		return { ...slice, color: sliceColor(colors, index, background), percent, percentText: `${formatDecimal(percent, 0, 1)}%`, valueText: format(slice.value) };
	});
}

/** Texto do miolo da rosca: o total (ou a fatia tocada); total comprido usa a forma compacta ("R$ 490,5 mil"). */
export function pieCenterText(spec: ChartSpec, slices: readonly PieSliceInfo[], hovered: number | null): { value: string; label: string } {
	const slice = hovered === null ? null : slices[hovered];
	const total = slices.reduce((sum, item) => sum + item.value, 0);
	const amount = slice ? slice.value : total;
	const full = chartValueFormatter(spec, { whole: slices.every((item) => Number.isInteger(item.value)) })(amount);
	const text = full.length > 10 ? chartValueFormatter({ ...spec, format: "compact" })(amount) : full;
	return { value: text, label: slice ? slice.label : spec.series[0]!.label };
}

/** A legenda mostra a porcentagem, a menos que o valor já seja uma porcentagem (aí seria repetir). */
export const pieShowsPercent = (spec: Pick<ChartSpec, "unit" | "format">): boolean => !(spec.unit === "%" || spec.format === "percent");

// ---------- Radar ----------

export type RadarGeometry = {
	/** Polígonos da grade (do centro para fora), um por nível. */
	grid: Array<Array<{ x: number; y: number }>>;
	/** Ponta de cada eixo. */
	axes: Array<{ x: number; y: number }>;
	labels: Array<{ x: number; y: number; text: string; align: "left" | "center" | "right" }>;
	/** Um polígono por série, em escala relativa ao maior valor. */
	areas: Array<Array<{ x: number; y: number }>>;
	peak: number;
};

/** Geometria do radar: eixos = linhas do spec (o primeiro aponta para cima), escala relativa ao maior valor. */
export function radarGeometry(spec: ChartSpec, size: number, labelRoom: number, levels = 4): RadarGeometry {
	const count = spec.data.length;
	const center = size / 2;
	const radius = Math.max(8, center - labelRoom);
	const peak = Math.max(1e-9, ...spec.data.flatMap((point) => spec.series.map((item) => (typeof point[item.key] === "number" ? Math.abs(point[item.key] as number) : 0))));
	const angleOf = (index: number) => -Math.PI / 2 + (index * 2 * Math.PI) / count;
	const at = (index: number, ratio: number) => ({ x: center + Math.cos(angleOf(index)) * radius * ratio, y: center + Math.sin(angleOf(index)) * radius * ratio });
	const grid = Array.from({ length: levels }, (_, level) => spec.data.map((_, index) => at(index, (level + 1) / levels)));
	const axes = spec.data.map((_, index) => at(index, 1));
	const labels = spec.data.map((point, index) => {
		const spot = at(index, 1.0);
		const cos = Math.cos(angleOf(index));
		const out = { x: center + Math.cos(angleOf(index)) * (radius + 10), y: center + Math.sin(angleOf(index)) * (radius + 10) };
		return { x: out.x, y: out.y + (spot.y > center + 1 ? 4 : spot.y < center - 1 ? -4 : 0), text: String(point[spec.x]), align: (Math.abs(cos) < 0.25 ? "center" : cos > 0 ? "left" : "right") as "left" | "center" | "right" };
	});
	const areas = spec.series.map((item) => spec.data.map((point, index) => at(index, (typeof point[item.key] === "number" ? Math.abs(point[item.key] as number) : 0) / peak)));
	return { grid, axes, labels, areas, peak };
}

// ---------- Funil ----------

export type FunnelStageGeometry = { label: string; value: number; valueText: string; percentText: string; top: number; height: number; topWidth: number; bottomWidth: number; opacity: number };

/** Funil vertical: cada etapa é um trapézio centrado cuja largura segue o valor (a primeira etapa = 100%). */
export function funnelGeometry(spec: ChartSpec, width: number, stageHeight: number, gap = 6): FunnelStageGeometry[] {
	const valueKey = spec.series[0]!.key;
	const values = spec.data.map((point) => (typeof point[valueKey] === "number" ? (point[valueKey] as number) : 0));
	const first = values[0] && values[0] > 0 ? values[0] : Math.max(1, ...values);
	const format = chartValueFormatter(spec);
	return spec.data.map((point, index) => {
		const value = values[index]!;
		const next = values[index + 1] ?? value;
		const share = Math.min(1, Math.max(0, value / first));
		return {
			label: String(point[spec.x]),
			value,
			valueText: format(value),
			percentText: `${formatDecimal(share * 100, 0, 0)}%`,
			top: index * (stageHeight + gap),
			height: stageHeight,
			topWidth: width * share,
			bottomWidth: width * Math.min(share, Math.min(1, Math.max(0, next / first))),
			opacity: Math.max(0.35, 1 - index * (0.55 / Math.max(1, values.length - 1))),
		};
	});
}

// ---------- Medidor ----------

export const GAUGE_NOTCHES = 40;
/** Arco do medidor do web: de 135° a 405° (270° no total, com a abertura embaixo). */
export const GAUGE_START = 135;
export const GAUGE_END = 405;

/** Valor do medidor: 0 a 1 (valor / max, `max` padrão 100). */
export function gaugeRatio(spec: ChartSpec): number {
	const raw = spec.data[0]?.[spec.series[0]!.key];
	const value = typeof raw === "number" ? raw : 0;
	const max = spec.max ?? 100;
	return Math.min(1, Math.max(0, value / max));
}

/** Entalhes do arco: `active` é quantos estão preenchidos; cada um tem o ângulo (graus) do seu centro. */
export function gaugeNotches(ratio: number, total = GAUGE_NOTCHES): Array<{ angle: number; active: boolean }> {
	const span = GAUGE_END - GAUGE_START;
	const slot = span / total;
	const active = Math.round(ratio * total);
	return Array.from({ length: total }, (_, index) => ({ angle: GAUGE_START + slot * index + slot / 2, active: index < active }));
}

/** Texto do centro do medidor: o valor no formato do gráfico (moeda sem centavos, "%" colado, outra unidade com espaço). */
export function gaugeText(spec: ChartSpec): string {
	const raw = spec.data[0]?.[spec.series[0]!.key];
	return chartValueFormatter(spec, { whole: true })(typeof raw === "number" ? raw : 0);
}

// ---------- Toque ----------

/** Linhas do cartão de valor ao tocar: uma por série, com a cor, o rótulo e o valor formatado ("—" sem dado). */
export function pressRows(spec: ChartSpec, colors: ChartColors, values: ReadonlyArray<number | null>): Array<{ color: string; label: string; value: string }> {
	const format = chartValueFormatter(spec);
	return spec.series.map((item, index) => ({ color: seriesColor(colors, index), label: item.label, value: typeof values[index] === "number" ? format(values[index] as number) : "—" }));
}

/** Índice do ponto real mais próximo de `x` (null se não houver pontos). */
export function nearestIndex(xs: readonly number[], x: number): number | null {
	let best: number | null = null;
	let distance = Number.POSITIVE_INFINITY;
	xs.forEach((candidate, index) => {
		const d = Math.abs(candidate - x);
		if (d < distance) {
			distance = d;
			best = index;
		}
	});
	return best;
}

/** Conteúdo do cartão ao tocar numa posição da linha/área/composto: título e uma linha por série (ou só a previsão). */
export function pressContent(spec: ChartSpec, colors: ChartColors, model: ChartRows, index: number): { title: string; rows: Array<{ color: string; label: string; value: string }> } | null {
	const row = model.rows[index];
	if (!row) return null;
	if (index >= model.actual) {
		return { title: model.titleOf(row.x), rows: [{ color: seriesColor(colors, 0), label: "Previsão", value: row.f === null ? "—" : chartValueFormatter(spec)(row.f) }] };
	}
	return { title: model.titleOf(row.x), rows: pressRows(spec, colors, model.original[index] ?? []) };
}

/**
 * Fatia sob o dedo: `dx`/`dy` em relação ao centro, `start` em graus (0 = 3 horas, sentido horário, como o Skia) e a rosca
 * entre `inner` e `outer`. Fora do anel, ou sem fatias, devolve null.
 */
export function pieSliceAt(values: readonly number[], dx: number, dy: number, start: number, inner: number, outer: number): number | null {
	const distance = Math.hypot(dx, dy);
	if (distance < inner - 6 || distance > outer + 6) return null;
	const total = values.reduce((sum, value) => sum + value, 0);
	if (!(total > 0)) return null;
	const angle = ((((Math.atan2(dy, dx) * 180) / Math.PI - start) % 360) + 360) % 360;
	let from = 0;
	for (const [index, value] of values.entries()) {
		const sweep = (value / total) * 360;
		if (angle >= from && angle < from + sweep) return index;
		from += sweep;
	}
	return values.length - 1;
}

const TYPE_NAME: Record<ChartSpec["type"], string> = { line: "linha", area: "área", composed: "combinado", bar: "barras", pie: "rosca", radar: "radar", funnel: "funil", gauge: "medidor" };

/**
 * Descrição do gráfico para o leitor de tela, que não enxerga o Skia: título, tipo, quantos pontos, o período (ou as
 * categorias) e, por série, o menor e o maior valor ("Receita: R$ 12.000 a R$ 24.800"). Texto curto, sem decorar.
 */
export function chartA11yLabel(spec: ChartSpec): string {
	const count = spec.data.length;
	const noun = spec.type === "radar" ? "eixos" : spec.type === "funnel" ? "etapas" : spec.type === "pie" ? "fatias" : spec.type === "gauge" ? "valor" : "pontos";
	const title = spec.title ? `${spec.title}. ` : "";
	const labels = chartXLabels(spec);
	const first = spec.data[0]?.[spec.x];
	const last = spec.data[count - 1]?.[spec.x];
	const range = count > 1 && first != null && last != null ? `, de ${labels.axis(first)} a ${labels.axis(last)}` : "";
	const format = chartValueFormatter(spec);
	const series = spec.series
		.map((item) => {
			const values = spec.data.map((point) => point[item.key]).filter((value): value is number => typeof value === "number");
			if (values.length === 0) return null;
			const min = Math.min(...values);
			const max = Math.max(...values);
			return min === max ? `${item.label}: ${format(min)}` : `${item.label}: ${format(min)} a ${format(max)}`;
		})
		.filter((text): text is string => text !== null);
	return `${title}Gráfico de ${TYPE_NAME[spec.type]}, ${count} ${noun}${range}. ${series.join("; ")}.`;
}

/** Desenhos que têm leitura própria por item (rosca, funil e medidor): o contêiner não pode agrupar e esconder os filhos. */
export const CHART_OWN_A11Y: ReadonlySet<ChartDrawing> = new Set<ChartDrawing>(["pie", "funnel", "gauge"]);

/** Tamanho de um desenho quadrado (radar, medidor): o desejado, sem passar da largura do cartão (nem ficar menor que 120 pt). */
export function fitSize(width: number, desired: number): number {
	return Math.max(120, Math.min(desired, Math.floor(width)));
}

/** Largura do rótulo lateral do radar e a folga que o desenho reserva para ele (rótulo + 10 pt de distância do eixo + margem). */
export const RADAR_LABEL_WIDTH = 60;
export const RADAR_LABEL_ROOM = RADAR_LABEL_WIDTH + 12;
