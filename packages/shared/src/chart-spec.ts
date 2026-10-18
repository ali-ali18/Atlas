/**
 * Especificação de gráfico nativo da conversa: um JSON pequeno e validado que o modelo escreve num bloco
 * ```chart ou num arquivo `/work/out/*.chart.json` do `run_code`, e que a UI desenha (linha, barras, área, pizza).
 *
 * ```json
 * { "type": "line", "title": "Vendas", "x": "mes", "series": [{ "key": "total", "label": "Total" }],
 *   "data": [{ "mes": "2025-01-01", "total": 1200 }], "unit": "BRL" }
 * ```
 */

export const CHART_TYPES = ["line", "bar", "area", "pie"] as const;
export type ChartType = (typeof CHART_TYPES)[number];

export const CHART_MAX_POINTS = 500;
export const CHART_MAX_SERIES = 6;
export const CHART_MAX_PIE_SLICES = 12;
export const CHART_MAX_JSON_CHARS = 120_000;
export const CHART_FORMATS = ["number", "compact", "percent"] as const;
export type ChartFormat = (typeof CHART_FORMATS)[number];

export type ChartSeries = { key: string; label: string };
export type ChartRow = Record<string, string | number | null>;

export type ChartSpec = {
	type: ChartType;
	title?: string;
	/** Campo do eixo X (ou o rótulo das fatias, na pizza). */
	x: string;
	series: ChartSeries[];
	data: ChartRow[];
	/** "BRL" | "USD" | "EUR" (moeda), "%" ou um texto curto (sufixo, ex.: "kg"). */
	unit?: string;
	format?: ChartFormat;
	/** Barras/áreas empilhadas (ignorado em linha e pizza). */
	stacked?: boolean;
	/** `date` quando todo valor de X é uma data ISO (AAAA-MM-DD[...]); senão `category`. */
	xKind: "date" | "category";
};

export type ChartSpecParse = { ok: true; spec: ChartSpec } | { ok: false; error: string };

const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;
const CURRENCIES = new Set(["BRL", "USD", "EUR"]);

export function isChartDateString(value: unknown): value is string {
	return typeof value === "string" && ISO_DATE.test(value) && !Number.isNaN(Date.parse(value));
}

function text(value: unknown, max: number): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed ? trimmed.slice(0, max) : undefined;
}

function fail(error: string): ChartSpecParse {
	return { ok: false, error };
}

/** Valida e normaliza a especificação (aceita o texto JSON ou o objeto já lido). */
export function parseChartSpec(input: unknown): ChartSpecParse {
	let raw = input;
	if (typeof input === "string") {
		if (input.length > CHART_MAX_JSON_CHARS) return fail(`chart spec too large (max ${CHART_MAX_JSON_CHARS} characters)`);
		try {
			raw = JSON.parse(input) as unknown;
		} catch {
			return fail("chart spec is not valid JSON");
		}
	}
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fail("chart spec must be a JSON object");
	const row = raw as Record<string, unknown>;

	const type = row.type;
	if (typeof type !== "string" || !(CHART_TYPES as readonly string[]).includes(type)) return fail(`type must be one of: ${CHART_TYPES.join(", ")}`);
	const x = text(row.x, 64);
	if (!x) return fail("x must be the name of the field used for the horizontal axis (or the slice labels in a pie)");

	if (!Array.isArray(row.series) || row.series.length === 0) return fail("series must be a non-empty array of { key, label? }");
	if (row.series.length > CHART_MAX_SERIES) return fail(`too many series (max ${CHART_MAX_SERIES})`);
	const series: ChartSeries[] = [];
	for (const entry of row.series) {
		const item = typeof entry === "string" ? { key: entry } : entry;
		if (!item || typeof item !== "object") return fail("each series must be { key, label? }");
		const key = text((item as Record<string, unknown>).key, 64);
		if (!key) return fail("each series needs a key (the field with the values)");
		if (key === x) return fail(`series key "${key}" cannot be the same field as x`);
		if (series.some((existing) => existing.key === key)) return fail(`duplicate series key "${key}"`);
		series.push({ key, label: text((item as Record<string, unknown>).label, 48) ?? key });
	}

	if (!Array.isArray(row.data) || row.data.length === 0) return fail("data must be a non-empty array of rows");
	const limit = type === "pie" ? CHART_MAX_PIE_SLICES : CHART_MAX_POINTS;
	if (row.data.length > limit) return fail(`too many ${type === "pie" ? "slices" : "points"} (max ${limit})`);
	const usedSeries = type === "pie" ? series.slice(0, 1) : series;
	const data: ChartRow[] = [];
	for (const [index, entry] of row.data.entries()) {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) return fail(`data[${index}] must be an object`);
		const source = entry as Record<string, unknown>;
		const xValue = source[x];
		if ((typeof xValue !== "string" && typeof xValue !== "number") || (typeof xValue === "number" && !Number.isFinite(xValue)) || xValue === "") {
			return fail(`data[${index}].${x} must be a non-empty string or number`);
		}
		const point: ChartRow = { [x]: typeof xValue === "string" ? xValue.slice(0, 80) : xValue };
		for (const item of usedSeries) {
			const value = source[item.key];
			if (value === undefined || value === null) {
				point[item.key] = null;
				continue;
			}
			if (typeof value !== "number" || !Number.isFinite(value)) return fail(`data[${index}].${item.key} must be a number or null`);
			if (type === "pie" && value < 0) return fail(`data[${index}].${item.key} cannot be negative in a pie chart`);
			point[item.key] = value;
		}
		data.push(point);
	}
	for (const item of usedSeries) {
		if (!data.some((point) => typeof point[item.key] === "number")) return fail(`series "${item.key}" has no numeric values in data`);
	}
	if (type === "pie" && !data.some((point) => (point[usedSeries[0]!.key] as number | null) !== null && (point[usedSeries[0]!.key] as number) > 0)) {
		return fail("a pie chart needs at least one positive value");
	}

	const xKind = type !== "pie" && data.every((point) => isChartDateString(point[x])) ? "date" : "category";
	const unitRaw = text(row.unit, 12);
	const unit = unitRaw && CURRENCIES.has(unitRaw.toUpperCase()) ? unitRaw.toUpperCase() : unitRaw;
	const format = typeof row.format === "string" && (CHART_FORMATS as readonly string[]).includes(row.format) ? (row.format as ChartFormat) : undefined;
	const title = text(row.title, 120);
	return {
		ok: true,
		spec: {
			type: type as ChartType,
			...(title ? { title } : {}),
			x,
			series: usedSeries,
			data,
			...(unit ? { unit } : {}),
			...(format ? { format } : {}),
			...(row.stacked === true && (type === "bar" || type === "area") ? { stacked: true } : {}),
			xKind,
		},
	};
}

const TYPE_NAME: Record<ChartType, string> = { line: "line", bar: "bar", area: "area", pie: "pie" };

/** Resumo curto da especificação para o `tool_result` (o modelo não precisa ver os pontos todos). */
export function summarizeChartSpec(spec: ChartSpec, filename?: string): string {
	const first = spec.data[0]?.[spec.x];
	const last = spec.data[spec.data.length - 1]?.[spec.x];
	const range = spec.data.length > 1 && first !== undefined && last !== undefined ? ` (${String(first)} to ${String(last)})` : "";
	const names = spec.series.map((item) => item.label).join(", ");
	const title = spec.title ? ` "${spec.title}"` : "";
	return `${filename ? `${filename}: ` : ""}${TYPE_NAME[spec.type]} chart${title}, ${spec.data.length} ${spec.type === "pie" ? "slices" : "points"}${range}, series: ${names}${spec.unit ? `, unit ${spec.unit}` : ""}`;
}

function csvCell(value: string | number | null | undefined): string {
	if (value === null || value === undefined) return "";
	if (typeof value === "number") return String(value).replace(".", ",");
	const needsQuotes = /[;"\n\r]/.test(value);
	const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
	return needsQuotes || safe !== value ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** CSV em pt-BR (separador `;`, vírgula decimal), pronto para abrir no Excel. Células com fórmula são neutralizadas. */
export function chartSpecToCsv(spec: ChartSpec): string {
	const header = [spec.x, ...spec.series.map((item) => item.label)].map(csvCell).join(";");
	const lines = spec.data.map((point) => [point[spec.x], ...spec.series.map((item) => point[item.key])].map(csvCell).join(";"));
	return [header, ...lines].join("\n");
}
