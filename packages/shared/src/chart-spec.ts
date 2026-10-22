/**
 * Especificação de gráfico nativo da conversa: um JSON pequeno e validado que o modelo escreve num bloco
 * ```chart ou num arquivo `/work/out/*.chart.json` do `run_code`, e que a UI desenha (linha, barras, área, pizza).
 *
 * ```json
 * { "type": "line", "title": "Vendas", "x": "mes", "series": [{ "key": "total", "label": "Total" }],
 *   "data": [{ "mes": "2025-01-01", "total": 1200 }], "unit": "BRL" }
 * ```
 */

export const CHART_TYPES = ["line", "bar", "area", "pie", "radar", "funnel", "gauge", "composed"] as const;
export type ChartType = (typeof CHART_TYPES)[number];

export const CHART_MAX_POINTS = 500;
export const CHART_MAX_SERIES = 6;
export const CHART_MAX_PIE_SLICES = 12;
/** Etapas do funil e eixos do radar. */
export const CHART_MAX_FUNNEL_STAGES = 12;
export const CHART_MIN_RADAR_AXES = 3;
export const CHART_MAX_RADAR_AXES = 12;
export const CHART_MAX_FORECAST_POINTS = 24;
/** Tipos que desenham um único valor por linha (a primeira série): fatias, etapas ou o ponteiro. */
const SINGLE_SERIES_TYPES: readonly string[] = ["pie", "funnel", "gauge"];
export const CHART_MAX_JSON_CHARS = 120_000;
export const CHART_FORMATS = ["number", "compact", "percent"] as const;
export type ChartFormat = (typeof CHART_FORMATS)[number];

/** Paletas prontas (cores definidas em `packages/ui`); sem `palette` vale o visual padrão do Atlas. */
export const CHART_PALETTES = ["primary", "monochrome", "ocean", "sunset", "grove", "vivid", "custom"] as const;
export type ChartPalette = (typeof CHART_PALETTES)[number];
export const CHART_CUSTOM_COLORS_MIN = 1;
export const CHART_CUSTOM_COLORS_MAX = 6;

const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/** `#abc` ou `#aabbcc` → `#aabbcc` em minúsculas; qualquer outra coisa → `undefined`. */
export function normalizeChartHexColor(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	if (!HEX_COLOR.test(trimmed)) return undefined;
	const hex = trimmed.slice(1).toLowerCase();
	return `#${hex.length === 3 ? [...hex].map((char) => char + char).join("") : hex}`;
}

export const CHART_SERIES_KINDS = ["bar", "line", "area"] as const;
export type ChartSeriesKind = (typeof CHART_SERIES_KINDS)[number];

/** `kind` só vale em `composed` (barras + linhas + áreas no mesmo eixo de datas). */
export type ChartSeries = { key: string; label: string; kind?: ChartSeriesKind };

/** Meta ou faixa de referência no eixo Y: faixa entre `from` e `to`; com um só limite, vai até a borda do gráfico. */
export type ChartReference = { from?: number; to?: number; label?: string };
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
	/** Meta/faixa de referência (linha, área, barras, composto). */
	reference?: ChartReference;
	/** Projeção tracejada da primeira série por tendência (linha/área com datas). */
	forecast?: { points: number };
	/** Fundo de escala do medidor (`gauge`); padrão 100. */
	max?: number;
	/** Paleta de cores; `custom` exige `colors`. Ausente = visual padrão. */
	palette?: ChartPalette;
	/** Cores hex (`#rrggbb`) da paleta `custom`, na ordem das séries/fatias. */
	colors?: string[];
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
		const kindRaw = (item as Record<string, unknown>).kind;
		if (kindRaw !== undefined && kindRaw !== null) {
			if (type !== "composed") return fail('series "kind" is only used with type "composed"');
			if (typeof kindRaw !== "string" || !(CHART_SERIES_KINDS as readonly string[]).includes(kindRaw)) {
				return fail(`series kind must be one of: ${CHART_SERIES_KINDS.join(", ")}`);
			}
		}
		series.push({
			key,
			label: text((item as Record<string, unknown>).label, 48) ?? key,
			...(kindRaw ? { kind: kindRaw as ChartSeriesKind } : {}),
		});
	}

	if (!Array.isArray(row.data) || row.data.length === 0) return fail("data must be a non-empty array of rows");
	const limit =
		type === "pie" ? CHART_MAX_PIE_SLICES : type === "funnel" ? CHART_MAX_FUNNEL_STAGES : type === "radar" ? CHART_MAX_RADAR_AXES : type === "gauge" ? 1 : CHART_MAX_POINTS;
	const noun = type === "pie" ? "slices" : type === "funnel" ? "stages" : type === "radar" ? "axes" : type === "gauge" ? "rows" : "points";
	if (row.data.length > limit) return fail(`too many ${noun} (max ${limit})${type === "gauge" ? ": a gauge shows a single value, send one row" : ""}`);
	if (type === "radar" && row.data.length < CHART_MIN_RADAR_AXES) return fail(`a radar chart needs at least ${CHART_MIN_RADAR_AXES} axes (rows in data)`);
	const usedSeries = SINGLE_SERIES_TYPES.includes(type) ? series.slice(0, 1) : series;
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
			if ((SINGLE_SERIES_TYPES.includes(type) || type === "radar") && value < 0) return fail(`data[${index}].${item.key} cannot be negative in a ${type} chart`);
			point[item.key] = value;
		}
		data.push(point);
	}
	for (const item of usedSeries) {
		if (!data.some((point) => typeof point[item.key] === "number")) return fail(`series "${item.key}" has no numeric values in data`);
	}
	if (SINGLE_SERIES_TYPES.includes(type) && !data.some((point) => (point[usedSeries[0]!.key] as number | null) !== null && (point[usedSeries[0]!.key] as number) > 0)) {
		return fail(`a ${type} chart needs at least one positive value`);
	}

	const xKind = !SINGLE_SERIES_TYPES.includes(type) && type !== "radar" && data.every((point) => isChartDateString(point[x])) ? "date" : "category";
	if (type === "composed" && xKind !== "date") return fail("a composed chart needs ISO dates (YYYY-MM-DD) in x; use bar or line for categories");
	const unitRaw = text(row.unit, 12);
	const unit = unitRaw && CURRENCIES.has(unitRaw.toUpperCase()) ? unitRaw.toUpperCase() : unitRaw;
	const format = typeof row.format === "string" && (CHART_FORMATS as readonly string[]).includes(row.format) ? (row.format as ChartFormat) : undefined;
	const title = text(row.title, 120);

	let max: number | undefined;
	if (row.max !== undefined && row.max !== null) {
		if (type !== "gauge") return fail('max is only used with type "gauge"');
		if (typeof row.max !== "number" || !Number.isFinite(row.max) || row.max <= 0) return fail("max must be a positive number (the full-scale value of the gauge)");
		max = row.max;
	}
	if (type === "gauge" && typeof data[0]?.[usedSeries[0]!.key] === "number" && (data[0]![usedSeries[0]!.key] as number) > (max ?? 100)) {
		return fail(`gauge value exceeds max (${max ?? 100}); set max to the full-scale value`);
	}

	let reference: ChartReference | undefined;
	if (row.reference !== undefined && row.reference !== null) {
		if (!["line", "area", "bar", "composed"].includes(type)) return fail("reference is only available for line, area, bar and composed charts");
		const ref = row.reference as Record<string, unknown>;
		if (typeof ref !== "object" || Array.isArray(ref)) return fail("reference must be { from?, to?, label? } with numbers in the unit of the y axis");
		const from = ref.from ?? undefined;
		const to = ref.to ?? undefined;
		if (from === undefined && to === undefined) return fail("reference needs from, to or both (e.g. a target: { from: 5000, label: \"Meta\" })");
		for (const [name, value] of [["from", from], ["to", to]] as const) {
			if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value))) return fail(`reference.${name} must be a number`);
		}
		if (typeof from === "number" && typeof to === "number" && from > to) return fail("reference.from must be less than or equal to reference.to");
		const label = text(ref.label, 40);
		reference = { ...(from !== undefined ? { from: from as number } : {}), ...(to !== undefined ? { to: to as number } : {}), ...(label ? { label } : {}) };
	}

	let forecast: { points: number } | undefined;
	if (row.forecast !== undefined && row.forecast !== null) {
		if (type !== "line" && type !== "area") return fail("forecast is only available for line and area charts");
		if (xKind !== "date") return fail("forecast needs ISO dates (YYYY-MM-DD) in x");
		if (data.length < 3) return fail("forecast needs at least 3 data points to fit a trend");
		const raw = (row.forecast as Record<string, unknown>)?.points;
		if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1 || raw > CHART_MAX_FORECAST_POINTS) {
			return fail(`forecast must be { points: n } with n an integer from 1 to ${CHART_MAX_FORECAST_POINTS} (future periods)`);
		}
		forecast = { points: raw };
	}

	let palette: ChartPalette | undefined;
	let colors: string[] | undefined;
	if (row.palette !== undefined && row.palette !== null) {
		if (typeof row.palette !== "string" || !(CHART_PALETTES as readonly string[]).includes(row.palette)) {
			return fail(`palette must be one of: ${CHART_PALETTES.join(", ")}`);
		}
		palette = row.palette as ChartPalette;
	}
	if (row.colors !== undefined && row.colors !== null) {
		if (!Array.isArray(row.colors) || row.colors.length < CHART_CUSTOM_COLORS_MIN || row.colors.length > CHART_CUSTOM_COLORS_MAX) {
			return fail(`colors must be an array of ${CHART_CUSTOM_COLORS_MIN} to ${CHART_CUSTOM_COLORS_MAX} hex colors like "#2563eb"`);
		}
		colors = [];
		for (const [index, color] of row.colors.entries()) {
			const normalized = normalizeChartHexColor(color);
			if (!normalized) return fail(`colors[${index}] must be a hex color like "#2563eb" (got ${JSON.stringify(String(color).slice(0, 20))})`);
			colors.push(normalized);
		}
		palette ??= "custom";
	}
	if (palette === "custom" && !colors) return fail('palette "custom" needs colors: an array of hex colors like ["#2563eb", "#f59e0b"]');
	if (palette !== "custom") colors = undefined;
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
			...(reference ? { reference } : {}),
			...(forecast ? { forecast } : {}),
			...(max !== undefined ? { max } : {}),
			...(palette ? { palette } : {}),
			...(colors ? { colors } : {}),
			...(row.stacked === true && (type === "bar" || type === "area") ? { stacked: true } : {}),
			xKind,
		},
	};
}

const TYPE_NAME: Record<ChartType, string> = { line: "line", bar: "bar", area: "area", pie: "pie", radar: "radar", funnel: "funnel", gauge: "gauge", composed: "composed" };

/** Resumo curto da especificação para o `tool_result` (o modelo não precisa ver os pontos todos). */
export function summarizeChartSpec(spec: ChartSpec, filename?: string): string {
	const first = spec.data[0]?.[spec.x];
	const last = spec.data[spec.data.length - 1]?.[spec.x];
	const range = spec.data.length > 1 && first !== undefined && last !== undefined ? ` (${String(first)} to ${String(last)})` : "";
	const names = spec.series.map((item) => item.label).join(", ");
	const title = spec.title ? ` "${spec.title}"` : "";
	return `${filename ? `${filename}: ` : ""}${TYPE_NAME[spec.type]} chart${title}, ${spec.data.length} ${spec.type === "pie" ? "slices" : spec.type === "funnel" ? "stages" : spec.type === "radar" ? "axes" : "points"}${range}, series: ${names}${spec.unit ? `, unit ${spec.unit}` : ""}`;
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
